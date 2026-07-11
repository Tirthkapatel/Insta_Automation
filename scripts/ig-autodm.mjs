#!/usr/bin/env node
// scripts/ig-autodm.mjs
//
// Local-dev auto-DM-on-comment server. Production runs on Cloudflare
// Workers (see workers/ig-autodm/). Use this for testing changes before deploy.
//
// Usage:
//   npm run ig-autodm                 # live mode
//   npm run ig-autodm:dry             # dry-run (logs intended sends, doesn't call Meta)
//
// On startup:
//   1. Loads env from .env
//   2. Starts local Express server on IG_AUTODM_PORT (default 8787)
//   3. Opens a Cloudflare quick tunnel and prints the public URL
//   4. Fetches latest IG media and prints whether a Notion config row exists for it
//   5. Listens until ctrl+C

import { loadConfig } from './ig-autodm/config.mjs';
import { createServer } from './ig-autodm/server.mjs';
import { startTunnel } from './ig-autodm/tunnel.mjs';
import { getLatestMedia } from './ig-autodm/meta-api.mjs';
import { ensureTokenFresh } from './ig-autodm/token-refresh.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noTunnel = args.includes('--no-tunnel');

async function main() {
  const cfg = await loadConfig();
  console.log(`[ig-autodm] starting (${dryRun ? 'DRY-RUN' : 'LIVE'})`);

  // Refresh token if it's 1-50 days old (silent if too fresh or too stale).
  const refreshedToken = await ensureTokenFresh({
    envFile: cfg.ENV_FILE,
    currentToken: cfg.META_LONG_TOKEN,
    issuedAt: cfg.META_TOKEN_ISSUED_AT,
  });
  cfg.META_LONG_TOKEN = refreshedToken;

  const { app, refreshConfigs } = createServer({ cfg, options: { dryRun } });
  const configMap = await refreshConfigs();

  const httpServer = app.listen(cfg.PORT, () => {
    console.log(`[ig-autodm] server listening on http://localhost:${cfg.PORT}`);
  });

  let tunnelProc = null;
  if (!noTunnel) {
    console.log('[ig-autodm] opening Cloudflare tunnel…');
    const tunnel = await startTunnel({ port: cfg.PORT });
    const webhookUrl = `${tunnel.url}/webhook`;
    tunnelProc = tunnel.proc;
    console.log('');
    console.log('=========================================================');
    console.log(' WEBHOOK URL (paste into Meta App webhook settings):');
    console.log(`   ${webhookUrl}`);
    console.log(' VERIFY TOKEN:');
    console.log(`   ${cfg.META_WEBHOOK_VERIFY_TOKEN}`);
    console.log('=========================================================');
    console.log('');
  } else {
    console.log('[ig-autodm] --no-tunnel: skipping cloudflared (server is local-only)');
  }

  // Show latest media + whether it has a config
  try {
    const latest = await getLatestMedia({ token: cfg.META_LONG_TOKEN, igUserId: cfg.META_IG_USER_ID });
    if (latest) {
      const has = configMap[latest.id];
      console.log(`[ig-autodm] latest media: ${latest.id} (${latest.media_product_type || latest.media_type})`);
      console.log(`            permalink:    ${latest.permalink}`);
      console.log(`            caption:      ${(latest.caption || '').slice(0, 80)}${(latest.caption || '').length > 80 ? '…' : ''}`);
      if (has) {
        console.log(`            ✅ Notion config FOUND (trigger="${has.dm_trigger_keyword}", status=${has.dm_status})`);
      } else {
        console.log(`            ⚠️  no Notion config row for this media_id yet.`);
        console.log(`            Add a row to Content Calendar with ig_media_id="${latest.id}" and dm_status="active".`);
      }
    }
  } catch (err) {
    console.warn('[ig-autodm] could not fetch latest media:', err.message);
  }

  // Periodically reload Notion configs
  const reloadEvery = 60_000;
  setInterval(() => {
    refreshConfigs().catch(err => console.error('[ig-autodm] reload error:', err.message));
  }, reloadEvery);

  // Graceful shutdown
  function shutdown() {
    console.log('\n[ig-autodm] shutting down…');
    if (tunnelProc) tunnelProc.kill();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[ig-autodm] fatal:', err);
  process.exit(1);
});
