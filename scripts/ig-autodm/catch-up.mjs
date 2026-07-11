// scripts/ig-autodm/catch-up.mjs
// Backfill DMs for comments Instagram's spam classifier dropped from webhooks.
//
// Pure function. No fs, no env, no Node-only APIs. Runs in Worker and Node.
// Caller injects the API + dedupe interfaces.

import { planActions } from './comment-handler.mjs';
import { dedupeKey, DEDUPE_TTL_SECONDS } from './dedupe-store.mjs';

const SEND_DELAY_MS = 800;     // small gap between API sends to look human
const MAX_SENDS_PER_RUN = 25;  // safety brake against any runaway loop

function commentToHandlerShape(c, mediaId) {
  const tsSec = c.timestamp ? Math.floor(new Date(c.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);
  return {
    id: c.id,
    media_id: mediaId,
    from_id: c.from?.id,
    from_username: c.from?.username,
    text: c.text || '',
    created_at_unix: tsSec,
  };
}

/**
 * Run catch-up across all media in configMap.
 *
 * @param {object} args
 * @param {Record<string, object>} args.configByMediaId - active Notion configs keyed by media_id
 * @param {(mediaId: string) => Promise<object[]>} args.fetchComments
 * @param {(commentId: string, message: string) => Promise<void>} args.sendCommentReply
 * @param {(opts: {commentId, message, linkUrl, linkTitle}) => Promise<void>} args.sendPrivateReply
 * @param {{has: Function, set: Function}} args.dedupe
 * @param {string} args.selfIgUserId
 * @param {string} [args.selfIgUsername]
 * @param {(msg: string) => void} [args.log]
 * @param {number} [args.nowUnix]
 * @returns {Promise<{stats: object, perMedia: Record<string, object>}>}
 */
export async function runCatchUp({
  configByMediaId,
  fetchComments,
  sendCommentReply,
  sendPrivateReply,
  dedupe,
  selfIgUserId,
  selfIgUsername,
  log = () => {},
  onActivity = () => {},
  nowUnix,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
}) {
  const now = nowUnix ?? Math.floor(Date.now() / 1000);
  const globalStats = { sent_dm: 0, sent_reply: 0, skipped_deduped: 0, skipped_no_match: 0, failed: 0, capped: false };
  const perMedia = {};
  let totalSends = 0;

  outer: for (const [mediaId, cfg] of Object.entries(configByMediaId)) {
    if (cfg.dm_status !== 'active') continue;
    const mediaStats = { fetched: 0, sent_dm: 0, sent_reply: 0, skipped_deduped: 0, skipped_no_match: 0, failed: 0 };
    perMedia[mediaId] = mediaStats;

    let comments;
    try {
      comments = await fetchComments(mediaId);
    } catch (err) {
      log(`[catch-up] fetch failed for ${mediaId}: ${err.message}`);
      continue;
    }
    mediaStats.fetched = comments.length;

    for (const raw of comments) {

      const comment = commentToHandlerShape(raw, mediaId);

      // Reuse the webhook handler's matching logic (self-skip, trigger match, etc.)
      const actions = planActions({
        comment,
        configByMediaId: { [mediaId]: cfg },
        selfIgUserId,
        selfIgUsername,
        nowUnix: now,
      });

      if (actions.length === 0) {
        mediaStats.skipped_no_match++;
        globalStats.skipped_no_match++;
        continue;
      }

      // Dedupe by (media, user).
      const dk = dedupeKey({
        mediaId,
        fromId: comment.from_id,
        fromUsername: comment.from_username,
      });
      const logCtx = {
        mediaId,
        commentId: comment.id,
        commenter: comment.from_username || comment.from_id || '?',
        commentText: comment.text,
      };

      if (dk && await dedupe.has(dk)) {
        mediaStats.skipped_deduped++;
        globalStats.skipped_deduped++;
        await onActivity({ ...logCtx, action: 'skipped_deduped' });
        continue;
      }

      for (const action of actions) {
        if (totalSends >= MAX_SENDS_PER_RUN) {
          globalStats.capped = true;
          log(`[catch-up] safety cap of ${MAX_SENDS_PER_RUN} reached, stopping`);
          break outer;
        }
        try {
          if (action.type === 'send_comment_reply') {
            await sendCommentReply(action.to_comment_id, action.text);
            mediaStats.sent_reply++;
            globalStats.sent_reply++;
            await onActivity({ ...logCtx, action: 'reply_sent' });
          } else if (action.type === 'send_private_reply') {
            await sendPrivateReply({
              commentId: action.to_comment_id,
              message: action.message,
              linkUrl: action.link_url,
              linkTitle: action.link_title,
            });
            mediaStats.sent_dm++;
            globalStats.sent_dm++;
            await onActivity({ ...logCtx, action: 'dm_sent' });
          }
          totalSends++;
          log(`[catch-up] ✓ ${action.type} @${comment.from_username} on comment=${comment.id}`);
        } catch (err) {
          mediaStats.failed++;
          globalStats.failed++;
          await onActivity({ ...logCtx, action: 'failed', error: `${action.type}: ${err.message}` });
          log(`[catch-up] ✗ ${action.type} failed for comment=${comment.id}: ${err.message}`);
        }
        await sleep(SEND_DELAY_MS);
      }

      if (dk) await dedupe.set(dk, DEDUPE_TTL_SECONDS);
    }
  }

  return { stats: globalStats, perMedia };
}
