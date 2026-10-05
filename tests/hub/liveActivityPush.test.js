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
  assert.deepEqual(await client.send('a'.repeat(64), { primaryValue: '1.2K' }), { sent: true });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/api\.sandbox\.push\.apple\.com\/3\/device\//);
  assert.equal(requests[0].options.headers['apns-push-type'], 'liveactivity');
  assert.equal(requests[0].options.headers['apns-topic'], 'com.example.app.push-type.liveactivity');
  assert.match(requests[0].options.headers.authorization, /^bearer [^.]+\.[^.]+\.[^.]+$/);
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.aps.event, 'update');
  assert.deepEqual(payload.aps['content-state'], { primaryValue: '1.2K' });
});
