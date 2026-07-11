# I killed my $40/mo ManyChat subscription by building it myself in one evening

**Date:** May 22, 2026
**Total build time:** ~4 hours including all the bumps
**Cost going forward:** $0/mo (Cloudflare free tier)
**Stack:** Node.js, Meta Graph API, Notion API, Cloudflare Workers

---

## TL;DR

ManyChat charges $40/month for auto-DM-on-comment. Every Instagram creator I know pays it. Turns out Meta's official Graph API does exactly the same thing for free. I built a self-hosted replacement that reads per-reel DM triggers from my Notion content calendar, fires public replies and DMs through the official Instagram Messaging API, and runs forever on Cloudflare's free Worker tier with no laptop required.

---

## The problem

I was paying ManyChat $40/month for one feature: when someone comments on my reel, send them a DM with a link. That's it. The rest of ManyChat is fluff I don't use.

The ManyChat workflow:
1. Open ManyChat dashboard
2. Pick a post
3. Type a keyword (or "any comment")
4. Write the DM message and link
5. Activate the automation

I wanted the exact same workflow, but free, and ideally integrated with my Notion content calendar where I already plan reels.

---

## What I built

A single command on my laptop that:
- Reads the latest reel I posted
- Reads my Notion content calendar for the matching DM config (keyword, message, link, button text)
- Listens for new comments on that reel
- Fires a public reply ("Check your DMs 📩") and a private DM with the link

Then I deployed the listener to a Cloudflare Worker so it runs 24/7 with no laptop, no terminal, no servers to maintain. Total monthly cost: zero.

---

## How it works (the 30-second version)

1. **Meta fires a webhook** every time someone comments on my Instagram posts.
2. **Cloudflare Worker** receives the webhook at a fixed permanent URL.
3. **Worker queries Notion** to see if there's an active DM config for that specific reel.
4. **If there's a match**, the Worker calls Meta's Private Replies API and sends the configured DM, plus optionally a public reply nested under the comment.

That's the whole system. Five moving parts. Free.

---

## My new daily workflow per reel

Before:
- Open ManyChat
- Search for my new post
- Type message, paste link
- Activate

Now:
1. **Before posting**: in Notion content calendar, fill a row with the DM message, link, link button label, and keyword. Set status to `active`.
2. **Post the reel** on Instagram.
3. **Run one command** on my laptop: `npm run ig-autodm:attach`. This grabs the latest reel's ID, finds the matching pending Notion row, links them automatically.
4. Done. DMs fire forever.

Editing the message later? Just edit the Notion row. The Worker reloads config every 60 seconds.

---

## The journey (where it got interesting)

This was not a clean run. Here are the moments worth talking about:

### 1. Stale Notion database ID

My agent's memory had the Content Calendar database ID from months ago. The database had moved. Cost me 10 minutes of "why is the API returning 404." Lesson: cache invalidation is the hardest problem in software, even for AI agents.

### 2. Meta App Review is a maze

Meta has two parallel app models. The legacy "Permissions" model and the new "Use Cases" model. Documentation references both interchangeably. I spent 20 minutes looking for a "Webhooks" product that doesn't exist in the new model. Webhooks are now configured inside the Use Case itself.

### 3. Instagram tester invites are web-only

Meta says "add the test account as an Instagram Tester and they can interact with your app in development mode." The invite that gets sent? Only visible if the tester logs into Instagram on the **web**. Not mobile. Not the official app. Web only. There is no documentation of this. I tried logout, login, app update, three different setting menus before discovering this.

### 4. Development mode does not deliver Instagram webhooks

This is undocumented anywhere I could find. The Use Cases model requires the app to be in **Published** state for comment webhooks to actually fire, even for the app owner. Tester invites don't help. I burned 30 minutes proving this before accepting the obvious fix: publish the app.

### 5. The infinite comment loop

First real audience comment came in. My bot fired the public reply. Meta then sent a webhook for **my own bot's reply**, which my code matched on the "any comment" trigger, which fired another reply, which triggered another webhook, which fired another reply...

15+ "Check your DMs 📩" comments on the reel in 8 seconds before I killed the server.

The fix needed four layers of self-detection because Meta's webhook payload sometimes omits the `from.id` field for the page owner's own comments:
1. Skip if `from.id` matches our own IG user ID
2. Skip if `from.username` matches our own handle
3. Skip if no identifiable sender at all
4. Skip if the comment text exactly matches our own configured reply text

