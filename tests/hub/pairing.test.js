'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');

const { createHub } = require('../../src/hub/server');

const ADMIN = 's3cret-admin';

function tempDataFile() {
  return path.join(os.tmpdir(), `tm-pair-test-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

async function startHub(options = {}) {
  const dataFile = options.dataFile || tempDataFile();
  const hub = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: ADMIN,
    dataFile,
    discovery: false,
    ...options
  });
  await hub.start();
  const { port } = hub.server.address();
  const base = `http://127.0.0.1:${port}`;
  return { hub, base, dataFile, port };
}

async function request(base, pathname, { method = 'GET', token = '', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: response.status, json };
}

async function startPairing(base, token = ADMIN) {
  const result = await request(base, '/api/pair/start', { method: 'POST', token });
  assert.equal(result.status, 200);
  return result.json;
}

function device(overrides = {}) {
  return {
    code: '000000',
    deviceId: 'android-test-1',
    deviceName: 'Pixel Test',
    platform: 'android',
    ...overrides
  };
}

test('health exposes the stable hub identity', async () => {
  const { hub, base } = await startHub();
  try {
    const health = await request(base, '/api/health');
    assert.equal(health.status, 200);
    assert.match(health.json.hubId, /^[a-f0-9]{16}$/);
    assert.equal(health.json.hubId, hub.hubId);
    assert.equal(health.json.hubName, hub.hubName);
    assert.equal(health.json.secretRequired, true);
  } finally {
    await hub.stop();
  }
});

test('hub identity survives a restart on the same data file', async () => {
  const dataFile = tempDataFile();
  const first = await startHub({ dataFile });
  const hubId = first.hub.hubId;
  const hubName = first.hub.hubName;
  await first.hub.stop();
  const second = await startHub({ dataFile });
  try {
    assert.equal(second.hub.hubId, hubId);
    assert.equal(second.hub.hubName, hubName);
  } finally {
    await second.hub.stop();
  }
});

test('pairing start requires admin and returns a single-use code and link', async () => {
  const { hub, base, port } = await startHub();
  try {
    assert.equal((await request(base, '/api/pair/start', { method: 'POST' })).status, 401);

    const session = await startPairing(base);
    assert.match(session.pairing.code, /^\d{6}$/);
    assert.equal(session.hub.id, hub.hubId);
    assert.equal(session.hub.port, port);
    assert.equal(session.pairing.hub, undefined);
    assert.ok(Date.parse(session.pairing.expiresAt) > Date.now());

    const link = new URL(session.pairing.link);
    assert.equal(link.protocol, 'tokenmonitor:');
    assert.equal(link.host, 'pair');
    assert.equal(link.searchParams.get('v'), '1');
    assert.equal(link.searchParams.get('id'), hub.hubId);
    assert.equal(link.searchParams.get('code'), session.pairing.code);
    assert.equal(link.searchParams.get('port'), String(port));
    assert.equal(link.searchParams.get('name'), hub.hubName);
    assert.doesNotMatch(session.pairing.link, /name=Mac\+/, 'spaces must be percent-encoded');

    const status = await request(base, '/api/pair/status', { token: ADMIN });
    assert.equal(status.status, 200);
    assert.deepEqual(status.json.pairing, {
      active: true,
      code: session.pairing.code,
      expiresAt: session.pairing.expiresAt
    });
  } finally {
    await hub.stop();
  }
});

test('a device cannot use admin pairing and link routes', async () => {
  const { hub, base } = await startHub();
  try {
    const session = await startPairing(base);
    const paired = await request(base, '/api/pair', {
      method: 'POST',
      body: device({ code: session.pairing.code })
    });
    assert.equal(paired.status, 200);
    assert.equal((await request(base, '/api/pair/start', { method: 'POST', token: paired.json.token })).status, 403);
    assert.equal((await request(base, '/api/links', { token: paired.json.token })).status, 403);
    assert.equal((await request(base, '/api/pair', { method: 'POST', body: device({ code: '111111' }) })).status, 404);
  } finally {
    await hub.stop();
  }
});

test('pairing rejects a wrong code, then locks after the attempt cap', async () => {
  const { hub, base } = await startHub({ pairingMaxAttempts: 3 });
  try {
    const session = await startPairing(base);
    const wrongCode = session.pairing.code === '000000' ? '000001' : '000000';
    const first = await request(base, '/api/pair', { method: 'POST', body: device({ code: wrongCode }) });
    assert.equal(first.status, 401);
    assert.equal(first.json.error, 'invalid_code');
    assert.equal(first.json.attemptsRemaining, 2);
    const second = await request(base, '/api/pair', { method: 'POST', body: device({ code: wrongCode }) });
    assert.equal(second.status, 401);
    assert.equal(second.json.attemptsRemaining, 1);
    const third = await request(base, '/api/pair', { method: 'POST', body: device({ code: wrongCode }) });
    assert.equal(third.status, 429);
    assert.equal(third.json.error, 'pairing_locked');
    // Locking dropped the session, so even the right code cannot be used.
    const after = await request(base, '/api/pair', { method: 'POST', body: device({ code: session.pairing.code }) });
    assert.equal(after.status, 404);
    assert.equal(after.json.error, 'pairing_inactive');
  } finally {
    await hub.stop();
  }
});

test('pairing rejects expired sessions and invalid bodies', async () => {
  const { hub, base } = await startHub({ pairingTtlMs: 30 });
  try {
    const session = await startPairing(base);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const expired = await request(base, '/api/pair', { method: 'POST', body: device({ code: session.pairing.code }) });
    assert.equal(expired.status, 410);
    assert.equal(expired.json.error, 'pairing_expired');
    const inactive = await request(base, '/api/pair', { method: 'POST', body: device() });
    assert.equal(inactive.status, 404);

    await startPairing(base);
    for (const bad of [
      device({ deviceId: 'bad id with space' }),
      device({ deviceName: '   ' }),
      device({ platform: 'android os' }),
      device({ code: '12x456' })
    ]) {
      const result = await request(base, '/api/pair', { method: 'POST', body: bad });
      assert.equal(result.status, 400, JSON.stringify(bad));
      assert.equal(result.json.error, 'bad_request');
    }
  } finally {
    await hub.stop();
  }
});

test('a paired device gets a read-only token and admin can list and revoke it', async () => {
  const { hub, base } = await startHub();
  try {
    const session = await startPairing(base);
    const paired = await request(base, '/api/pair', {
      method: 'POST',
      body: device({ code: session.pairing.code })
    });
    assert.equal(paired.status, 200);
    assert.match(paired.json.token, /^tmk_/);
    assert.equal(paired.json.hub.id, hub.hubId);
    assert.deepEqual(paired.json.device, { id: 'android-test-1', name: 'Pixel Test' });
    const token = paired.json.token;

    assert.equal((await request(base, '/api/stats', { token })).status, 200);
    assert.equal((await request(base, '/api/history', { token })).status, 200);
    assert.equal((await request(base, '/api/ingest', { method: 'POST', token, body: {} })).status, 403);
    assert.equal((await request(base, '/api/subscriptions', { token })).status, 403);
    assert.equal((await request(base, '/api/link', { token })).status, 200);
    assert.equal((await request(base, '/api/link', { token })).json.role, 'device');

    const links = await request(base, '/api/links', { token: ADMIN });
    assert.equal(links.status, 200);
    assert.equal(links.json.links.length, 1);
    assert.equal(links.json.links[0].id, 'android-test-1');
    assert.equal(links.json.links[0].tokenHash, undefined);

    const revoked = await request(base, '/api/links/android-test-1', { method: 'DELETE', token: ADMIN });
    assert.equal(revoked.status, 200);
    assert.equal((await request(base, '/api/stats', { token })).status, 401);
    assert.equal((await request(base, '/api/links/nope', { method: 'DELETE', token: ADMIN })).status, 404);
  } finally {
    await hub.stop();
  }
});

test('re-pairing replaces the previous token for the same device id', async () => {
  const { hub, base } = await startHub();
  try {
    const firstSession = await startPairing(base);
    const first = await request(base, '/api/pair', { method: 'POST', body: device({ code: firstSession.pairing.code }) });
    const secondSession = await startPairing(base);
    const second = await request(base, '/api/pair', { method: 'POST', body: device({ code: secondSession.pairing.code, deviceName: 'Renamed' }) });
    assert.equal(second.status, 200);
    assert.equal((await request(base, '/api/stats', { token: first.json.token })).status, 401);
    assert.equal((await request(base, '/api/stats', { token: second.json.token })).status, 200);
    const links = await request(base, '/api/links', { token: ADMIN });
    assert.equal(links.json.links.length, 1);
    assert.equal(links.json.links[0].name, 'Renamed');
  } finally {
    await hub.stop();
  }
});

test('paired links and their tokens survive a hub restart', async () => {
  const dataFile = tempDataFile();
  const first = await startHub({ dataFile });
  const session = await startPairing(first.base);
  const paired = await request(first.base, '/api/pair', {
    method: 'POST',
    body: device({ code: session.pairing.code })
  });
  assert.equal(paired.status, 200);
  await first.hub.stop();

  const second = await startHub({ dataFile });
  try {
    assert.equal((await request(second.base, '/api/link', { token: paired.json.token })).status, 200);
    const links = await request(second.base, '/api/links', { token: ADMIN });
    assert.equal(links.json.links.length, 1);
  } finally {
    await second.hub.stop();
  }
});

test('revoking a link closes its open stats stream', async () => {
  const { hub, base } = await startHub();
  try {
    const session = await startPairing(base);
    const paired = await request(base, '/api/pair', {
      method: 'POST',
      body: device({ code: session.pairing.code })
    });
    const token = paired.json.token;
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stats/stream`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);
    const revoked = await request(base, '/api/links/android-test-1', { method: 'DELETE', token: ADMIN });
    assert.equal(revoked.status, 200);
    const closed = await Promise.race([
      reader.read().then((entry) => entry.done === true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1500))
    ]);
    controller.abort();
    assert.equal(closed, true);
  } finally {
    await hub.stop();
  }
});

test('pairing session can be inspected and cancelled by an admin', async () => {
  const { hub, base } = await startHub();
  try {
    assert.deepEqual((await request(base, '/api/pair/status', { token: ADMIN })).json.pairing, { active: false });
    const session = await startPairing(base);
    const cancelled = await request(base, '/api/pair/cancel', { method: 'POST', token: ADMIN });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.cancelled, true);
    assert.deepEqual((await request(base, '/api/pair/status', { token: ADMIN })).json.pairing, { active: false });
    const after = await request(base, '/api/pair', { method: 'POST', body: device({ code: session.pairing.code }) });
    assert.equal(after.status, 404);
    assert.equal((await request(base, '/api/pair/cancel', { method: 'POST', token: ADMIN })).json.cancelled, false);
  } finally {
    await hub.stop();
  }
});
