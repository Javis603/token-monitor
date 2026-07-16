'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HEARTBEAT_MS,
  LEASE_TTL_MS,
  siteFromUrl,
  normalizeHubUrl,
  leaseKey,
  buildLeasePayload,
  effectiveActive,
  authHeaders,
  parseLeaseResponse,
  newPendingLease
} = require('../../browser-extension/background');

test('maps only supported web origins to provider and account mapping keys', () => {
  assert.deepEqual(siteFromUrl('https://chatgpt.com/c/1'), {
    provider: 'chatgpt', mappingKey: 'chatgptCom', hostname: 'chatgpt.com'
  });
  assert.equal(siteFromUrl('https://chatgpt.com.evil.example/'), null);
  assert.equal(siteFromUrl('https://platform.openai.com/'), null);
  assert.equal(siteFromUrl('not a url'), null);
  assert.equal(siteFromUrl('https://claude.ai/new'), null);
});

test('normalizes Hub URLs without accepting executable protocols', () => {
  assert.equal(normalizeHubUrl(' http://127.0.0.1:17321/// '), 'http://127.0.0.1:17321');
  assert.equal(normalizeHubUrl('https://hub.example/base/?token=leak#part'), 'https://hub.example/base');
  assert.equal(normalizeHubUrl('javascript:alert(1)'), '');
});

test('builds conservative detector leases with stable per-tab idempotency', () => {
  const payload = buildLeasePayload({
    accountId: 'chatgpt-main', deviceId: 'browser-1', deviceName: 'Laptop', tabId: 42,
    idempotencyKey: 'browser:pending-1', fenceToken: 'client-fence-token'
  });
  assert.deepEqual(payload, {
    accountId: 'chatgpt-main',
    deviceId: 'browser-1',
    deviceName: 'Laptop',
    taskLabel: 'ChatGPT web generation',
    source: 'detector',
    confidence: 0.7,
    ttlMs: 45_000,
    idempotencyKey: 'browser:pending-1',
    fenceToken: 'client-fence-token'
  });
  assert.equal(HEARTBEAT_MS, 15_000);
  assert.equal(LEASE_TTL_MS, 45_000);
  assert.equal(leaseKey(42, 'chatgpt'), '42:chatgpt');
});

test('manual overrides take precedence over detection', () => {
  assert.equal(effectiveActive(false, 'force-on'), true);
  assert.equal(effectiveActive(true, 'force-off'), false);
  assert.equal(effectiveActive(true, undefined), true);
});

test('Bearer authentication and lease response parsing are isolated helpers', () => {
  assert.equal(authHeaders('shared').authorization, 'Bearer shared');
  assert.equal(authHeaders('').authorization, undefined);
  assert.deepEqual(parseLeaseResponse({ lease: { id: 'lease-1', fenceToken: 'fence-1' } }, 'fence-1'), {
    leaseId: 'lease-1', fenceToken: 'fence-1'
  });
  assert.throws(() => parseLeaseResponse({ lease: { id: 'lease-1' } }), /invalid lease response/);
  assert.throws(
    () => parseLeaseResponse({ lease: { id: 'lease-1', fenceToken: 'wrong' } }, 'expected'),
    /unexpected fence token/
  );
});

test('pending acquisition generates a retryable idempotency key and client fence', () => {
  const values = ['request-nonce', 'fence-part-a', 'fence-part-b'];
  const pendingLease = newPendingLease(
    { accountId: 'acct', provider: 'chatgpt', tabId: 9 },
    { randomUUID() { return values.shift(); } }
  );
  assert.deepEqual(pendingLease, {
    accountId: 'acct',
    tabId: 9,
    provider: 'chatgpt',
    idempotencyKey: 'browser:9:chatgpt:request-nonce',
    fenceToken: 'fence-part-afence-part-b'
  });
});
