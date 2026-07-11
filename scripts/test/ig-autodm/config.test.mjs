import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../ig-autodm/config.mjs';

function makeFakeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-autodm-test-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, [
    'META_LONG_TOKEN=fake_token_value',
    'META_APP_SECRET=fake_app_secret',
    'META_IG_USER_ID=12345',
    'META_IG_USERNAME=test.user',
    'META_WEBHOOK_VERIFY_TOKEN=fake_verify_token',
    'NOTION_API_KEY=fake_notion_key',
    'NOTION_CONTENT_DB_ID=fake_content_db_id',
    'NOTION_ACTIVITY_LOG_DB_ID=fake_log_db_id',
  ].join('\n'));
  return envFile;
}

test('loadConfig returns all required keys', async () => {
  const envFile = makeFakeEnv();
  const cfg = await loadConfig({ envFile });
  assert.equal(cfg.META_LONG_TOKEN, 'fake_token_value');
  assert.equal(cfg.META_IG_USER_ID, '12345');
  assert.equal(cfg.META_IG_USERNAME, 'test.user');
  assert.equal(cfg.NOTION_API_KEY, 'fake_notion_key');
  assert.equal(cfg.NOTION_CONTENT_DB_ID, 'fake_content_db_id');
  assert.equal(cfg.NOTION_ACTIVITY_LOG_DB_ID, 'fake_log_db_id');
  assert.equal(cfg.GRAPH_VERSION, 'v22.0');
  assert.equal(typeof cfg.PORT, 'number');
});

test('loadConfig throws if a required key is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-autodm-test-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'META_LONG_TOKEN=only_one\n');
  await assert.rejects(() => loadConfig({ envFile }), /missing/);
});
