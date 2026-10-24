'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { createLiveActivityPushClient } = require('../../src/hub/liveActivityPush');

test('ActivityKit push client sends an authenticated update payload', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const requests = [];
  const client = createLiveActivityPushClient({
    keyID: 'KEY123',
    teamID: 'TEAM123',
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    bundleID: 'com.example.app',
    environment: 'sandbox',
    now: () => 1_700_000_000_000,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, async json() { return {}; } };
    }
  });

  assert.equal(client.enabled, true);
  assert.deepEqual(await client.send('a'.repeat(64), { tokens: 1200 }), { sent: true });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/api\.sandbox\.push\.apple\.com\/3\/device\//);
  assert.equal(requests[0].options.headers['apns-push-type'], 'liveactivity');
  assert.equal(requests[0].options.headers['apns-topic'], 'com.example.app.push-type.liveactivity');
  assert.match(requests[0].options.headers.authorization, /^bearer [^.]+\.[^.]+\.[^.]+$/);
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.aps.event, 'update');
  assert.deepEqual(payload.aps['content-state'], { tokens: 1200 });
});

test('APNs HTTP/2 timeout destroys a stalled connection instead of hanging the push lane', async (t) => {
  const { EventEmitter } = require('node:events');
  const http2 = require('node:http2');
  const connection = new EventEmitter();
  const stream = new EventEmitter();
  let destroyed = false;
  stream.setEncoding = () => {};
  stream.end = () => {};
  connection.request = () => stream;
  connection.destroy = () => { destroyed = true; };
  t.mock.method(http2, 'connect', () => connection);
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const client = createLiveActivityPushClient({
    keyID: 'KEY', teamID: 'TEAM', privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), requestTimeoutMs: 10
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(client.send('a'.repeat(64), {}), { name: 'TimeoutError' });
    assert.equal(destroyed, true);
  } finally { clearTimeout(keepAlive); }
});

test('provider JWT stays verifiable across cache reuse and a backwards clock', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  let now = 1_700_000_000_000;
  const tokens = [];
  const client = createLiveActivityPushClient({
    keyID: 'KEY', teamID: 'TEAM', privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), now: () => now,
    fetchImpl: async (_url, options) => {
      tokens.push(options.headers.authorization.slice(7));
      return { ok: true, async json() { return {}; } };
    }
  });
  await client.send('a'.repeat(64), {});
  await client.send('a'.repeat(64), {});
  assert.equal(tokens[0], tokens[1]);
  now -= 60_000;
  await client.send('a'.repeat(64), {});
  const [header, payload, signature] = tokens[2].split('.');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iat, Math.floor(now / 1000));
  assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});

test('APNs HTTP/2 closes the connection when stream creation fails', async (t) => {
  const { EventEmitter } = require('node:events');
  const http2 = require('node:http2');
  const connection = new EventEmitter();
  let destroyed = false;
  connection.request = () => { throw new Error('stream unavailable'); };
  connection.destroy = () => { destroyed = true; };
  t.mock.method(http2, 'connect', () => connection);
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const client = createLiveActivityPushClient({
    keyID: 'KEY', teamID: 'TEAM', privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' })
  });
  await assert.rejects(client.send('a'.repeat(64), {}), /stream unavailable/);
  assert.equal(destroyed, true);
});

test('Node APNs stale-date follows source age and status while timestamp stays current', async () => {
  const { buildLiveActivityContentState } = require('../../src/shared/liveActivity');
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
  const client = createLiveActivityPushClient({
    keyID: 'KEY', teamID: 'TEAM', privateKey: pem, now: () => now,
    fetchImpl
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
