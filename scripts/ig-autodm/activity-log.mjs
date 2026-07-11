// scripts/ig-autodm/activity-log.mjs
// Writes a row to the "DM Activity Log" Notion database for each meaningful
// event (dm_sent, reply_sent, skipped_deduped, skipped_no_match, failed).
//
// Fire-and-forget: errors are swallowed so logging never blocks the main flow.
// Worker callers should still pass the returned promise to ctx.waitUntil so
// it completes before the isolate is freed.

import { NOTION_API } from './config.mjs';

const NOTION_VERSION = '2022-06-28';

/**
 * @param {object} args
 * @param {string} args.apiKey - Notion integration token
 * @param {string} args.dbId - the activity log database id (your NOTION_ACTIVITY_LOG_DB_ID)
 * @param {'dm_sent'|'reply_sent'|'skipped_deduped'|'skipped_no_match'|'failed'} args.action
 * @param {string} args.mediaId
 * @param {string} args.commentId
 * @param {string} args.commenter   - IG username
 * @param {string} args.commentText
 * @param {string} [args.error]
 * @param {'webhook'|'catch_up'} args.source
 * @returns {Promise<void>}
 */
export async function logActivity({
  apiKey,
  dbId,
  action,
  mediaId,
  commentId,
  commenter,
  commentText,
  error,
  source,
}) {
  if (!apiKey || !dbId) return; // silently skip if no key/db (e.g. test envs)
  const now = new Date();
  const title = `${now.toISOString().slice(11,19)} ${action} @${commenter || '?'}`;
  const body = {
    parent: { database_id: dbId },
    properties: {
      Title:        { title: [{ text: { content: title.slice(0, 100) } }] },
      timestamp:    { date: { start: now.toISOString() } },
      media_id:     { rich_text: [{ text: { content: String(mediaId || '') } }] },
      comment_id:   { rich_text: [{ text: { content: String(commentId || '') } }] },
      commenter:    { rich_text: [{ text: { content: String(commenter || '') } }] },
      comment_text: { rich_text: [{ text: { content: String(commentText || '').slice(0, 1900) } }] },
      action:       { select: { name: action } },
      source:       { select: { name: source } },
    },
  };
  if (error) {
    body.properties.error = { rich_text: [{ text: { content: String(error).slice(0, 1900) } }] };
  }
  try {
    const res = await fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      console.warn(`[activity-log] Notion ${res.status}:`, t.slice(0, 200));
    }
  } catch (err) {
    console.warn(`[activity-log] write failed:`, err.message);
  }
}
