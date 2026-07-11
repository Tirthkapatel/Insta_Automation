// scripts/ig-autodm/comment-handler.mjs
// Pure logic. Given a comment webhook payload + a map of media_id -> config row,
// return the list of intended API actions. No network, no env, no fs.
// This file must stay portable to Cloudflare Workers.

const PRIVATE_REPLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * Split a multi-line Notion text field into an array of trimmed non-empty lines.
 * Used so a single Notion field can hold N variations (one per line).
 */
function splitVariations(text) {
  if (!text) return [];
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/** Pick one variation at random. Tests can inject a deterministic random fn. */
function pickVariation(variations, random = Math.random) {
  if (variations.length === 0) return '';
  if (variations.length === 1) return variations[0];
  return variations[Math.floor(random() * variations.length)];
}

/**
 * @param {object} args
 * @param {object} args.comment - { id, media_id, from_id, from_username, text, created_at_unix }
 * @param {Record<string, object>} args.configByMediaId - keyed by ig_media_id
 * @param {string} args.selfIgUserId - the page's own IG user id (to skip self-comments)
 * @param {string} [args.selfIgUsername] - the page's own IG username (belt-and-suspenders self-skip)
 * @param {number} [args.nowUnix] - inject for testability
 * @returns {Array<{type:'send_comment_reply'|'send_private_reply', ...}>}
 */
export function planActions({ comment, configByMediaId, selfIgUserId, selfIgUsername, nowUnix, random }) {
  const now = nowUnix ?? Math.floor(Date.now() / 1000);

  if (!comment || !comment.media_id) return [];

  // SELF-COMMENT GUARD (loop prevention).
  // Meta sometimes omits `from.id` for comments by the page owner; rely on
  // multiple signals so we never reply to our own replies.
  if (comment.from_id && comment.from_id === selfIgUserId) return [];
  if (selfIgUsername && comment.from_username &&
      comment.from_username.toLowerCase() === selfIgUsername.toLowerCase()) return [];
  if (!comment.from_id && !comment.from_username) return []; // unidentified sender = treat as untrusted/self

  const cfg = configByMediaId[comment.media_id];
  if (!cfg) return [];
  if (cfg.dm_status !== 'active') return [];

  const replyVariations = splitVariations(cfg.comment_reply_text);
  const dmVariations = splitVariations(cfg.dm_message_text);

  // Loop guard: never react to a comment whose text matches ANY of our reply variations.
  if (comment.text) {
    const t = comment.text.trim();
    if (replyVariations.some(v => v === t)) return [];
  }

  // 7-day Private Replies window
  if (now - comment.created_at_unix > PRIVATE_REPLY_WINDOW_SECONDS) return [];

  // Keyword match
  const trigger = (cfg.dm_trigger_keyword || '').trim();
  if (trigger !== '*') {
    const haystack = (comment.text || '').toLowerCase();
    const needle = trigger.toLowerCase();
    if (!needle || !haystack.includes(needle)) return [];
  }

  const actions = [];

  if (replyVariations.length > 0) {
    actions.push({
      type: 'send_comment_reply',
      to_comment_id: comment.id,
      text: pickVariation(replyVariations, random),
    });
  }

  actions.push({
    type: 'send_private_reply',
    to_comment_id: comment.id,
    message: pickVariation(dmVariations, random) || cfg.dm_message_text || '',
    link_url: cfg.dm_link_url,
    link_title: cfg.dm_link_title,
  });

  return actions;
}
