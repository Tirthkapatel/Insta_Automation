# ig-autodm — Cloudflare Worker

Production deployment of the auto-DM webhook. Reuses the pure modules from
`../../scripts/ig-autodm/` — wrangler bundles them at deploy time, no code
duplication.

After deploying, you get a **permanent URL** like
`https://ig-autodm.<your-subdomain>.workers.dev/webhook` — no laptop, no
tunnel, no Meta dashboard re-pasting on restart.

See the top-level [README.md](../../README.md) for the full setup.

## One-time deploy

```bash
cd workers/ig-autodm
npm install
npx wrangler login

# Create KV namespace for dedupe; paste the printed id into wrangler.jsonc
npx wrangler kv namespace create DEDUPE_KV

# Set every secret. Easiest: source from your top-level .env:
source <(grep -E '^[A-Z_]+=' ../../.env | sed 's/^/export /')
for v in META_LONG_TOKEN META_APP_SECRET META_IG_USER_ID META_IG_USERNAME \
         META_WEBHOOK_VERIFY_TOKEN NOTION_API_KEY \
         NOTION_CONTENT_DB_ID NOTION_ACTIVITY_LOG_DB_ID; do
  echo "${!v}" | npx wrangler secret put "$v"
done

npx wrangler deploy
```

Wrangler prints the deployed URL on success.

## Update Meta webhook

1. Meta App Dashboard → your app → Webhooks (inside the Instagram use case)
2. Callback URL: `https://<your-deploy-url>/webhook`
3. Verify token: your `META_WEBHOOK_VERIFY_TOKEN`
4. **Verify and Save**, then subscribe to `comments`

## Tailing logs

```bash
npx wrangler tail
```

## Updating

After any change to `src/index.mjs` or the shared modules under
`../../scripts/ig-autodm/`:

```bash
npx wrangler deploy
```

## Notes

- Notion config is cached for 60s per isolate; edits propagate within a minute
- Token does NOT auto-refresh in the Worker — every ~50 days, run any Node
  script that calls `loadConfig()` to refresh your `.env`, then push the new
  token: `echo "$META_LONG_TOKEN" | npx wrangler secret put META_LONG_TOKEN`
- Free tier: 100k requests/day + 100k cron invocations/day
