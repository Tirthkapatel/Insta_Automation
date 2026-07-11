#!/usr/bin/env node
// scripts/ig-autodm-attach.mjs
//
// Link a recently-posted reel to its Notion Content Calendar row so the
// auto-DM trigger fires.
//
// Usage:
//   npm run ig-autodm:attach                                   # latest reel → unique pending row
//   npm run ig-autodm:attach -- --media=<media_id>             # specific media → unique pending row
//   npm run ig-autodm:attach -- --page=<notion_page_id>        # latest reel → specific Notion row
//   npm run ig-autodm:attach -- --media=<id> --page=<page_id>  # both explicit
//   npm run ig-autodm:attach -- --list                         # just list pending rows + recent media

import { loadConfig } from './ig-autodm/config.mjs';
import { getRecentMedia, getLatestMedia } from './ig-autodm/meta-api.mjs';
import { findPendingRows, setMediaIdOnPage } from './ig-autodm/attach.mjs';

const args = process.argv.slice(2);
function flag(name) {
  const f = args.find(a => a.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : null;
}
const wantList = args.includes('--list');
const mediaIdArg = flag('media');
const pageIdArg = flag('page');

async function main() {
  const cfg = await loadConfig();

  if (wantList) {
    const [recent, pending] = await Promise.all([
      getRecentMedia({ token: cfg.META_LONG_TOKEN, igUserId: cfg.META_IG_USER_ID, limit: 5 }),
      findPendingRows({ apiKey: cfg.NOTION_API_KEY, dbId: cfg.NOTION_CONTENT_DB_ID }),
    ]);
    console.log('\nRecent media (newest first):');
    for (const m of recent) {
      console.log(`  ${m.id}  (${m.media_product_type || m.media_type})  ${m.permalink}`);
      console.log(`    ${(m.caption || '').slice(0, 70).replace(/\n/g, ' ')}`);
    }
    console.log('\nPending Notion rows (dm_status=active, ig_media_id empty):');
    if (pending.length === 0) console.log('  (none)');
    for (const p of pending) {
      console.log(`  ${p.id}  ${p.title}`);
      console.log(`    edited ${p.last_edited}  ${p.url}`);
    }
    return;
  }

  // Resolve target media
  let mediaId = mediaIdArg;
  let mediaMeta = null;
  if (!mediaId) {
    mediaMeta = await getLatestMedia({ token: cfg.META_LONG_TOKEN, igUserId: cfg.META_IG_USER_ID });
    if (!mediaMeta) throw new Error('No media found on the Instagram account.');
    mediaId = mediaMeta.id;
  }

  // Resolve target Notion page
  let pageId = pageIdArg;
  if (!pageId) {
    const pending = await findPendingRows({ apiKey: cfg.NOTION_API_KEY, dbId: cfg.NOTION_CONTENT_DB_ID });
    if (pending.length === 0) {
      console.error('❌ No pending Notion rows. Create a Content Calendar row with dm_status=active and ig_media_id blank, then re-run.');
      process.exit(2);
    }
    if (pending.length > 1) {
      console.error(`❌ Multiple pending rows (${pending.length}). Disambiguate with --page=<id>:`);
      for (const p of pending) console.error(`   ${p.id}  ${p.title}  (edited ${p.last_edited})`);
      process.exit(2);
    }
    pageId = pending[0].id;
  }

  console.log(`\nAttaching:`);
  console.log(`  media_id:       ${mediaId}`);
  if (mediaMeta) {
    console.log(`  media type:     ${mediaMeta.media_product_type || mediaMeta.media_type}`);
    console.log(`  permalink:      ${mediaMeta.permalink}`);
    console.log(`  caption:        ${(mediaMeta.caption || '').slice(0, 80)}…`);
  }
  console.log(`  notion page id: ${pageId}`);
  console.log('');

  await setMediaIdOnPage({ apiKey: cfg.NOTION_API_KEY, pageId, mediaId });
  console.log(`✅ Linked. The running server will pick this up within 60s (or restart for immediate effect).`);
}

main().catch(err => {
  console.error('ig-autodm:attach failed:', err.message);
  process.exit(1);
});
