// scripts/ig-autodm/dedupe-store.mjs
// Tracks which users we've already DMed for each media, so a single user
// commenting multiple times on the same reel only triggers the automation once.
//
// Two implementations share the same interface:
//   has(key)            -> boolean
//   set(key, ttlSec)    -> void
//
// Worker uses Cloudflare KV directly via env.DEDUPE_KV (see worker index.mjs).
// Local server uses createMemoryDedupe — in-memory only, lost on restart,
// which is fine because local is dev/fallback only now.

export function dedupeKey({ mediaId, fromId, fromUsername }) {
  const who = fromId || fromUsername;
  if (!mediaId || !who) return null;
  return `sent:${mediaId}:${who}`;
}

/** In-memory dedupe store. Use for local dev. */
export function createMemoryDedupe() {
  /** @type {Map<string, number>} key -> expiry unix ms */
  const store = new Map();
  return {
    async has(key) {
      const exp = store.get(key);
      if (!exp) return false;
      if (Date.now() > exp) {
        store.delete(key);
        return false;
      }
      return true;
    },
    async set(key, ttlSeconds) {
      store.set(key, Date.now() + ttlSeconds * 1000);
    },
    // for tests / debug
    _size: () => store.size,
  };
}

/** Wrap a Cloudflare KV namespace in the dedupe interface. */
export function createKvDedupe(kvNamespace) {
  return {
    async has(key) {
      const v = await kvNamespace.get(key);
      return v !== null;
    },
    async set(key, ttlSeconds) {
      await kvNamespace.put(key, '1', { expirationTtl: ttlSeconds });
    },
  };
}

export const DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
