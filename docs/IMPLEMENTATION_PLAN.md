# Instagram Auto-DM-on-Comment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the $40/mo ManyChat auto-DM-on-comment subscription with a self-hosted Node webhook that reads per-reel trigger config from Notion's Content Calendar, then sends an optional public comment reply + a private DM with a link button when matching comments arrive.

**Architecture:** Single Node ESM webhook server (`scripts/ig-autodm/`) subscribed to Meta's `comments` webhook. On startup, the CLI entry (`scripts/ig-autodm.mjs`) opens a Cloudflare quick tunnel (no signup, free) to expose localhost, registers the URL with Meta, and pulls per-reel DM config from the Notion Content Calendar database (`YOUR_CONTENT_DB_ID`) keyed by `ig_media_id`. Each incoming comment fires the match logic (keyword match or `*` = any), then dispatches a public reply (optional) + Private Reply DM with a button template. Dry-run flag logs intended sends without calling the Meta API. Designed to port to a Cloudflare Worker later with minimal changes — keep handler code free of Node-only APIs.

**Tech Stack:** Node 22+ ESM, Express (webhook server), native `fetch` (Meta + Notion HTTP), `node:test` (built-in test runner — no deps added), Cloudflare `cloudflared` CLI (tunnel — install via `brew install cloudflared`), existing `META_LONG_TOKEN` / `META_APP_SECRET` / `META_IG_USER_ID` from `.claude/last30days.env`, new `NOTION_API_KEY` + `META_WEBHOOK_VERIFY_TOKEN` env vars.

---

## File Structure

```
scripts/
  ig-autodm.mjs                      # CLI entry — starts tunnel + server, prints status
  ig-autodm/
    server.mjs                       # Express app: GET /webhook (verify) + POST /webhook (event)
    meta-api.mjs                     # Meta Graph calls: getLatestMedia, sendPrivateReply, sendCommentReply, refreshToken
    notion-config.mjs                # Fetch DM config rows from Notion by ig_media_id
    comment-handler.mjs              # Pure logic: given (comment, configMap, opts) → list of intended actions
    config.mjs                       # Loads env, exports constants (GRAPH_VERSION, NOTION_DB_ID, etc.)
    tunnel.mjs                       # Spawn `cloudflared tunnel --url http://localhost:PORT`, parse public URL
scripts/test/ig-autodm/
  comment-handler.test.mjs           # Pure-logic tests (no network)
  notion-config.test.mjs             # Notion parse tests (HTTP mocked with fetch stub)
docs/superpowers/plans/
  2026-05-21-instagram-autodm.md     # this file
.claude/last30days.env               # add NOTION_API_KEY, META_WEBHOOK_VERIFY_TOKEN, META_AUTODM_PORT
package.json                         # add "express" dep + "ig-autodm" npm script
```

**Boundary rule:** `comment-handler.mjs` is a pure function — no `fetch`, no `fs`, no `process.env`. Everything it needs is passed in. This is what makes it Workers-portable AND testable.

---

## Manual Pre-Work (Do Before Coding)

These are one-time setup steps that produce env vars the code will read. Plan tasks reference these by name.

### Pre-Work 1: Add Notion columns to Content Calendar

In the Notion Content Calendar database (`YOUR_CONTENT_DB_ID`), add these properties:

| Property name | Type | Purpose |
|---|---|---|
| `ig_media_id` | Text | The Instagram media ID, populated after you post. Used as the lookup key. |
| `dm_trigger_keyword` | Text | The word to match (case-insensitive substring). Use `*` for "any comment". |
| `dm_message_text` | Text | The DM body. |
| `dm_link_url` | URL | The link button URL. |
| `dm_link_title` | Text | The link button label (max ~20 chars for clean rendering). |
| `comment_reply_text` | Text | (Optional) Public reply text. Leave blank to skip the public reply. |
| `dm_status` | Select | Options: `inactive` (default), `active`, `expired`. Only `active` rows fire. |

Save the database in Notion. No code reads these names from a config file — they're hardcoded in `notion-config.mjs`, so spelling must match exactly.

### Pre-Work 2: Create / configure Meta App for webhooks

1. Go to https://developers.facebook.com/apps → use the existing app that owns `META_LONG_TOKEN` (or create a new "Business" app).
2. Add the **Webhooks** product to the app.
3. Add the **Instagram Graph API** product (likely already added — it powers `ig-insights.mjs`).
4. Under **App Roles → Roles**, add yourself as a Tester (Development Mode is fine — never need App Review for personal use).
5. Confirm these permissions are on the long-lived token. Re-issue via the Graph API Explorer if any are missing:
   - `instagram_basic`
   - `instagram_manage_comments`
   - `instagram_manage_messages`
   - `pages_manage_metadata`
   - `pages_read_engagement`
6. **Do not** subscribe the webhook yet — Task 9 will do that once the tunnel URL exists.
7. Generate a random string for the webhook verify token (used by Meta's GET handshake). Save it for `.env`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

### Pre-Work 3: Install cloudflared

```bash
brew install cloudflared
cloudflared --version  # confirm install
```

No login needed — we'll use the anonymous `try.cloudflare.com` flow.

### Pre-Work 4: Get a Notion integration token

1. https://www.notion.so/profile/integrations → New integration → Internal.
2. Workspace: select the @deepika.builds workspace.
3. Copy the secret (starts with `secret_` or `ntn_`).
4. Open the Content Calendar database in Notion → `•••` menu → Connections → add the new integration. This gives the token read access.

### Pre-Work 5: Add new env vars

Append to `.claude/last30days.env`:

```
NOTION_API_KEY=ntn_xxxxxxxxxxxxxxxxxxxx
META_WEBHOOK_VERIFY_TOKEN=<the random hex from Pre-Work 2.7>
META_AUTODM_PORT=8787
```

Verify file perms are still `0600` (the existing `saveEnv` in `ig-insights.mjs` sets this; double-check with `ls -l .claude/last30days.env`).

---

## Task 1: Set up dependencies and npm script

**Files:**
- Modify: `/Users/deepikarao/social-agent/package.json`

- [ ] **Step 1: Add Express dependency**

Run:
```bash
npm install express@4
```

Expected: `express` appears under `dependencies` in `package.json`. (Express 4 — Express 5 changes routing semantics; stick with 4 to keep this simple.)

- [ ] **Step 2: Add ig-autodm script entry**

Edit `/Users/deepikarao/social-agent/package.json` to look like:

```json
{
  "type": "module",
  "scripts": {
    "ig-autodm": "node scripts/ig-autodm.mjs",
    "ig-autodm:dry": "node scripts/ig-autodm.mjs --dry-run",
    "test:autodm": "node --test scripts/test/ig-autodm/"
  },
  "dependencies": {
    "dotenv": "^17.4.1",
    "express": "^4.19.0",
    "mem0ai": "^2.4.6"
  }
}
```

(The existing `package.json` is missing `"type": "module"` — every existing `.mjs` script declares its mode by extension, so adding it is harmless but skip if you'd rather not touch.)

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(ig-autodm): add express dep + npm scripts for auto-DM server"
```

