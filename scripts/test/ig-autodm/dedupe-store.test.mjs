import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDedupe, dedupeKey, DEDUPE_TTL_SECONDS } from '../../ig-autodm/dedupe-store.mjs';

test('dedupeKey combines media + user', () => {
  const k = dedupeKey({ mediaId: 'm1', fromId: 'u1', fromUsername: 'alice' });
  assert.equal(k, 'sent:m1:u1');
});

test('dedupeKey falls back to username when from_id missing', () => {
  const k = dedupeKey({ mediaId: 'm1', fromId: undefined, fromUsername: 'alice' });
  assert.equal(k, 'sent:m1:alice');
});

test('dedupeKey returns null when no media or no sender', () => {
  assert.equal(dedupeKey({ mediaId: '', fromId: 'u' }), null);
  assert.equal(dedupeKey({ mediaId: 'm', fromId: '', fromUsername: '' }), null);
});

test('memory dedupe: has() is false until set()', async () => {
  const d = createMemoryDedupe();
  assert.equal(await d.has('sent:m1:u1'), false);
  await d.set('sent:m1:u1', 60);
  assert.equal(await d.has('sent:m1:u1'), true);
});

test('memory dedupe: different keys are independent', async () => {
  const d = createMemoryDedupe();
  await d.set('sent:m1:u1', 60);
  assert.equal(await d.has('sent:m1:u1'), true);
  assert.equal(await d.has('sent:m1:u2'), false); // different user
  assert.equal(await d.has('sent:m2:u1'), false); // different media
});

test('memory dedupe: expires after TTL', async () => {
  const d = createMemoryDedupe();
  await d.set('sent:m1:u1', 0.001); // 1ms TTL
  await new Promise(r => setTimeout(r, 10));
  assert.equal(await d.has('sent:m1:u1'), false);
});

test('DEDUPE_TTL_SECONDS is 30 days', () => {
  assert.equal(DEDUPE_TTL_SECONDS, 30 * 24 * 60 * 60);
});
