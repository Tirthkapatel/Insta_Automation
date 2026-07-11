// scripts/ig-autodm/meta-api.mjs
// Thin Meta Graph API client for the auto-DM use case.

import { GRAPH_BASE } from './config.mjs';

async function metaFetch(pathAndQuery, { token, method = 'GET', body } = {}) {
  // Token via Authorization header instead of query string — keeps it out of
  // URL logs, proxies, and error stack traces.
  const url = `${GRAPH_BASE}${pathAndQuery}`;
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    throw new Error(`Meta API ${method} ${pathAndQuery} → ${res.status}: ${msg}`);
  }
  return json;
}

/** Get the most recently published media (post/reel) for the IG user. */
export async function getLatestMedia({ token, igUserId }) {
  const data = await metaFetch(
    `/${igUserId}/media?fields=id,caption,media_type,media_product_type,permalink,timestamp&limit=1`,
    { token }
  );
  return data.data?.[0] ?? null;
}

/** Get the last N media items. */
export async function getRecentMedia({ token, igUserId, limit = 10 }) {
  const data = await metaFetch(
    `/${igUserId}/media?fields=id,caption,media_type,media_product_type,permalink,timestamp&limit=${limit}`,
    { token }
  );
  return data.data ?? [];
}

/**
 * Send a public reply nested under a comment.
 * Uses POST /{ig-comment-id}/replies.
 */
export async function sendCommentReply({ token, commentId, message }) {
  return metaFetch(`/${commentId}/replies`, {
    token,
    method: 'POST',
    body: { message },
  });
}

/**
 * Send a Private Reply (DM) to the user who left a specific comment.
 * Uses POST /{ig-user-id}/messages with recipient.comment_id.
 * Sends a button template so the link renders with a title.
 */
export async function sendPrivateReply({ token, igUserId, commentId, message, linkUrl, linkTitle }) {
  const body = {
    recipient: { comment_id: commentId },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: message,
          buttons: [
            {
              type: 'web_url',
              url: linkUrl,
              title: (linkTitle || 'Open').slice(0, 20),
            },
          ],
        },
      },
    },
  };
  return metaFetch(`/${igUserId}/messages`, { token, method: 'POST', body });
}

/**
 * Fetch all comments on a given media. Returns the full author object so
 * catch-up can dedupe by user. Uses fields=id,text,timestamp,from.
 */
export async function getMediaComments({ token, mediaId, limit = 50 }) {
  const data = await metaFetch(
    `/${mediaId}/comments?fields=id,text,timestamp,from&limit=${limit}`,
    { token }
  );
  return data.data ?? [];
}

/** Subscribe the app to comment events for the IG user. */
export async function subscribeWebhook({ token, igUserId }) {
  return metaFetch(`/${igUserId}/subscribed_apps?subscribed_fields=comments`, {
    token,
    method: 'POST',
  });
}

/** Check current subscription status. */
export async function getSubscribedApps({ token, igUserId }) {
  return metaFetch(`/${igUserId}/subscribed_apps`, { token });
}
