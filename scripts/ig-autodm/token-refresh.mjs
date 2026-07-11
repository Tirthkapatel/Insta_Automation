// scripts/ig-autodm/token-refresh.mjs
// Auto-refresh the long-lived Instagram token. Mirrors the pattern in
// ig-insights.mjs so we don't drift.
//
// Lifecycle:
//   age <  24h  → too fresh to refresh (Meta won't let you), use as-is
//   24h ≤ age < 50d → refresh (resets to 60 days)
//   age ≥ 50d → warn loudly — refresh window expired soon

import fs from 'node:fs';

const REFRESH_BASE = 'https://graph.instagram.com';

function parseEnvFile(filepath) {
  const out = {};
  for (const line of fs.readFileSync(filepath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function saveEnv(filepath, updates) {
  const env = parseEnvFile(filepath);
  Object.assign(env, updates);
  const content = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(filepath, content, { mode: 0o600 });
}

/**
 * Ensure the long-lived token is reasonably fresh. Refreshes if 1–50 days old.
 * Returns the (possibly updated) token. Logs status via the passed `log` fn.
 */
export async function ensureTokenFresh({ envFile, currentToken, issuedAt, log = console.log }) {
  if (!issuedAt) {
    log('[token-refresh] no META_TOKEN_ISSUED_AT set, skipping refresh check');
    return currentToken;
  }
  const ageMs = Date.now() - new Date(issuedAt).getTime();
  const ageHours = ageMs / 3_600_000;
  const ageDays = ageHours / 24;

  if (ageHours < 24) {
    log(`[token-refresh] token is ${ageHours.toFixed(1)}h old — too fresh to refresh, using as-is`);
    return currentToken;
  }

  if (ageDays >= 50) {
    log(`[token-refresh] ⚠️  token is ${ageDays.toFixed(1)}d old — past the 50-day refresh window. Regenerate manually from Meta dashboard.`);
    return currentToken;
  }

  log(`[token-refresh] token is ${ageDays.toFixed(1)}d old, refreshing…`);
  // Meta's IG refresh endpoint requires access_token as a query param (no Bearer
  // support). Build the URL in a local const, never log it, and discard
  // immediately. The token never crosses the log/error path.
  const url = `${REFRESH_BASE}/refresh_access_token?grant_type=ig_refresh_token&access_token=${currentToken}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    // Intentionally do NOT include the URL or response body in the log.
    log(`[token-refresh] refresh FAILED: ${data?.error?.message || res.statusText}`);
    return currentToken;
  }
  const newToken = data.access_token;
  const issuedAtNew = new Date().toISOString();
  saveEnv(envFile, { META_LONG_TOKEN: newToken, META_TOKEN_ISSUED_AT: issuedAtNew });
  log(`[token-refresh] ✅ refreshed. New expiry: ~60 days`);
  return newToken;
}
