// workers/ig-autodm/src/index.mjs
// Cloudflare Worker version of the auto-DM webhook.
//
// Reuses the SAME pure modules from the local server (../../scripts/ig-autodm/)
// — wrangler bundles them at deploy time. No code duplication.
//
// Env (set via `wrangler secret put`):
//   META_LONG_TOKEN, META_IG_USER_ID, META_IG_USERNAME,
//   META_WEBHOOK_VERIFY_TOKEN,
//   NOTION_API_KEY, NOTION_CONTENT_DB_ID, NOTION_ACTIVITY_LOG_DB_ID
// Bindings (set in wrangler.jsonc):
//   DEDUPE_KV — Cloudflare KV namespace for per-(media+user) dedupe

import { planActions } from '../../../scripts/ig-autodm/comment-handler.mjs';
import { fetchAllConfigs } from '../../../scripts/ig-autodm/notion-config.mjs';
import { sendCommentReply, sendPrivateReply, getMediaComments } from '../../../scripts/ig-autodm/meta-api.mjs';
import { createKvDedupe, dedupeKey, DEDUPE_TTL_SECONDS } from '../../../scripts/ig-autodm/dedupe-store.mjs';
import { runCatchUp } from '../../../scripts/ig-autodm/catch-up.mjs';
import { logActivity } from '../../../scripts/ig-autodm/activity-log.mjs';
import { verifyMetaSignature } from '../../../scripts/ig-autodm/signature.mjs';

/** Truncate text for cloud logs (Cloudflare observability persists these). */
function safePreview(text, max = 30) {
  const s = String(text || '');
  return JSON.stringify(s.length > max ? s.slice(0, max) + '…' : s);
}

// Isolate-scoped cache for Notion config. Survives across requests within
// the same Worker isolate (~minutes). Refreshes on cold start.
let CACHED_CONFIGS = null;
let CACHED_AT = 0;
const CACHE_TTL_MS = 60_000;

async function getConfigs(env) {
  if (CACHED_CONFIGS && Date.now() - CACHED_AT < CACHE_TTL_MS) return CACHED_CONFIGS;
  CACHED_CONFIGS = await fetchAllConfigs({ apiKey: env.NOTION_API_KEY, dbId: env.NOTION_CONTENT_DB_ID });
  CACHED_AT = Date.now();
  return CACHED_CONFIGS;
}

async function handleGet(req, env, url) {
  if (url.pathname === '/webhook') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === env.META_WEBHOOK_VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('forbidden', { status: 403 });
  }
  if (url.pathname === '/') {
    return Response.json({
      ok: true,
      configCount: CACHED_CONFIGS ? Object.keys(CACHED_CONFIGS).length : 'uncached',
      cachedAgoMs: CACHED_AT ? Date.now() - CACHED_AT : null,
    });
  }
  return new Response('not found', { status: 404 });
}

