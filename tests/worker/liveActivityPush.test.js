'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

test('Worker APNs signs valid ES256 JWTs and distinguishes invalid tokens from transient errors', async () => {
  const { createLiveActivityPushClient } = await import('../../worker/src/liveActivityPush.js');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const requests = [];
  let status = 200;
  const client = createLiveActivityPushClient({
    env: {
      TOKEN_MONITOR_APNS_KEY_ID: 'KEY', TOKEN_MONITOR_APNS_TEAM_ID: 'TEAM',
      TOKEN_MONITOR_APNS_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      TOKEN_MONITOR_APNS_ENVIRONMENT: 'sandbox', TOKEN_MONITOR_APNS_BUNDLE_ID: 'example.app'
    },
    now: () => 1_700_000_000_000,
    logger: { warn() {} },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: status === 200, status, async json() { return status === 410 ? { reason: 'Unregistered' } : {}; } };
    }
  });
  assert.deepEqual(await client.send('a'.repeat(64), { tokens: 123 }), { sent: true });
  const { url, options } = requests[0];
  assert.ok(options.signal instanceof AbortSignal);
  assert.match(url, /^https:\/\/api.sandbox.push.apple.com\//);
  assert.equal(options.headers['apns-topic'], 'example.app.push-type.liveactivity');
  const [header, payload, signature] = options.headers.authorization.slice(7).split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  const body = JSON.parse(options.body);
  assert.equal(body.aps.timestamp, 1_700_000_000);
  assert.deepEqual(body.aps['content-state'], { tokens: 123 });
  status = 410;
  assert.equal((await client.send('a'.repeat(64), {})).invalid, true);
  status = 503;
  assert.equal((await client.send('a'.repeat(64), {})).invalid, false);
});
test('Worker APNs stale-date follows source age and status while timestamp stays current', async () => {
  const { buildLiveActivityContentState } = require('../../worker/src/shared/liveActivity');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const now = Date.parse('2026-10-05T00:00:00Z');
  const timestamp = now / 1000;
  const reference = 978307200;
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body).aps);
    return { ok: true, async json() { return {}; } };
  };
  const { createLiveActivityPushClient } = await import('../../worker/src/liveActivityPush.js');
  const client = createLiveActivityPushClient({
    env: { TOKEN_MONITOR_APNS_KEY_ID: 'KEY', TOKEN_MONITOR_APNS_TEAM_ID: 'TEAM', TOKEN_MONITOR_APNS_PRIVATE_KEY: pem },
    now: () => now, fetchImpl
  });
  const registration = { preferences: { livePeriod: 'today' } };
  const staleSource = buildLiveActivityContentState({
    updatedAt: new Date(now).toISOString(),
    devices: [{ updatedAt: '2026-10-03T00:00:00Z', stale: true }]
  }, registration, now);
  const cases = [
    [staleSource, Date.parse('2026-10-03T00:00:00Z') / 1000 + 900],
    [{ updatedAt: timestamp - reference - 100 }, timestamp + 800],
    [{ updatedAt: timestamp - reference - 600 }, timestamp + 300],
    [{ updatedAt: timestamp - reference - 601 }, timestamp + 299],
    [{ updatedAt: timestamp - reference, sourceStale: true }, timestamp],
    [{ updatedAt: timestamp - reference + 1 }, timestamp],
    [{ updatedAt: -reference }, 900],
    [{}, timestamp],
    [{ updatedAt: null }, timestamp],
    [{ updatedAt: 'invalid' }, timestamp],
    [{ updatedAt: NaN }, timestamp],
    [{ updatedAt: Infinity }, timestamp]
  ];
  for (const [content, expected] of cases) {
    await client.send('a'.repeat(64), content);
    const aps = requests.at(-1);
    assert.equal(aps.timestamp, timestamp);
    assert.equal(aps['stale-date'], expected);
    assert.deepEqual(aps['content-state'], JSON.parse(JSON.stringify(content)));
  }
});