---

## Task 2: Build config loader

**Files:**
- Create: `/Users/deepikarao/social-agent/scripts/ig-autodm/config.mjs`

Single responsibility: read `.claude/last30days.env`, expose constants. Reuses the same env-loader pattern as `ig-insights.mjs` so no new style is introduced.

- [ ] **Step 1: Write the failing test**

Create `/Users/deepikarao/social-agent/scripts/test/ig-autodm/config.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../ig-autodm/config.mjs';

test('loadConfig returns required Meta + Notion keys', () => {
  const cfg = loadConfig();
  assert.ok(cfg.META_LONG_TOKEN, 'META_LONG_TOKEN must be set');
  assert.ok(cfg.META_IG_USER_ID, 'META_IG_USER_ID must be set');
  assert.ok(cfg.NOTION_API_KEY, 'NOTION_API_KEY must be set');
  assert.ok(cfg.META_WEBHOOK_VERIFY_TOKEN, 'verify token must be set');
  assert.equal(cfg.GRAPH_VERSION, 'v22.0');
  assert.equal(cfg.NOTION_DB_ID, 'df14fb00-33bf-4fa3-96a8-8924d3cf6e56');
  assert.equal(typeof cfg.PORT, 'number');
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npm run test:autodm
```

Expected: FAIL with `Cannot find module '../../ig-autodm/config.mjs'`.

- [ ] **Step 3: Implement `config.mjs`**

Create `/Users/deepikarao/social-agent/scripts/ig-autodm/config.mjs`:

```js
// scripts/ig-autodm/config.mjs
// Single source of truth for env + constants. Pure read — no side effects.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const ENV_FILE = path.join(PROJECT_ROOT, '.claude/last30days.env');

export const GRAPH_VERSION = 'v22.0';
export const GRAPH_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;
export const NOTION_DB_ID = 'YOUR_CONTENT_DB_ID';
export const NOTION_API = 'https://api.notion.com/v1';

const REQUIRED = [
  'META_LONG_TOKEN',
  'META_APP_SECRET',
  'META_IG_USER_ID',
  'NOTION_API_KEY',
  'META_WEBHOOK_VERIFY_TOKEN',
];

function parseEnvFile(filepath) {
  if (!fs.existsSync(filepath)) throw new Error(`Missing env file: ${filepath}`);
  const out = {};
  for (const line of fs.readFileSync(filepath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function loadConfig() {
  const env = parseEnvFile(ENV_FILE);
  for (const key of REQUIRED) {
    if (!env[key]) throw new Error(`${key} missing in ${ENV_FILE}`);
  }
  return {
    ...env,
    PORT: parseInt(env.META_AUTODM_PORT || '8787', 10),
    GRAPH_VERSION,
    GRAPH_BASE,
    NOTION_DB_ID,
    NOTION_API,
    ENV_FILE,
    PROJECT_ROOT,
  };
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npm run test:autodm
```

