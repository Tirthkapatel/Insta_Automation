// scripts/ig-autodm/signature.mjs
// HMAC-SHA256 verification of Meta's webhook signature.
//
// Meta signs every POST /webhook payload with HMAC-SHA256(rawBody, app_secret)
// and sends the hex digest in the `X-Hub-Signature-256` header
// (prefixed with `sha256=`). Without this check anyone who finds the Worker URL
// could forge comment events for configured media.
//
// IMPORTANT: the signature is computed over the EXACT raw body — JSON.parse +
// JSON.stringify would re-serialize and fail verification. Always read the raw
// body BEFORE parsing.
//
// Uses Web Crypto (available in Workers and Node ≥20) so this module stays
// portable across both runtimes.

export async function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return false;
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;
  const expectedHex = signatureHeader.slice(7).toLowerCase();

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const computedHex = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqualHex(computedHex, expectedHex);
}

/** Constant-time comparison of two equal-length hex strings. */
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
