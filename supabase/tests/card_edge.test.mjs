import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createCardHandler } from '../functions/_shared/card-api.ts';

const signingKey = 'ef'.repeat(32);
const deviceKey = Buffer.alloc(32, 29).toString('base64url');
const keyHash = createHash('sha256').update(deviceKey).digest('hex');
const card = '11111111-1111-4111-8111-111111111111';
const otherCard = '11111111-1111-4111-8111-111111111112';
const requestId = '33333333-3333-4333-8333-333333333333';
const signature = createHmac('sha256', Buffer.from(signingKey, 'hex')).update('v1.' + card).digest('base64url');
const payload = 'v1.' + card + '.' + signature;

function request(body, key = deviceKey) {
  return new Request('https://example.invalid/functions/v1/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Drink-Pass-Device-Key': key },
    body: JSON.stringify(body),
  });
}

test('lookup verifies the signed card ID and calls only the read-only RPC', async () => {
  const handler = createCardHandler('lookup', signingKey, async (name, params) => {
    assert.equal(name, 'drink_pass_card_lookup');
    assert.deepEqual(params, { p_card: card, p_key_hash: keyHash });
    return { status: 'eligible', name: 'Test Guest' };
  });
  const response = await handler(request({ qr: payload }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'eligible', name: 'Test Guest' });
});

test('tampered, wrongly signed and unsupported QR codes never reach the RPC as verified IDs', async () => {
  const badQrs = [
    payload.replace(card, otherCard),
    'v1.' + card + '.' + Buffer.alloc(32).toString('base64url'),
    payload.replace('v1.', 'v2.'),
  ];
  const handler = createCardHandler('redeem', signingKey, async (name, params) => {
    assert.equal(name, 'drink_pass_card_redeem');
    assert.deepEqual(params, { p_card: null, p_key_hash: keyHash, p_request: requestId });
    return { status: 'invalid_signature' };
  });
  for (const qr of badQrs) {
    const response = await handler(request({ qr, requestId }));
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { status: 'invalid_signature' });
  }
});

test('redeem forwards a stable request ID and returns the database outcome', async () => {
  const handler = createCardHandler('redeem', signingKey, async (name, params) => {
    assert.equal(name, 'drink_pass_card_redeem');
    assert.deepEqual(params, { p_card: card, p_key_hash: keyHash, p_request: requestId });
    return { status: 'already_redeemed' };
  });
  const response = await handler(request({ qr: payload, requestId }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { status: 'already_redeemed' });
});

test('malformed requests never call the database and infrastructure failures are retryable', async () => {
  let calls = 0;
  const handler = createCardHandler('redeem', signingKey, async () => {
    calls += 1;
    throw new Error('backend unavailable');
  });
  assert.equal((await handler(request({ qr: payload }))).status, 400);
  assert.equal((await handler(request({ qr: payload }, ''))).status, 401);
  assert.equal((await handler(new Request('https://example.invalid'))).status, 405);
  assert.equal(calls, 0);
  const unavailable = await handler(request({ qr: payload, requestId }));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { status: 'service_unavailable' });
});
