// scripts/ig-autodm/server.mjs
// Webhook server. Receives Meta comment events, fetches Notion config,
// dispatches actions via meta-api.

import express from 'express';
import { planActions } from './comment-handler.mjs';
import { fetchAllConfigs } from './notion-config.mjs';
import { sendCommentReply, sendPrivateReply } from './meta-api.mjs';
import { createMemoryDedupe, dedupeKey, DEDUPE_TTL_SECONDS } from './dedupe-store.mjs';
import { verifyMetaSignature } from './signature.mjs';

function safePreview(text, max = 30) {
  const s = String(text || '');
  return JSON.stringify(s.length > max ? s.slice(0, max) + '…' : s);
}

export function createServer({ cfg, options = {} }) {
  const { dryRun = false, configCacheMs = 60_000, dedupe = createMemoryDedupe() } = options;
  const app = express();
  // Preserve the raw body so we can verify Meta's HMAC signature against it.
  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));

  let configCache = {};
  let lastFetch = 0;
  async function refreshConfigs() {
    configCache = await fetchAllConfigs({ apiKey: cfg.NOTION_API_KEY, dbId: cfg.NOTION_CONTENT_DB_ID });
    lastFetch = Date.now();
    console.log(`[ig-autodm] loaded ${Object.keys(configCache).length} config row(s) with ig_media_id from Notion`);
    return configCache;
  }

  async function ensureFresh() {
    if (Date.now() - lastFetch > configCacheMs) await refreshConfigs();
    return configCache;
  }

  // --- GET /webhook: Meta's verify handshake
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === cfg.META_WEBHOOK_VERIFY_TOKEN) {
      console.log('[ig-autodm] webhook verified by Meta');
      return res.status(200).send(challenge);
    }
    console.warn('[ig-autodm] webhook verify rejected (mode or token mismatch)');
    return res.sendStatus(403);
  });

  // --- POST /webhook: comment events
  app.post('/webhook', async (req, res) => {
    // Verify Meta's HMAC signature against the raw body. Reject anything
    // that doesn't have a valid signature (forged or replayed).
    const sigHeader = req.headers['x-hub-signature-256'];
    const signedOk = await verifyMetaSignature(req.rawBody, sigHeader, cfg.META_APP_SECRET);
    if (!signedOk) {
      console.warn('[ig-autodm] webhook POST rejected: invalid or missing X-Hub-Signature-256');
      return res.sendStatus(403);
    }

    // ACK first — Meta retries aggressively if you delay.
    res.sendStatus(200);

    try {
      const configMap = await ensureFresh();
      for (const entry of req.body?.entry ?? []) {
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
          console.log(`[ig-autodm] comment=${comment.id} media=${comment.media_id} from=@${comment.from_username} text_len=${(comment.text || '').length} text=${safePreview(comment.text)}`);

          const actions = planActions({
            comment,
            configByMediaId: configMap,
            selfIgUserId: cfg.META_IG_USER_ID,
            selfIgUsername: cfg.META_IG_USERNAME,
          });

          if (actions.length === 0) {
            console.log(`[ig-autodm]   → no actions (no matching config or filtered out)`);
            continue;
          }

          // Per-(media+user) dedupe: same commenter only triggers once per reel.
          const dk = dedupeKey({
            mediaId: comment.media_id,
            fromId: comment.from_id,
            fromUsername: comment.from_username,
          });
          if (dk && (await dedupe.has(dk))) {
            console.log(`[ig-autodm]   → already DMed @${comment.from_username} for this media; skipping`);
            continue;
          }

          for (const action of actions) {
            if (dryRun) {
              console.log(`[ig-autodm][DRY] would ${action.type}:`, JSON.stringify(action));
              continue;
            }
            try {
              if (action.type === 'send_comment_reply') {
                await sendCommentReply({
                  token: cfg.META_LONG_TOKEN,
                  commentId: action.to_comment_id,
                  message: action.text,
                });
                console.log(`[ig-autodm]   ✓ public reply sent on ${action.to_comment_id}`);
              } else if (action.type === 'send_private_reply') {
                await sendPrivateReply({
                  token: cfg.META_LONG_TOKEN,
                  igUserId: cfg.META_IG_USER_ID,
                  commentId: action.to_comment_id,
                  message: action.message,
                  linkUrl: action.link_url,
                  linkTitle: action.link_title,
                });
                console.log(`[ig-autodm]   ✓ DM sent for comment ${action.to_comment_id}`);
              }
            } catch (err) {
              console.error(`[ig-autodm]   ✗ action failed:`, err.message);
            }
          }

          // Mark this (media, user) as DMed so subsequent comments are skipped.
          if (dk && !dryRun) await dedupe.set(dk, DEDUPE_TTL_SECONDS);
        }
      }
    } catch (err) {
      console.error('[ig-autodm] webhook handler error:', err);
    }
  });

  // --- GET / : health check
  app.get('/', (req, res) =>
    res.json({ ok: true, configCount: Object.keys(configCache).length, dryRun, lastFetchAgoMs: Date.now() - lastFetch })
  );

  return { app, refreshConfigs };
}
