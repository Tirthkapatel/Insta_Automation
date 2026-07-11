# Insta-Automation

**Self-hosted Instagram auto-DM-on-comment. A free, open-source replacement for ManyChat's $40/month plan.**

When someone comments on your Instagram post or Reel, automatically reply publicly and slide into their DMs with a link. Same workflow as ManyChat, runs for $0/month on Cloudflare's free tier, configured from a Notion database you already use to plan content.

Built end-to-end in one evening to replace a $480/year subscription. See [`docs/BUILD_LOG.md`](docs/BUILD_LOG.md) for the full story including all the gotchas.

---

## What it does

1. Someone comments on your Reel (e.g. `"send me the link"`)
2. A Cloudflare Worker receives the comment via Meta's official Instagram Graph API webhook
3. The Worker looks up your per-reel DM config in Notion
4. If the trigger keyword matches, fires a public comment reply + a DM with a button-style link
5. Catch-up cron runs every 10 minutes to backfill any comments Meta's spam classifier silently dropped from webhook delivery
6. Every event is logged to a second Notion database for full visibility

Plus things ManyChat doesn't have:
- **Loop guard** with 4 layers of self-comment detection (so the bot never replies to its own replies — yes, that's a real bug in the naive implementation)
- **Per-(media + user) dedupe** in Cloudflare KV (each user only gets one DM per reel, ever)
- **Randomized reply variations** to slip past Instagram's spam pattern detection
- **Token auto-refresh** for the 60-day Meta long-lived token

---

## Architecture

```
Instagram comment
       ↓
Meta webhook
       ↓
Cloudflare Worker  ─────────  Notion (per-reel config + activity log)
       │
       ├──── Cloudflare KV (dedupe)
       │
       └──── Meta Graph API (public reply + Private Reply DM)

[Cron every 10 min] → Worker scans Meta GET /comments → backfills missed DMs
```

Pure-function handler (`scripts/ig-autodm/comment-handler.mjs`) is the brain. It runs identically in Node (local dev) and Cloudflare Workers (production) — the file has zero Node-only APIs.

Free-tier limits handle ~hundreds of comments per day without issue.

---

## Setup (~45 minutes)

You'll need:
- An **Instagram Business or Creator** account connected to a Facebook Page
- A **Cloudflare account** (free)
- A **Notion workspace**
- A **Meta developer app** (free)
- Node 22+ and `cloudflared` installed locally

### 1. Meta App + Instagram Login token

1. Go to https://developers.facebook.com/apps → **Create App**
2. Use case: **Other** → app type: **Business**
3. Add the **Instagram** product (the new "Instagram Login" flow, not the older Basic Display)
4. In **App Roles → Instagram Testers**, add your Instagram username (the one you'll send DMs from). Accept the invite on instagram.com → Settings → Apps and websites → Tester invites.
5. Generate a long-lived token in Graph API Explorer with these scopes:
   - `instagram_business_basic`
   - `instagram_business_manage_comments`
   - `instagram_business_manage_messages`
6. From `GET /me?fields=id`, note your `META_IG_USER_ID`
7. Pick a random verify token (for the webhook handshake):
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
8. **Publish** the app — Instagram comment webhooks **do not deliver in Development Mode**. (This is undocumented and cost me half a day to find. You'll need a privacy policy URL — a public GitHub Gist with one paragraph works fine.)

### 2. Notion content calendar + activity log

Create two databases in your workspace:

**Content Calendar** — one row per reel, with these properties:

| Property | Type | Purpose |
|---|---|---|
| `Title` | Title | Just a label for you |
| `ig_media_id` | Rich text | The IG media ID (filled by `npm run ig-autodm:attach`) |
| `dm_trigger_keyword` | Rich text | `*` for any comment, or a substring |
| `dm_message_text` | Rich text | DM body. **One variation per line** for randomization. |
| `dm_link_url` | URL | Where the button goes |
| `dm_link_title` | Rich text | Button label (max ~20 chars) |
| `comment_reply_text` | Rich text | Optional public reply. **One variation per line.** |
| `dm_status` | Select | Options: `active`, `inactive`, `expired` |

**DM Activity Log** — one row per fired event. Properties:

| Property | Type |
|---|---|
| `Title` | Title |
| `timestamp` | Date |
| `media_id` | Rich text |
| `comment_id` | Rich text |
| `commenter` | Rich text |
| `comment_text` | Rich text |
| `action` | Select (`dm_sent`, `reply_sent`, `skipped_deduped`, `skipped_no_match`, `failed`) |
| `error` | Rich text |
| `source` | Select (`webhook`, `catch_up`) |

Then create a Notion **internal integration** at https://www.notion.so/profile/integrations and **add it as a Connection** on both databases (`···` menu → Connections → search for the integration).

Note the database IDs — they're in the URL: `notion.so/<workspace>/<DB_ID>?v=...`.

### 3. Local env file

```bash
cp .env.example .env
```

Fill in every value. The DB IDs go in `NOTION_CONTENT_DB_ID` and `NOTION_ACTIVITY_LOG_DB_ID`.

### 4. Verify locally (optional but recommended)

```bash
npm install
npm test                # 30+ unit tests
npm run ig-autodm:dry   # starts local server + cloudflared tunnel
```

The CLI prints a webhook URL. You can paste it into Meta to verify the handshake works before deploying to production.

### 5. Deploy to Cloudflare

```bash
cd workers/ig-autodm
npm install
npx wrangler login
npx wrangler kv namespace create DEDUPE_KV
# Paste the printed `id` into wrangler.jsonc → kv_namespaces[0].id

# Set secrets (pulled from your .env):
source <(grep -E '^[A-Z_]+=' ../../.env | sed 's/^/export /')
for v in META_LONG_TOKEN META_APP_SECRET META_IG_USER_ID META_IG_USERNAME \
         META_WEBHOOK_VERIFY_TOKEN NOTION_API_KEY \
         NOTION_CONTENT_DB_ID NOTION_ACTIVITY_LOG_DB_ID; do
  echo "${!v}" | npx wrangler secret put "$v"
done

npx wrangler deploy
```

The deploy prints your permanent Worker URL (`https://ig-autodm.<your-subdomain>.workers.dev`).

### 6. Register the webhook with Meta

Meta App Dashboard → your app → **Webhooks** (inside the Instagram use case) → **Configure**:
- Callback URL: `https://ig-autodm.<your-subdomain>.workers.dev/webhook`
- Verify token: your `META_WEBHOOK_VERIFY_TOKEN`
- Click **Verify and Save**
- Subscribe to the `comments` field

Then run once to subscribe the IG user to the app:

```bash
node -e "import('./scripts/ig-autodm/config.mjs').then(async ({ loadConfig }) => {
  const cfg = await loadConfig();
  const { subscribeWebhook } = await import('./scripts/ig-autodm/meta-api.mjs');
  console.log(await subscribeWebhook({ token: cfg.META_LONG_TOKEN, igUserId: cfg.META_IG_USER_ID }));
});"
```

Expect `{ success: true }`.

You're live.

---

## Daily workflow

For each new reel:

1. **Before posting**: in Notion Content Calendar, fill a row with DM trigger fields. Leave `ig_media_id` blank. Set `dm_status` to `active`.
2. **Post the reel** on Instagram.
3. **Run** `npm run ig-autodm:attach` — it fetches your latest reel's media_id and links it to the unique pending Notion row.
4. Done. The Worker reloads config every 60 seconds.

To watch live activity: `npx wrangler tail` from `workers/ig-autodm/`.

To manually trigger a catch-up (also runs automatically every 10 minutes):
```bash
curl -X POST -H "Authorization: Bearer <META_WEBHOOK_VERIFY_TOKEN>" \
  https://ig-autodm.<your-subdomain>.workers.dev/catch-up
```

---

## Customization

### Multiple reply variations

Put one per line in the Notion `comment_reply_text` / `dm_message_text` fields:

```
DMed you the notes 💬
Check your DMs 📩
Sent! 🚀
Sliding in 👇
```

The bot picks a random one per send. This is genuinely important: Instagram's spam classifier silently drops webhook deliveries for identical-text repeated comments, so varying replies looks more human and improves delivery rate.

### Trigger keyword

- `*` matches any comment
- Anything else is a case-insensitive substring match
- For example, trigger `link` matches `"send link"`, `"LINK pls"`, `"any link?"`

### Loop prevention

The handler has 4 layers of self-comment guard so the bot never replies to its own replies:

1. Skip if `from.id` matches your `META_IG_USER_ID`
2. Skip if `from.username` matches your `META_IG_USERNAME` (Meta sometimes omits `from.id` for the account owner's own comments — bug we caught the hard way)
3. Skip if no identifiable sender at all
4. Skip if the comment text matches ANY of your configured reply variations

If you ever see a runaway loop, all 4 guards have to fail simultaneously — extraordinarily unlikely.

---

## Limits and known gotchas

- **Meta's 7-day Private Reply window**: you can only DM a commenter within 7 days of their comment. The catch-up enforces this.
- **Instagram spam classifier**: short generic comments like `"DM"` repeated across accounts on one post get silently dropped from webhook delivery. The catch-up cron is the safety net.
- **Cloudflare KV is eventually consistent for ~10–60 seconds after writes** — if a comment fires the webhook and the cron fires within seconds, the cron might re-process before the dedupe write propagates. Rare in practice; the loop guard catches it anyway.
- **Cloudflare Worker free tier**: 50 subrequests per invocation. The catch-up is hard-capped at 25 sends per run with 800ms gaps — high-volume reels backfill across multiple cron ticks.
- **Token refresh**: long-lived Meta tokens expire after 60 days. Run any Node script using `loadConfig()` to refresh the token in your `.env`, then re-push to the Worker with `npx wrangler secret put META_LONG_TOKEN`.

---

## File map

```
scripts/
  ig-autodm.mjs                    # Local-dev CLI entry (server + cloudflared tunnel)
  ig-autodm-attach.mjs             # CLI: link latest reel to Notion row
  ig-autodm/
    config.mjs                     # env loader (Worker-safe at module load)
    comment-handler.mjs            # Pure matching logic — runs identical in Node & Workers
    meta-api.mjs                   # Meta Graph API client
    notion-config.mjs              # Notion content calendar queries
    dedupe-store.mjs               # Per-(media+user) dedupe interface (memory + KV impls)
    activity-log.mjs               # Notion activity log writer
    catch-up.mjs                   # Pure backfill function
    server.mjs                     # Express webhook for local dev
    tunnel.mjs                     # cloudflared spawner
    token-refresh.mjs              # 60-day token refresh helper
    attach.mjs                     # Notion attach helpers
  test/
    ig-autodm/                     # 30+ unit tests (node:test, no Jest)

workers/ig-autodm/
  src/index.mjs                    # Cloudflare Worker (fetch + scheduled handlers)
  wrangler.jsonc                   # Worker config (cron + KV binding)

docs/
  BUILD_LOG.md                     # The full story of building this
  IMPLEMENTATION_PLAN.md           # Original TDD-style implementation plan
```

---

## License

MIT. See [LICENSE](LICENSE).

If you ship this and save the $40/month, a star on the repo is appreciated. If you improve it, PRs welcome.
