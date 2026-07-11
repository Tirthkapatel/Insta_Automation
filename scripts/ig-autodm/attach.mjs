// scripts/ig-autodm/attach.mjs
// Logic for linking your latest IG reel to a Notion Content Calendar row.
//
// Workflow: in Notion, prep a row with dm_status=active and ig_media_id blank.
// Post the reel on Instagram. Then run attach-latest — this fills in the
// ig_media_id field automatically so the DM trigger goes live.

import { NOTION_API } from './config.mjs';

const NOTION_VERSION = '2022-06-28';

/** Find all Content Calendar rows with dm_status=active AND ig_media_id empty. */
export async function findPendingRows({ apiKey, dbId }) {
  if (!dbId) throw new Error('findPendingRows: dbId required (your NOTION_CONTENT_DB_ID)');
  const res = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: {
        and: [
          { property: 'dm_status', select: { equals: 'active' } },
          { property: 'ig_media_id', rich_text: { is_empty: true } },
        ],
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: 25,
    }),
  });
  if (!res.ok) throw new Error(`Notion query failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.results.map(r => ({
    id: r.id,
    title: r.properties?.Title?.title?.map(t => t.plain_text).join('') || '(untitled)',
    last_edited: r.last_edited_time,
    url: r.url,
  }));
}

/** Set ig_media_id on a specific Notion page. */
export async function setMediaIdOnPage({ apiKey, pageId, mediaId }) {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        ig_media_id: { rich_text: [{ text: { content: mediaId } }] },
      },
    }),
  });
  if (!res.ok) throw new Error(`Notion update failed ${res.status}: ${await res.text()}`);
  return res.json();
}
