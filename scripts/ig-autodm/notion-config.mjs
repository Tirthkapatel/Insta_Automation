// scripts/ig-autodm/notion-config.mjs
// Pull per-reel DM trigger config from the Content Calendar database.

import { NOTION_API } from './config.mjs';

const NOTION_VERSION = '2022-06-28';

function readText(prop) {
  if (!prop) return '';
  if (prop.type === 'rich_text') return prop.rich_text.map(t => t.plain_text).join('');
  if (prop.type === 'title') return prop.title.map(t => t.plain_text).join('');
  if (prop.type === 'url') return prop.url ?? '';
  if (prop.type === 'select') return prop.select?.name ?? '';
  return '';
}

export function parseNotionRow(row) {
  const p = row.properties;
  return {
    notion_page_id: row.id,
    ig_media_id: readText(p.ig_media_id),
    dm_trigger_keyword: readText(p.dm_trigger_keyword) || '*',
    dm_message_text: readText(p.dm_message_text),
    dm_link_url: readText(p.dm_link_url),
    dm_link_title: readText(p.dm_link_title),
    comment_reply_text: readText(p.comment_reply_text),
    dm_status: readText(p.dm_status) || 'inactive',
  };
}

/** Fetch all rows from the Content Calendar that have an ig_media_id set. */
export async function fetchAllConfigs({ apiKey, dbId }) {
  if (!dbId) throw new Error('fetchAllConfigs: dbId required (your NOTION_CONTENT_DB_ID)');
  const url = `${NOTION_API}/databases/${dbId}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: {
        property: 'ig_media_id',
        rich_text: { is_not_empty: true },
      },
      page_size: 100,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Notion query failed ${res.status}: ${t}`);
  }
  const data = await res.json();
  const rows = data.results.map(parseNotionRow);
  const map = {};
  for (const r of rows) {
    if (r.ig_media_id) map[r.ig_media_id] = r;
  }
  return map;
}