async function handlePost(req, env, ctx) {
  // Verify Meta's HMAC signature against the RAW body BEFORE parsing.
  // Reject forged/replay payloads. App secret must be set as a Worker secret.
  const rawBody = await req.text();
  const sigHeader = req.headers.get('x-hub-signature-256');
  const signedOk = await verifyMetaSignature(rawBody, sigHeader, env.META_APP_SECRET);
  if (!signedOk) {
    console.warn('[webhook] rejected: invalid or missing X-Hub-Signature-256');
    return new Response('forbidden', { status: 403 });
  }

  // ACK first then process asynchronously — Meta retries aggressively.
  let body;
  try { body = JSON.parse(rawBody); } catch { body = {}; }
  ctx.waitUntil((async () => {
    try {
      const configs = await getConfigs(env);
      const selfIgUsername = env.META_IG_USERNAME;

      for (const entry of body?.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (change.field !== 'comments') continue;
          const v = change.value || {};
          const comment = {
            id: v.id,
            media_id: v.media?.id,
            from_id: v.from?.id,
            from_username: v.from?.username,
            text: v.text || '',
            created_at_unix: Math.floor(Date.now() / 1000),
          };
          // Truncate comment text for the cloud log (Notion activity log keeps the full text).
          console.log(`comment=${comment.id} media=${comment.media_id} from=@${comment.from_username} text_len=${(comment.text || '').length} text=${safePreview(comment.text)}`);

          const actions = planActions({
            comment,
            configByMediaId: configs,
            selfIgUserId: env.META_IG_USER_ID,
            selfIgUsername,
          });

          if (actions.length === 0) continue;

          // Per-(media+user) dedupe via KV (skips if this user already got the DM for this reel).
          const dedupe = env.DEDUPE_KV ? createKvDedupe(env.DEDUPE_KV) : null;
          const dk = dedupeKey({
            mediaId: comment.media_id,
            fromId: comment.from_id,
            fromUsername: comment.from_username,
          });
          const logCtx = {
            apiKey: env.NOTION_API_KEY,
            dbId: env.NOTION_ACTIVITY_LOG_DB_ID,
            mediaId: comment.media_id,
            commentId: comment.id,
            commenter: comment.from_username || comment.from_id || '?',
            commentText: comment.text,
            source: 'webhook',
          };

          if (dedupe && dk && (await dedupe.has(dk))) {
            console.log(`  → already DMed @${comment.from_username} for this media, skipping`);
            ctx.waitUntil(logActivity({ ...logCtx, action: 'skipped_deduped' }));
            continue;
          }

          for (const action of actions) {
            try {
              if (action.type === 'send_comment_reply') {
                await sendCommentReply({
                  token: env.META_LONG_TOKEN,
                  commentId: action.to_comment_id,
                  message: action.text,
                });
                console.log(`  ✓ public reply sent on ${action.to_comment_id}`);
                ctx.waitUntil(logActivity({ ...logCtx, action: 'reply_sent' }));
              } else if (action.type === 'send_private_reply') {
                await sendPrivateReply({
                  token: env.META_LONG_TOKEN,
                  igUserId: env.META_IG_USER_ID,
                  commentId: action.to_comment_id,
                  message: action.message,
                  linkUrl: action.link_url,
                  linkTitle: action.link_title,
                });
                console.log(`  ✓ DM sent for ${action.to_comment_id}`);
                ctx.waitUntil(logActivity({ ...logCtx, action: 'dm_sent' }));
              }
            } catch (err) {
              console.error(`  ✗ ${action.type} failed:`, err.message);
              ctx.waitUntil(logActivity({ ...logCtx, action: 'failed', error: `${action.type}: ${err.message}` }));
            }
          }

          // Mark this (media, user) as DMed.
          if (dedupe && dk) await dedupe.set(dk, DEDUPE_TTL_SECONDS);
        }
      }
    } catch (err) {
      console.error('worker handler error:', err);
    }
  })());

  return new Response('OK', { status: 200 });
}

async function runScheduledCatchUp(env) {
  const configs = await fetchAllConfigs({ apiKey: env.NOTION_API_KEY });
  const dedupe = env.DEDUPE_KV ? createKvDedupe(env.DEDUPE_KV) : null;
  if (!dedupe) {
    console.warn('[catch-up] no DEDUPE_KV binding — skipping (would re-DM everyone)');
    return { skipped: 'no_kv' };
  }

  return runCatchUp({
    configByMediaId: configs,
    fetchComments: (mediaId) => getMediaComments({ token: env.META_LONG_TOKEN, mediaId, limit: 50 }),
    sendCommentReply: (commentId, message) =>
      sendCommentReply({ token: env.META_LONG_TOKEN, commentId, message }),
    sendPrivateReply: ({ commentId, message, linkUrl, linkTitle }) =>
      sendPrivateReply({
        token: env.META_LONG_TOKEN,
        igUserId: env.META_IG_USER_ID,
        commentId, message, linkUrl, linkTitle,
      }),
    dedupe,
    selfIgUserId: env.META_IG_USER_ID,
    selfIgUsername: env.META_IG_USERNAME,
    log: (msg) => console.log(msg),
    onActivity: (entry) => logActivity({
      apiKey: env.NOTION_API_KEY,
      dbId: env.NOTION_ACTIVITY_LOG_DB_ID,
      source: 'catch_up',
      ...entry,
    }).catch(err => console.warn('[activity-log] write err:', err.message)),
  });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Manual catch-up trigger (Bearer auth using the verify token).
    if (req.method === 'POST' && url.pathname === '/catch-up') {
      const auth = req.headers.get('authorization') || '';
      if (auth !== `Bearer ${env.META_WEBHOOK_VERIFY_TOKEN}`) {
        return new Response('unauthorized', { status: 401 });
      }
      const result = await runScheduledCatchUp(env);
      return Response.json(result);
    }

    if (req.method === 'GET') return handleGet(req, env, url);
    if (req.method === 'POST') return handlePost(req, env, ctx);
    return new Response('method not allowed', { status: 405 });
  },

  async scheduled(event, env, ctx) {
    console.log(`[scheduled] catch-up tick at ${new Date(event.scheduledTime).toISOString()}`);
    ctx.waitUntil(
      runScheduledCatchUp(env)
        .then(result => console.log('[scheduled] result:', JSON.stringify(result.stats || result)))
        .catch(err => console.error('[scheduled] failed:', err.message))
    );
  },
};