Expected: 1 test passing. If it fails on missing env keys, complete Pre-Work 5 first.

- [ ] **Step 5: Commit**

```bash
git add scripts/ig-autodm/config.mjs scripts/test/ig-autodm/config.test.mjs
git commit -m "feat(ig-autodm): config loader with env + constants"
```

---

## Task 3: Build pure comment-match logic

**Files:**
- Create: `/Users/deepikarao/social-agent/scripts/ig-autodm/comment-handler.mjs`
- Create: `/Users/deepikarao/social-agent/scripts/test/ig-autodm/comment-handler.test.mjs`

The brain of the system. Pure function — given a webhook payload + a Notion config map, return the list of intended API actions. No network, no `process.env`. This is also the file that ports unchanged to Cloudflare Workers.

- [ ] **Step 1: Write the failing tests**

Create `/Users/deepikarao/social-agent/scripts/test/ig-autodm/comment-handler.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planActions } from '../../ig-autodm/comment-handler.mjs';

const baseConfig = {
  ig_media_id: '17900000000000001',
  dm_trigger_keyword: '*',
  dm_message_text: 'Here you go!',
  dm_link_url: 'https://example.com',
  dm_link_title: 'Open guide',
  comment_reply_text: '',
  dm_status: 'active',
};

const baseComment = {
  id: 'comment_123',
  media_id: '17900000000000001',
  from_id: 'user_456',
  from_username: 'tester',
  text: 'love this!',
  created_at_unix: Math.floor(Date.now() / 1000),
};

const SELF_IG_USER_ID = 'self_999';

test('star keyword fires DM on any comment', () => {
  const actions = planActions({
    comment: baseComment,
    configByMediaId: { [baseConfig.ig_media_id]: baseConfig },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'send_private_reply');
  assert.equal(actions[0].to_comment_id, 'comment_123');
});

test('specific keyword matches case-insensitive substring', () => {
  const cfg = { ...baseConfig, dm_trigger_keyword: 'link' };
  const c = { ...baseComment, text: 'send LINK pls' };
  const actions = planActions({
    comment: c,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 1);
});

test('specific keyword does not match unrelated comment', () => {
  const cfg = { ...baseConfig, dm_trigger_keyword: 'link' };
  const c = { ...baseComment, text: 'nice video' };
  const actions = planActions({
    comment: c,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('skips comments from self', () => {
  const c = { ...baseComment, from_id: SELF_IG_USER_ID };
  const actions = planActions({
    comment: c,
    configByMediaId: { [baseConfig.ig_media_id]: baseConfig },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('skips comments older than 7 days (Private Replies window)', () => {
  const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 86400;
  const c = { ...baseComment, created_at_unix: eightDaysAgo };
  const actions = planActions({
    comment: c,
    configByMediaId: { [baseConfig.ig_media_id]: baseConfig },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('skips when no config exists for media_id', () => {
  const actions = planActions({
    comment: baseComment,
    configByMediaId: {},
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('skips when dm_status is not active', () => {
  const cfg = { ...baseConfig, dm_status: 'inactive' };
  const actions = planActions({
    comment: baseComment,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 0);
});

test('also queues public comment reply when reply text is set', () => {
  const cfg = { ...baseConfig, comment_reply_text: 'Check your DMs 📩' };
  const actions = planActions({
    comment: baseComment,
    configByMediaId: { [cfg.ig_media_id]: cfg },
    selfIgUserId: SELF_IG_USER_ID,
  });
  assert.equal(actions.length, 2);
  assert.equal(actions[0].type, 'send_comment_reply');
  assert.equal(actions[1].type, 'send_private_reply');
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
npm run test:autodm
```

Expected: all 8 fail with `Cannot find module ... comment-handler.mjs`.

- [ ] **Step 3: Implement `comment-handler.mjs`**

Create `/Users/deepikarao/social-agent/scripts/ig-autodm/comment-handler.mjs`:

```js
// scripts/ig-autodm/comment-handler.mjs
// Pure logic. Given a comment webhook payload + a map of media_id -> config row,
// return the list of intended API actions. No network, no env, no fs.
// This file must stay portable to Cloudflare Workers.

const PRIVATE_REPLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * @param {object} args
 * @param {object} args.comment - { id, media_id, from_id, from_username, text, created_at_unix }
 * @param {Record<string, object>} args.configByMediaId - keyed by ig_media_id
 * @param {string} args.selfIgUserId - the page's own IG user id (to skip self-comments)
 * @param {number} [args.nowUnix] - inject for testability
 * @returns {Array<{type:'send_comment_reply'|'send_private_reply', ...}>}
 */
export function planActions({ comment, configByMediaId, selfIgUserId, nowUnix }) {
  const now = nowUnix ?? Math.floor(Date.now() / 1000);

  if (!comment || !comment.media_id) return [];
  if (comment.from_id === selfIgUserId) return [];

  const cfg = configByMediaId[comment.media_id];
  if (!cfg) return [];
  if (cfg.dm_status !== 'active') return [];

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

  if (cfg.comment_reply_text && cfg.comment_reply_text.trim()) {
    actions.push({
      type: 'send_comment_reply',
      to_comment_id: comment.id,
      text: cfg.comment_reply_text,
    });
  }

  actions.push({
    type: 'send_private_reply',
    to_comment_id: comment.id,
    message: cfg.dm_message_text,
    link_url: cfg.dm_link_url,
    link_title: cfg.dm_link_title,
  });

  return actions;
}
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
npm run test:autodm
```

