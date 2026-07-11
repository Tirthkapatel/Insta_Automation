// scripts/ig-autodm/config.mjs
// Constants + env loader for Node entry points. Top-level is Worker-safe
// (no Node-only APIs run at module load) — loadConfig() lazy-imports fs/path
// so this file stays bundleable for Cloudflare Workers.

export const GRAPH_VERSION = 'v22.0';
export const GRAPH_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;
export const NOTION_API = 'https://api.notion.com/v1';

const REQUIRED = [
  'META_LONG_TOKEN',
  'META_APP_SECRET',
  'META_IG_USER_ID',
  'META_IG_USERNAME',
  'META_WEBHOOK_VERIFY_TOKEN',
  'NOTION_API_KEY',
  'NOTION_CONTENT_DB_ID',
  'NOTION_ACTIVITY_LOG_DB_ID',
];

export async function loadConfig({ envFile } = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const PROJECT_ROOT = path.resolve(__dirname, '../..');
  const ENV_FILE = envFile || process.env.IG_AUTODM_ENV_FILE || path.join(PROJECT_ROOT, '.env');

  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`Missing env file: ${ENV_FILE}\nCopy .env.example to .env and fill in your values.`);
  }
  const env = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  // Real process env overrides file values (useful in CI).
  for (const k of Object.keys(process.env)) {
    if (/^(META_|NOTION_|IG_)/.test(k)) env[k] = process.env[k];
  }
  for (const key of REQUIRED) {
    if (!env[key]) throw new Error(`${key} missing in ${ENV_FILE}`);
  }
  return {
    ...env,
    PORT: parseInt(env.IG_AUTODM_PORT || '8787', 10),
    GRAPH_VERSION,
    GRAPH_BASE,
    NOTION_API,
    ENV_FILE,
    PROJECT_ROOT,
  };
}
