'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createHub, resolveBindHost } = require('../../src/hub/server');
const { codexAccountKey } = require('../../src/shared/codexAuth');

function tempDataFile() {
  return path.join(os.tmpdir(), `tm-hub-test-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

test('resolveBindHost keeps the requested host when a secret is set', () => {
  assert.equal(resolveBindHost('0.0.0.0', 's3cret'), '0.0.0.0');
  assert.equal(resolveBindHost('192.168.1.10', 's3cret'), '192.168.1.10');
});

test('resolveBindHost forces localhost when no secret and a non-loopback host is requested', () => {
  assert.equal(resolveBindHost('0.0.0.0', ''), '127.0.0.1');
  assert.equal(resolveBindHost('192.168.1.10', ''), '127.0.0.1');
  assert.equal(resolveBindHost('', ''), '127.0.0.1');
});

test('resolveBindHost leaves an already-loopback host unchanged without a secret', () => {
  assert.equal(resolveBindHost('127.0.0.1', ''), '127.0.0.1');
  assert.equal(resolveBindHost('localhost', ''), 'localhost');
  assert.equal(resolveBindHost('::1', ''), '::1');
});

test('a hub without a secret binds to localhost only even when asked to bind every interface', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '0.0.0.0', secret: '', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    assert.equal(hub.bindHost, '127.0.0.1');
    assert.equal(hub.server.address().address, '127.0.0.1');
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('health exposes the Node Hub build identity without authentication', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const health = await response.json();
    assert.equal(response.status, 200);
    assert.equal(health.runtime, 'node-hub');
    assert.equal(health.hubBuild.runtime, 'node-hub');
    assert.match(health.hubBuild.coreBuildId, /^sha256:[a-f0-9]{64}$/);
    assert.match(health.hubBuild.runtimeBuildId, /^sha256:[a-f0-9]{64}$/);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('ingest inserts a device and is visible in getStats', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  try {
    const record = hub.ingest({ deviceId: 'dev-a', today: { totalTokens: 5, costUsd: 0.1 } });
    assert.equal(record.deviceId, 'dev-a');
    assert.equal(hub.getStats().devices.length, 1);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('getStats exposes the effective staleness threshold', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', staleAfterMs: 123456, dataFile, logger: { error() {} } });
  try {
    assert.equal(hub.getStats().staleAfterMs, 123456);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('Hub keeps same-email Codex Personal and Team workspaces distinct across devices', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', staleAfterMs: 0, dataFile, logger: { error() {} } });
  const email = 'member@example.com';
  const personalKey = codexAccountKey(email, 'workspace-personal');
  const teamKey = codexAccountKey(email, 'workspace-team');
  const provider = (accountKey, remainingPercent, updatedAt) => ({
    provider: 'codex',
    accountKey,
    accountEmail: email,
    status: 'ok',
    source: 'rpc',
    sourceDetail: 'managed',
    updatedAt,
    windows: [{ kind: 'weekly', usedPercent: 100 - remainingPercent, remainingPercent }]
  });
  try {
    hub.ingest({
      deviceId: 'macbook',
      limits: {
        updatedAt: '2026-07-24T10:01:00.000Z',
        providers: [
          provider(personalKey, 18, '2026-07-24T10:00:00.000Z'),
          provider(teamKey, 72, '2026-07-24T10:01:00.000Z')
        ]
      }
    });
    hub.ingest({
      deviceId: 'desktop',
      limits: {
        updatedAt: '2026-07-24T10:05:00.000Z',
        providers: [
          provider(personalKey, 48, '2026-07-24T10:04:00.000Z'),
          provider(teamKey, 82, '2026-07-24T10:05:00.000Z')
        ]
      }
    });

    const codexProviders = hub.getStats().limits.providers.filter((entry) => entry.provider === 'codex');
    assert.equal(codexProviders.length, 2);
    assert.deepEqual(
      new Set(codexProviders.map((entry) => entry.accountKey)),
      new Set([personalKey, teamKey])
    );
    assert.equal(
      codexProviders.find((entry) => entry.accountKey === personalKey).windows[0].remainingPercent,
      48
    );
    assert.equal(
      codexProviders.find((entry) => entry.accountKey === teamKey).windows[0].remainingPercent,
      82
    );
    assert.ok(codexProviders.every((entry) => entry.sourceDeviceId === 'desktop'));
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('ingest without a deviceId throws', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  try {
    assert.throws(() => hub.ingest({ today: { totalTokens: 1 } }), /deviceId/);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('onStats fires on ingest and on deleteDevice, and unsubscribe stops it', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  try {
    let calls = 0;
    let lastDeviceCount = -1;
    const unsub = hub.onStats((stats) => { calls += 1; lastDeviceCount = stats.devices.length; });
    hub.ingest({ deviceId: 'dev-a', today: { totalTokens: 5 } });
    assert.equal(calls, 1);
    assert.equal(lastDeviceCount, 1);
    hub.deleteDevice('dev-a');
    assert.equal(calls, 2);
    assert.equal(lastDeviceCount, 0);
    unsub();
    hub.ingest({ deviceId: 'dev-b', today: { totalTokens: 1 } });
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('a subscription write is announced on the stats stream, carrying the new version', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  try {
    const record = { id: 'sub_1', provider: 'codex', planName: 'Plus', amountMinor: 9000, currency: 'HKD', startDate: '2026-05-31' };
    // A hub nobody has written to reports an empty version rather than omitting
    // the field, so a device holding nothing compares equal and asks for nothing.
    assert.equal(hub.getStats().subscriptionsUpdatedAt, '');

    const seen = [];
    hub.onStats((stats, reason) => seen.push({ reason, version: stats.subscriptionsUpdatedAt }));
    const written = hub.setSubscriptions([record], '');

    // Without the broadcast the other devices only find out on their next poll,
    // which is five minutes apart while the stream is up.
    assert.deepEqual(seen, [{ reason: 'subscriptions', version: written.updatedAt }]);
    assert.equal(hub.getStats().subscriptionsUpdatedAt, written.updatedAt);

    // The records themselves stay off the stats frame: the version is all a
    // device needs to tell its copy has been overtaken.
    assert.equal('subscriptions' in hub.getStats(), false);

    // A refused write moves nothing, so there is nothing to announce.
    assert.throws(() => hub.setSubscriptions([], 'not-the-version'));
    assert.equal(seen.length, 1);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('oversized ingest returns 413 without storing the device', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'oversized', padding: '🚀'.repeat(270_000) })
    });

    assert.equal(response.status, 413);
    assert.equal(response.headers.get('connection'), 'close');
    assert.deepEqual(await response.json(), {
      error: 'payload_too_large',
      message: 'Request body too large'
    });
    assert.equal(hub.getStats().devices.length, 0);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('ingest accepts payloads above the legacy 256 KiB limit', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: '', dataFile, logger: { error() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'larger', padding: 'x'.repeat(300 * 1024) })
    });

    assert.equal(response.status, 200);
    assert.equal(hub.getStats().devices.length, 1);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('the hub stores one shared subscription list, not one per device', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const call = (method, body) => fetch(`http://127.0.0.1:${port}/api/subscriptions`, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer shh' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });

    // A hub nobody has written to reports an empty updatedAt, which is what lets
    // the very first write through the staleness check.
    const empty = await (await call('GET')).json();
    assert.deepEqual(empty.subscriptions, []);
    assert.equal(empty.updatedAt, '');

    const record = { id: 'sub_1', provider: 'codex', planName: 'Plus', amountMinor: 9000, currency: 'HKD', startDate: '2026-05-31' };
    const written = await (await call('PUT', { subscriptions: [record], baseUpdatedAt: '' })).json();
    assert.equal(written.subscriptions.length, 1);
    assert.equal(written.subscriptions[0].id, 'sub_1');
    assert.notEqual(written.updatedAt, '');

    // Every device reads the same list back — it belongs to the account, not to
    // whichever machine happened to record it.
    const read = await (await call('GET')).json();
    assert.deepEqual(read.subscriptions, written.subscriptions);

    // A device writing from a stale copy would erase records added elsewhere
    // since it last looked, and they exist nowhere else.
    const stale = await call('PUT', { subscriptions: [], baseUpdatedAt: '' });
    assert.equal(stale.status, 409);
    const conflict = await stale.json();
    assert.equal(conflict.error, 'stale_write');
    assert.equal(conflict.subscriptions.length, 1);
    assert.deepEqual((await (await call('GET')).json()).subscriptions, written.subscriptions);

    // Writing from the copy it just read through does go in, including a delete.
    const cleared = await (await call('PUT', { subscriptions: [], baseUpdatedAt: written.updatedAt })).json();
    assert.deepEqual(cleared.subscriptions, []);

    // Malformed records are discarded rather than stored: this arrives over the
    // network from another device.
    const junk = await (await call('PUT', { subscriptions: [{ provider: '' }, 'nope', record], baseUpdatedAt: cleared.updatedAt })).json();
    assert.equal(junk.subscriptions.length, 1);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('the shared subscription list survives a hub restart and needs the secret', async () => {
  const dataFile = tempDataFile();
  const record = { id: 'sub_1', provider: 'claude', planName: 'Pro', amountMinor: 14600, currency: 'HKD', startDate: '2026-07-19' };
  const first = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await first.start();
  try {
    first.setSubscriptions([record], '');
  } finally {
    await first.stop();
  }

  const second = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await second.start();
  try {
    assert.equal(second.getSubscriptions().subscriptions[0].id, 'sub_1');
    const { port } = second.server.address();
    // Money the user recorded by hand is behind the same gate as account identity.
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/subscriptions`);
    assert.equal(unauthorized.status, 401);
    const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { authorization: 'Bearer shh' } })).json();
    // The version rides along, so a device can tell its copy has been overtaken
    // without asking. What the user pays does not.
    assert.equal(stats.subscriptionsUpdatedAt, second.getSubscriptions().updatedAt);
    assert.equal('subscriptions' in stats, false);
    assert.doesNotMatch(JSON.stringify(stats), /amountMinor|planName|sub_1/);
  } finally {
    await second.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('a malformed subscription write is refused instead of emptying the ledger', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const put = (body) => fetch(`http://127.0.0.1:${port}/api/subscriptions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer shh' },
      body: JSON.stringify(body)
    });
    const record = { id: 'sub_1', provider: 'codex', planName: 'Plus', amountMinor: 9000, currency: 'HKD', startDate: '2026-05-31' };
    const written = await (await put({ subscriptions: [record], baseUpdatedAt: '' })).json();

    // A non-array normalizes to [] and would store as a perfectly successful
    // replacement, wiping records that exist nowhere else.
    for (const bad of [undefined, null, 'oops', 42, { 0: record }]) {
      const response = await put({ subscriptions: bad, baseUpdatedAt: written.updatedAt });
      assert.equal(response.status, 400, `subscriptions: ${JSON.stringify(bad)} should be refused`);
    }
    assert.equal(hub.getSubscriptions().subscriptions.length, 1);

    // An intentional clear still goes through.
    assert.equal((await (await put({ subscriptions: [], baseUpdatedAt: written.updatedAt })).json()).subscriptions.length, 0);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('the hub advertises PUT so a browser preflight does not block the write', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    // The endpoint existing is not enough: a browser-origin client is stopped at
    // the preflight if the method is not advertised.
    const preflight = await fetch(`http://127.0.0.1:${port}/api/subscriptions`, { method: 'OPTIONS' });
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /\bPUT\b/);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('back-to-back writes each get their own concurrency token', () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  try {
    const record = (id) => ({ id, provider: 'codex', startDate: '2026-05-31' });
    const first = hub.setSubscriptions([record('a')], '');
    const second = hub.setSubscriptions([record('a'), record('b')], first.updatedAt);
    // Same millisecond is entirely possible here; if the token repeated, a third
    // write holding `first` would sail through and drop record b.
    assert.ok(second.updatedAt > first.updatedAt);
    assert.throws(() => hub.setSubscriptions([], first.updatedAt), /stale_write/);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('a subscription write that cannot reach disk does not take effect in memory', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  try {
    const record = (id) => ({ id, provider: 'codex', startDate: '2026-05-31', currency: 'USD' });
    const written = hub.setSubscriptions([record('a')], '');

    // A directory where the temp file belongs makes the atomic write fail. If
    // memory moved anyway, this process would serve a record the file does not
    // have and a restart would silently revert it.
    fs.mkdirSync(`${dataFile}.tmp`, { recursive: true });
    try {
      assert.throws(() => hub.setSubscriptions([record('a'), record('b')], written.updatedAt));
    } finally {
      fs.rmSync(`${dataFile}.tmp`, { recursive: true, force: true });
    }
    assert.deepEqual(hub.getSubscriptions().subscriptions.map((entry) => entry.id), ['a']);
    assert.equal(hub.getSubscriptions().updatedAt, written.updatedAt);
    // And the file still agrees, so a restart lands on the same list.
    assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')).subscriptions.subscriptions.map((e) => e.id), ['a']);
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('a currency the app carries no rate for is refused, not rewritten', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'shh', dataFile, logger: { error() {}, warn() {} } });
  await hub.start();
  try {
    const { port } = hub.server.address();
    const put = (body) => fetch(`http://127.0.0.1:${port}/api/subscriptions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer shh' },
      body: JSON.stringify(body)
    });
    // Coercing EUR to USD reports an amount the user never entered, and the
    // endpoint documents this as validation.
    const refused = await put({
      subscriptions: [{ id: 'a', provider: 'codex', startDate: '2026-05-31', amountMinor: 10000, currency: 'EUR' }],
      baseUpdatedAt: ''
    });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).message, /EUR/);
    assert.deepEqual(hub.getSubscriptions().subscriptions, []);

    for (const code of ['USD', 'TWD', 'HKD', 'CNY']) {
      const ok = await put({
        subscriptions: [{ id: 'a', provider: 'codex', startDate: '2026-05-31', currency: code }],
        baseUpdatedAt: hub.getSubscriptions().updatedAt
      });
      assert.equal(ok.status, 200, `${code} should be accepted`);
    }
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});