Expected: 9 tests passing (1 from Task 2 + 8 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/ig-autodm/comment-handler.mjs scripts/test/ig-autodm/comment-handler.test.mjs
git commit -m "feat(ig-autodm): pure comment-match logic + tests"
```

---

## Task 4: Build Meta API client

**Files:**
- Create: `/Users/deepikarao/social-agent/scripts/ig-autodm/meta-api.mjs`

Wraps the three Meta endpoints we need: get latest media, send Private Reply, send comment reply. Mirrors the `ig-insights.mjs` style but doesn't share code (deliberate — keep `ig-insights.mjs` untouched).

No TDD here because the value is in HTTP shape, not branching logic. If you want coverage, mock `fetch` in a quick test — but skipping for now is fine.

- [ ] **Step 1: Implement `meta-api.mjs`**

Create `/Users/deepikarao/social-agent/scripts/ig-autodm/meta-api.mjs`:

```js
// scripts/ig-autodm/meta-api.mjs
// Thin Meta Graph API client for the auto-DM use case.

import { GRAPH_BASE } from './config.mjs';

async function metaFetch(pathAndQuery, { token, method = 'GET', body } = {}) {
  const url = `${GRAPH_BASE}${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
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
              title: linkTitle.slice(0, 20), // Meta truncates ~20 chars
            },
          ],
        },
      },
    },
  };
  return metaFetch(`/${igUserId}/messages`, { token, method: 'POST', body });
}

/** Subscribe the app to comment events for the IG user. */
export async function subscribeWebhook({ token, igUserId }) {
  return metaFetch(`/${igUserId}/subscribed_apps?subscribed_fields=comments`, {
    token,
    method: 'POST',
  });
}
```

- [ ] **Step 2: Smoke test by hand**

```bash
node -e "
import('./scripts/ig-autodm/config.mjs').then(async ({ loadConfig }) => {
  const cfg = loadConfig();
  const { getLatestMedia } = await import('./scripts/ig-autodm/meta-api.mjs');
  const m = await getLatestMedia({ token: cfg.META_LONG_TOKEN, igUserId: cfg.META_IG_USER_ID });
  console.log(JSON.stringify(m, null, 2));
});
"
```

Expected: prints `{ id, caption, media_type, ... }` for your most recent IG post.

- [ ] **Step 3: Commit**

```bash
git add scripts/ig-autodm/meta-api.mjs
git commit -m "feat(ig-autodm): Meta Graph client (latest media, private reply, comment reply, subscribe)"
```

---

## Task 5: Build Notion config fetcher

**Files:**
- Create: `/Users/deepikarao/social-agent/scripts/ig-autodm/notion-config.mjs`
- Create: `/Users/deepikarao/social-agent/scripts/test/ig-autodm/notion-config.test.mjs`

Queries the Content Calendar database, filters to rows with `dm_status = active`, returns a `Record<ig_media_id, configRow>` shaped exactly how `comment-handler.mjs` expects.

- [ ] **Step 1: Write the failing test**

Create `/Users/deepikarao/social-agent/scripts/test/ig-autodm/notion-config.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotionRow } from '../../ig-autodm/notion-config.mjs';

test('parseNotionRow extracts all DM columns', () => {
  const fakeRow = {
    id: 'page_abc',
    properties: {
      ig_media_id: { type: 'rich_text', rich_text: [{ plain_text: '1234567' }] },
      dm_trigger_keyword: { type: 'rich_text', rich_text: [{ plain_text: 'link' }] },
      dm_message_text: { type: 'rich_text', rich_text: [{ plain_text: 'Here you go!' }] },
      dm_link_url: { type: 'url', url: 'https://example.com' },
      dm_link_title: { type: 'rich_text', rich_text: [{ plain_text: 'Open' }] },
      comment_reply_text: { type: 'rich_text', rich_text: [] },
      dm_status: { type: 'select', select: { name: 'active' } },
    },
  };
  const parsed = parseNotionRow(fakeRow);
  assert.equal(parsed.ig_media_id, '1234567');
  assert.equal(parsed.dm_trigger_keyword, 'link');
  assert.equal(parsed.dm_message_text, 'Here you go!');
  assert.equal(parsed.dm_link_url, 'https://example.com');
  assert.equal(parsed.dm_link_title, 'Open');
  assert.equal(parsed.comment_reply_text, '');
  assert.equal(parsed.dm_status, 'active');
});

test('parseNotionRow handles missing dm_status as inactive', () => {
  const fakeRow = {
    id: 'page_abc',
    properties: {
      ig_media_id: { type: 'rich_text', rich_text: [{ plain_text: '999' }] },
      dm_trigger_keyword: { type: 'rich_text', rich_text: [] },
      dm_message_text: { type: 'rich_text', rich_text: [] },
      dm_link_url: { type: 'url', url: null },
      dm_link_title: { type: 'rich_text', rich_text: [] },
      comment_reply_text: { type: 'rich_text', rich_text: [] },
      dm_status: { type: 'select', select: null },
    },
  };
  const parsed = parseNotionRow(fakeRow);
  assert.equal(parsed.dm_status, 'inactive');
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
npm run test:autodm
```

Expected: 2 new failures.

- [ ] **Step 3: Implement `notion-config.mjs`**

Create `/Users/deepikarao/social-agent/scripts/ig-autodm/notion-config.mjs`:

```js
// scripts/ig-autodm/notion-config.mjs
// Pull per-reel DM trigger config from the Content Calendar database.

import { NOTION_API, NOTION_DB_ID } from './config.mjs';

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
export async function fetchAllConfigs({ apiKey }) {
  const url = `${NOTION_API}/databases/${NOTION_DB_ID}/query`;
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
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm run test:autodm
```

Expected: 11 tests passing.

- [ ] **Step 5: Smoke test against real Notion**

```bash
node -e "
import('./scripts/ig-autodm/config.mjs').then(async ({ loadConfig }) => {
  const cfg = loadConfig();
  const { fetchAllConfigs } = await import('./scripts/ig-autodm/notion-config.mjs');
  const map = await fetchAllConfigs({ apiKey: cfg.NOTION_API_KEY });
  console.log(JSON.stringify(map, null, 2));
});
"
```

Expected: `{}` if no rows have `ig_media_id` populated yet, or a map of media_id → config if any rows are set. Either is fine — proves the Notion connection works.

- [ ] **Step 6: Commit**

```bash
git add scripts/ig-autodm/notion-config.mjs scripts/test/ig-autodm/notion-config.test.mjs
git commit -m "feat(ig-autodm): Notion Content Calendar config fetcher"
```

---

## Task 6: Build the webhook server

**Files:**
- Create: `/Users/deepikarao/social-agent/scripts/ig-autodm/server.mjs`

Express app exposing `GET /webhook` (Meta's verify handshake) and `POST /webhook` (comment events). Wires together everything from prior tasks.

- [ ] **Step 1: Implement `server.mjs`**

Create `/Users/deepikarao/social-agent/scripts/ig-autodm/server.mjs`:

```js
// scripts/ig-autodm/server.mjs
// Webhook server. Receives Meta comment events, fetches Notion config,
// dispatches actions via meta-api.

import express from 'express';
import { planActions } from './comment-handler.mjs';
import { fetchAllConfigs } from './notion-config.mjs';
import { sendCommentReply, sendPrivateReply } from './meta-api.mjs';

export function createServer({ cfg, options = {} }) {
  const { dryRun = false, configCacheMs = 60_000 } = options;
  const app = express();
  app.use(express.json());

  // Refresh Notion config periodically. First fetch is on startup (caller invokes).
  let configCache = {};
  let lastFetch = 0;
  async function refreshConfigs() {
    configCache = await fetchAllConfigs({ apiKey: cfg.NOTION_API_KEY });
    lastFetch = Date.now();
    console.log(`[ig-autodm] loaded ${Object.keys(configCache).length} active config(s) from Notion`);
    return configCache;
  }

  async function ensureFresh() {
    if (Date.now() - lastFetch > configCacheMs) await refreshConfigs();
    return configCache;
  }

  // --- GET /webhook: Meta's verify handshake
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === cfg.META_WEBHOOK_VERIFY_TOKEN) {
      console.log('[ig-autodm] webhook verified');
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  // --- POST /webhook: comment events
  app.post('/webhook', async (req, res) => {
    // ACK first — Meta retries aggressively if you delay.
    res.sendStatus(200);

    try {
      const configMap = await ensureFresh();
      for (const entry of req.body?.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (change.field !== 'comments') continue;
          const v = change.value || {};
          const comment = {
            id: v.id,
            media_id: v.media?.id,
            from_id: v.from?.id,
            from_username: v.from?.username,
            text: v.text || '',
            created_at_unix: Math.floor(Date.now() / 1000), // Meta doesn't always send timestamp; fresh by definition
          };
          console.log(`[ig-autodm] comment ${comment.id} on ${comment.media_id} by @${comment.from_username}: "${comment.text}"`);

          const actions = planActions({
            comment,
            configByMediaId: configMap,
            selfIgUserId: cfg.META_IG_USER_ID,
          });

          for (const action of actions) {
            if (dryRun) {
              console.log(`[ig-autodm][DRY] would ${action.type}:`, JSON.stringify(action));
              continue;
            }
            try {
              if (action.type === 'send_comment_reply') {
                await sendCommentReply({
                  token: cfg.META_LONG_TOKEN,
                  commentId: action.to_comment_id,
                  message: action.text,
                });
                console.log(`[ig-autodm] sent comment reply on ${action.to_comment_id}`);
              } else if (action.type === 'send_private_reply') {
                await sendPrivateReply({
                  token: cfg.META_LONG_TOKEN,
                  igUserId: cfg.META_IG_USER_ID,
                  commentId: action.to_comment_id,
                  message: action.message,
                  linkUrl: action.link_url,
                  linkTitle: action.link_title,
                });
                console.log(`[ig-autodm] sent DM for ${action.to_comment_id}`);
              }
            } catch (err) {
              console.error(`[ig-autodm] action failed:`, err.message);
            }
          }
        }
      }
    } catch (err) {
      console.error('[ig-autodm] webhook handler error:', err);
    }
  });

  // --- GET / : health check
  app.get('/', (req, res) => res.json({ ok: true, configCount: Object.keys(configCache).length }));

  return { app, refreshConfigs };
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/ig-autodm/server.mjs
git commit -m "feat(ig-autodm): webhook server with verify handshake + event handler"
```

---

## Task 7: Build the Cloudflare tunnel helper

**Files:**
- Create: `/Users/deepikarao/social-agent/scripts/ig-autodm/tunnel.mjs`

Spawns `cloudflared tunnel --url http://localhost:PORT` and parses the public URL out of its stdout. Returns a promise that resolves with the URL.

- [ ] **Step 1: Implement `tunnel.mjs`**

Create `/Users/deepikarao/social-agent/scripts/ig-autodm/tunnel.mjs`:

```js
// scripts/ig-autodm/tunnel.mjs
// Spawns a Cloudflare quick tunnel and extracts the public URL.

import { spawn } from 'node:child_process';

export function startTunnel({ port, timeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

    function onChunk(buf) {
      const s = buf.toString();
      process.stderr.write(s); // surface tunnel logs
      if (resolved) return;
      const m = s.match(urlRe);
      if (m) {
        resolved = true;
        resolve({ url: m[0], proc });
      }
    }
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);

    proc.on('exit', (code) => {
      if (!resolved) reject(new Error(`cloudflared exited (${code}) before printing URL`));
    });

    setTimeout(() => {
      if (!resolved) {
        proc.kill('SIGTERM');
        reject(new Error(`cloudflared did not produce a URL within ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}
```

- [ ] **Step 2: Smoke test by hand**

```bash
node -e "
import('./scripts/ig-autodm/tunnel.mjs').then(async ({ startTunnel }) => {
  const { url, proc } = await startTunnel({ port: 8787 });
  console.log('Tunnel URL:', url);
  setTimeout(() => proc.kill(), 3000);
});
"
```

Expected: prints `Tunnel URL: https://something-random.trycloudflare.com`, then the process exits after 3s.

- [ ] **Step 3: Commit**

```bash
git add scripts/ig-autodm/tunnel.mjs
git commit -m "feat(ig-autodm): Cloudflare quick-tunnel spawner"
```

---

## Task 8: Build the CLI entry

**Files:**
- Create: `/Users/deepikarao/social-agent/scripts/ig-autodm.mjs`

Top-level orchestrator. Boots the server, opens the tunnel, prints status, fetches your latest reel, prints the Notion config for it (or warns if none exists), and waits.

- [ ] **Step 1: Implement `ig-autodm.mjs`**

Create `/Users/deepikarao/social-agent/scripts/ig-autodm.mjs`:

```js
#!/usr/bin/env node
// scripts/ig-autodm.mjs
//
// Auto-DM-on-comment server for @deepika.builds.
//
// Usage:
//   npm run ig-autodm                 # live mode
//   npm run ig-autodm:dry             # dry-run (logs intended sends, doesn't call Meta)
//
// On startup:
//   1. Loads env from .claude/last30days.env
//   2. Starts local Express server on META_AUTODM_PORT (default 8787)
//   3. Opens a Cloudflare quick tunnel and prints the public URL
//   4. Fetches latest IG media and prints whether a Notion config row exists for it
//   5. Listens until ctrl+C

import { loadConfig } from './ig-autodm/config.mjs';
import { createServer } from './ig-autodm/server.mjs';
import { startTunnel } from './ig-autodm/tunnel.mjs';
import { getLatestMedia, getRecentMedia } from './ig-autodm/meta-api.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

async function main() {
  const cfg = loadConfig();
  console.log(`[ig-autodm] starting (${dryRun ? 'DRY-RUN' : 'LIVE'})`);

  const { app, refreshConfigs } = createServer({ cfg, options: { dryRun } });
  const configMap = await refreshConfigs();

  const httpServer = app.listen(cfg.PORT, () => {
    console.log(`[ig-autodm] server listening on http://localhost:${cfg.PORT}`);
  });

  console.log('[ig-autodm] opening Cloudflare tunnel…');
  const { url: publicUrl, proc: tunnelProc } = await startTunnel({ port: cfg.PORT });
  const webhookUrl = `${publicUrl}/webhook`;
  console.log('');
  console.log('=========================================================');
  console.log(' WEBHOOK URL (paste into Meta App webhook settings):');
  console.log(`   ${webhookUrl}`);
  console.log(` VERIFY TOKEN:`);
  console.log(`   ${cfg.META_WEBHOOK_VERIFY_TOKEN}`);
  console.log('=========================================================');
  console.log('');

  // Show latest media + whether it has a config
  try {
    const latest = await getLatestMedia({ token: cfg.META_LONG_TOKEN, igUserId: cfg.META_IG_USER_ID });
    if (latest) {
      const has = configMap[latest.id];
      console.log(`[ig-autodm] latest media: ${latest.id} (${latest.media_product_type || latest.media_type})`);
      console.log(`            permalink:    ${latest.permalink}`);
      console.log(`            caption:      ${(latest.caption || '').slice(0, 80)}…`);
      if (has) {
        console.log(`            ✅ Notion config FOUND (trigger="${has.dm_trigger_keyword}", status=${has.dm_status})`);
      } else {
        console.log(`            ⚠️  no Notion config row for this media_id yet.`);
        console.log(`            Add a row to the Content Calendar with ig_media_id="${latest.id}" and dm_status="active".`);
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
    tunnelProc.kill();
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
```

- [ ] **Step 2: Commit**

```bash
git add scripts/ig-autodm.mjs
git commit -m "feat(ig-autodm): CLI entry — tunnel + server + latest-reel status"
```

---

## Task 9: First end-to-end run + register webhook

This is the one-time wire-up in the Meta dashboard. Do it once, then the URL stays registered until Meta detects N consecutive failures (rare). The tunnel URL **does change between runs** — see Task 11 for the long-term fix; for the first live test, you'll re-register it after each restart.

- [ ] **Step 1: Run in dry mode**

```bash
npm run ig-autodm:dry
```

Expected output includes:
- `[ig-autodm] server listening on http://localhost:8787`
- `WEBHOOK URL: https://<random>.trycloudflare.com/webhook`
- Latest media block with either ✅ or ⚠️.

Leave it running.

- [ ] **Step 2: Register webhook in Meta App dashboard**

1. https://developers.facebook.com/apps → your app → **Webhooks** product.
2. **Add subscription** → object: `Instagram`.
3. Callback URL: paste the `https://<random>.trycloudflare.com/webhook` URL.
4. Verify Token: paste the value of `META_WEBHOOK_VERIFY_TOKEN`.
5. Click **Verify and Save**. Meta will GET your `/webhook` with `hub.challenge`. Your server log should print `[ig-autodm] webhook verified`.
6. Under that subscription's fields, **subscribe to `comments`**.

- [ ] **Step 3: Subscribe the app to your IG user**

Once per app+account. Run:

```bash
node -e "
import('./scripts/ig-autodm/config.mjs').then(async ({ loadConfig }) => {
  const cfg = loadConfig();
  const { subscribeWebhook } = await import('./scripts/ig-autodm/meta-api.mjs');
  console.log(await subscribeWebhook({ token: cfg.META_LONG_TOKEN, igUserId: cfg.META_IG_USER_ID }));
});
"
```

Expected: `{ success: true }`.

- [ ] **Step 4: Wire up your next reel**

After you post your next reel:

1. Find its media_id — easiest is just stop+restart `npm run ig-autodm:dry`; it prints the latest media_id on boot.
2. In Notion Content Calendar, add a row (or edit the row you already have for this reel):
   - `ig_media_id`: paste the id
   - `dm_trigger_keyword`: e.g. `*` or `link`
   - `dm_message_text`: the DM body
   - `dm_link_url`: the URL
   - `dm_link_title`: button label
   - `comment_reply_text`: (optional) public reply text
   - `dm_status`: `active`
3. Wait up to 60s for the auto-reload, or restart the script.

- [ ] **Step 5: Live dry-run test**

While the script runs in `--dry-run` mode:
- From your phone or a friend's account, comment on the reel.
- The server log should print:
  - `[ig-autodm] comment <id> on <media> by @<username>: "<text>"`
  - `[ig-autodm][DRY] would send_private_reply: { ... }`

If you see that line: **the entire pipeline works.** Move to Step 6.

If nothing arrives: check Meta's Webhooks dashboard → recent deliveries. If Meta reports 200 OK but you see nothing, the comment didn't match your config. If Meta reports errors, the tunnel URL likely changed (restart and re-register).

- [ ] **Step 6: Live for real**

Restart in live mode:

```bash
npm run ig-autodm
```

Re-register the new tunnel URL with Meta (Step 2 again — the URL changed). Comment again. You should receive the DM.

- [ ] **Step 7: Commit any small fixes uncovered during live test**

```bash
git add -p
git commit -m "fix(ig-autodm): adjustments from first live test"
```

---

## Task 10: Document setup in repo

**Files:**
- Create: `/Users/deepikarao/social-agent/scripts/ig-autodm/README.md`

A short operational doc so future-Deepika doesn't reverse-engineer this.

- [ ] **Step 1: Write the README**

Create `/Users/deepikarao/social-agent/scripts/ig-autodm/README.md`:

```markdown
# ig-autodm

Self-hosted auto-DM-on-comment for @deepika.builds. Replaces ManyChat.

## How to start

    npm run ig-autodm        # live
    npm run ig-autodm:dry    # logs intended sends, does not call Meta

The CLI prints the Cloudflare tunnel URL. Paste it into the Meta App
webhook settings (one-time per session — the URL changes on restart).

## Per-reel config

Lives in the Notion Content Calendar database. After posting a reel:

1. Restart the script — it prints the new reel's media_id.
2. In Notion, edit that reel's row:
   - ig_media_id: <the id>
   - dm_trigger_keyword: * (any) or a substring
   - dm_message_text: DM body
   - dm_link_url + dm_link_title: button
   - comment_reply_text: optional public reply
   - dm_status: active

Configs reload every 60s automatically.

## Env vars

See .claude/last30days.env:
- META_LONG_TOKEN, META_APP_SECRET, META_IG_USER_ID (shared with ig-insights.mjs)
- META_WEBHOOK_VERIFY_TOKEN (random hex string)
- NOTION_API_KEY (internal integration with Content Calendar access)
- META_AUTODM_PORT (default 8787)

## Architecture

scripts/ig-autodm.mjs            entry — tunnel + server boot
scripts/ig-autodm/server.mjs     Express webhook
scripts/ig-autodm/comment-handler.mjs   pure match logic (also Workers-portable)
scripts/ig-autodm/meta-api.mjs   Graph API client
scripts/ig-autodm/notion-config.mjs   Notion db query + row parsing
scripts/ig-autodm/tunnel.mjs     cloudflared spawner
scripts/ig-autodm/config.mjs     env loader

## Tests

    npm run test:autodm
```

- [ ] **Step 2: Commit**

```bash
git add scripts/ig-autodm/README.md
git commit -m "docs(ig-autodm): operational README"
```

---

## Task 11: (Optional, after first live success) Cloudflare Workers port

Once Task 9 works, port to a Worker so the laptop doesn't need to stay on. The handler is already portable — the work is mostly scaffolding.

This is **a separate plan**, not part of this one. Suggested path when you're ready:

1. `npm create cloudflare@latest ig-autodm-worker` — pick "Hello World worker".
2. Copy `comment-handler.mjs` unchanged.
3. Re-implement `meta-api.mjs` and `notion-config.mjs` against Workers' `fetch` (already compatible — no Node-only APIs).
4. Replace `server.mjs` with a Worker `fetch` handler:
   ```js
   export default {
     async fetch(req, env) {
       // route GET /webhook → verify
       // route POST /webhook → handler
     }
   }
   ```
5. Move env vars to `wrangler secret put` instead of `.claude/last30days.env`.
6. `wrangler deploy` gives you a stable `*.workers.dev` URL — register it with Meta once and never touch again.
7. For Notion cache freshness, use Workers' KV (or just re-fetch on every event — Notion's free tier is generous).

Free tier of Workers covers 100K requests/day — orders of magnitude more than you'll ever get.

---

## Self-Review

**Spec coverage** — every requirement traced to a task:
- "Run a command, fetch latest reel, automation set from Notion, keeps running" → Task 8 (CLI), Task 6 (server with 60s reload), Task 5 (Notion).
- "Same as ManyChat: keyword OR any, text + link + link title, separate per reel" → Task 3 (`*` keyword + match logic), Task 4 (`sendPrivateReply` with button template), Task 5 (per-media_id config map).
- "Comment reply also" → Task 3 (`comment_reply_text` field), Task 4 (`sendCommentReply`), schema in Pre-Work 1.
- "Test before next reel" → Task 9 Step 5 (dry-run live test). Pure logic also covered by `node:test`.
- "Cloud route soon" → Task 11 (separate plan stub).
- "Won't flag the account" → enforced by using official Private Replies endpoint + 7-day window check in `comment-handler.mjs`.

**Placeholder scan** — no TBDs, no "implement later", no "similar to Task N". All code blocks are complete.

**Type consistency** — `planActions` returns `{type, to_comment_id, ...}`; `server.mjs` consumes those exact fields. `parseNotionRow` returns `{ig_media_id, dm_trigger_keyword, dm_message_text, dm_link_url, dm_link_title, comment_reply_text, dm_status}`; `comment-handler.mjs` reads those exact fields. `loadConfig` returns `{META_LONG_TOKEN, META_IG_USER_ID, META_WEBHOOK_VERIFY_TOKEN, NOTION_API_KEY, PORT, ...}`; server + CLI read those exact names. Notion column names in Pre-Work 1 match the property keys read in `notion-config.mjs`. Looks consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-21-instagram-autodm.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session, batch with checkpoints for review.

Which approach?
