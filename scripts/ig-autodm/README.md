# ig-autodm — local dev

Local Express webhook + cloudflared tunnel for testing changes before deploying to Cloudflare Workers. See the top-level [README.md](../../README.md) for full setup.

## How to start

```bash
npm run ig-autodm        # live
npm run ig-autodm:dry    # logs intended sends without calling Meta
```

The CLI prints the cloudflared quick-tunnel URL. Paste it into Meta App Dashboard
→ Webhooks if you want to test the handshake before deploying for real. The
tunnel URL changes every restart, which is why production lives on Workers
(permanent URL).

## Architecture

```
scripts/ig-autodm.mjs               entry — tunnel + server boot
scripts/ig-autodm/server.mjs        Express webhook (GET verify + POST handler)
scripts/ig-autodm/comment-handler.mjs   pure match logic (also Worker-portable)
scripts/ig-autodm/meta-api.mjs      Meta Graph API client
scripts/ig-autodm/notion-config.mjs Notion content-calendar queries
scripts/ig-autodm/tunnel.mjs        cloudflared spawner
scripts/ig-autodm/config.mjs        env loader
scripts/ig-autodm/dedupe-store.mjs  per-(media+user) dedupe (memory + KV impls)
scripts/ig-autodm/activity-log.mjs  Notion activity log writer
scripts/ig-autodm/catch-up.mjs      pure backfill function
scripts/ig-autodm/token-refresh.mjs Meta long-lived token refresher
```

## Tests

```bash
npm test
```
