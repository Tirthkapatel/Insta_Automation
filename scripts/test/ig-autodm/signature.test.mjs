import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature } from '../../ig-autodm/signature.mjs';

const SECRET = 'super-secret-app-secret-value';

function metaSignFor(body, secret = SECRET) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

test('verifies a correctly-signed body', async () => {
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: '123', changes: [] }] });
  const sig = metaSignFor(body);
  assert.equal(await verifyMetaSignature(body, sig, SECRET), true);
});

test('rejects a tampered body', async () => {
  const original = JSON.stringify({ object: 'instagram', entry: [] });
  const sig = metaSignFor(original);
  const tampered = original.replace('instagram', 'facebook');
  assert.equal(await verifyMetaSignature(tampered, sig, SECRET), false);
});

test('rejects when signature header is missing', async () => {
  assert.equal(await verifyMetaSignature('{}', null, SECRET), false);
  assert.equal(await verifyMetaSignature('{}', undefined, SECRET), false);
  assert.equal(await verifyMetaSignature('{}', '', SECRET), false);
});

test('rejects when prefix is missing', async () => {
  const body = '{}';
  const hex = createHmac('sha256', SECRET).update(body).digest('hex');
  assert.equal(await verifyMetaSignature(body, hex, SECRET), false); // no "sha256=" prefix
});

test('rejects when app secret is missing', async () => {
  const body = '{}';
  const sig = metaSignFor(body);
  assert.equal(await verifyMetaSignature(body, sig, ''), false);
  assert.equal(await verifyMetaSignature(body, sig, undefined), false);
});

test('rejects when secrets differ', async () => {
  const body = '{}';
  const sigA = metaSignFor(body, 'secret-A');
  assert.equal(await verifyMetaSignature(body, sigA, 'secret-B'), false);
});

test('signature is hex case-insensitive', async () => {
  const body = '{}';
  const sigLower = metaSignFor(body).toLowerCase();
  const sigUpper = metaSignFor(body).toUpperCase().replace('SHA256=', 'sha256=');
  assert.equal(await verifyMetaSignature(body, sigLower, SECRET), true);
  assert.equal(await verifyMetaSignature(body, sigUpper, SECRET), true);
});