Plus 15 unit tests to lock the fix in forever.

### 6. Cloudflare Worker bundle crash

After porting to Workers, the deploy failed at runtime with `fileURLToPath received undefined`. The Worker bundler imports the entire module graph at boot, so a top-level `fileURLToPath(import.meta.url)` in my config file crashed the Worker even though the function calling it was never invoked. Fix: lazy-import all Node-only modules inside the function body.

---

## Stack

- **Node 22** for the local server and CLI
- **Express 4** for the local webhook (replaceable, doesn't matter)
- **Meta Instagram Graph API v22** for everything Instagram-related
- **Notion API v2022-06-28** for reading config rows
- **Cloudflare Workers + Wrangler 4** for permanent 24/7 hosting
- **Cloudflare quick tunnels** (`cloudflared`) for local dev only
- **Node's built-in test runner** for unit tests (no Jest, no Vitest, zero test deps)

---

## Stats

- **Files written:** 13 (8 source modules, 3 test files, 2 config)
- **Lines of code:** ~750
- **Unit tests:** 15, all passing
- **Cloudflare Worker bundle size:** 8.79 KB / 2.88 KB gzipped
- **Total monthly cost:** $0 (Cloudflare free tier covers 100,000 webhook requests per day, which is approximately 100,000 more than I will ever need)

---

## Architecture (the pure-function payoff)

The handler logic is one pure function with no external dependencies. Same file runs in Node and in Cloudflare Workers without modification. This is why the Workers port took 25 minutes instead of an afternoon.

```
Comment webhook arrives
        ↓
planActions({ comment, configMap, selfIgUserId, selfIgUsername })
        ↓
returns: list of { send_comment_reply | send_private_reply, ... } actions
        ↓
dispatcher fires them
```

The dispatcher differs between local server (Express) and Worker (Cloudflare fetch handler). Everything else is shared.

---

## What it cost vs what it saved

| | Cost |
|---|---|
| ManyChat (before) | $40/mo, $480/yr |
| This system (after) | $0/mo, $0/yr |
| Build time | One evening |
| **Year-one savings** | **$480** |

---

## Reel hook options

If turning this into a reel, here are some opening lines that match different angles:

**Money angle (probably best):**
- "I cancelled my $40/mo ManyChat. Built it myself in a night."
- "$480 saved this year by deleting one SaaS subscription."

**Build-in-public angle:**
- "Day 1 of replacing every paid creator tool with something I built."
- "I asked Claude to replace my ManyChat. This is what happened."

**Tech angle (saves for a different audience):**
- "Every Instagram creator pays for this. Turns out Meta's API does it for free."
- "ManyChat is a wrapper around a Meta API anyone can use."

**Story angle (most relatable, has stakes):**
- "My bot accidentally spammed my own reel 15 times before I killed it."

---

## Overlay text moments to capture in the reel

If filming a screen-rec build-along style:

- Terminal showing `npm run ig-autodm` → tunnel URL appears
- Notion content calendar with the new DM trigger columns
- Meta dashboard with webhook URL pasted, "Verify and Save" succeeding
- Real comment arriving from a test account
- Server log: `✓ public reply sent | ✓ DM sent`
- Phone screenshot: the DM landing in the test account's inbox
- Final shot: `wrangler deploy` printing the permanent Worker URL

End card (your signature): `> deepika.builds`

---

## What's not in this build (and why)

I intentionally did not build:
- A web UI for the config (Notion IS the UI)
- Analytics on DM delivery (overengineering for personal use)
- Multi-account support (single-tenant by design)
- App Review submission for the messaging scope (not required because I only access my own account)

Each of those would have doubled the build time and replaced ManyChat with a different kind of complexity I don't want to maintain.

---

## What I would do differently

- **Catch the self-comment loop in the design phase.** I had the self-skip check but only on `from.id`. A 30-second design review would have caught that comments authored by the page itself often omit `from.id`. Cost: 15 spam comments on a real reel.
- **Read Meta's Use Cases docs more carefully before touching the dashboard.** The new model is fundamentally different from old tutorials online.

---

## The takeaway for other creators

Every "creator SaaS" paywalled feature deserves the question: is this a wrapper around a free API I could call myself?

ManyChat for $40/mo. Linktree for $5/mo. Later for $25/mo. Buffer for $15/mo. They're all gorgeous wrappers around APIs Meta, Instagram, and Twitter publish for free.

You don't need to replace all of them. But knowing you could is a different feeling than not knowing.
