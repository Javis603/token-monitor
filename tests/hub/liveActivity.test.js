'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHub } = require('../../src/hub/server');

function tempDataFile() {
  return path.join(os.tmpdir(), `tm-live-activity-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

test('Hub registers a Live Activity and pushes the latest state after ingest', async () => {
  const dataFile = tempDataFile();
  const pushes = [];
  const hub = createHub({
    dataFile,
    logger: { error() {}, warn() {} },
    apns: {
      enabled: true,
      minIntervalMs: 0,
      async send(token, state) {
        pushes.push({ token, state });
        return { sent: true };
      }
    }
  });
  try {
    hub.registerLiveActivity({
      activityID: 'activity-1',
      token: 'b'.repeat(64),
      locale: 'en-US',
      preferences: {
        liveActivityEnabled: true,
        livePrimaryMetric: 'tokens',
        livePeriod: 'today',
        liveShowsSecondaryMetric: false,
        liveShowsProgress: false
      }
    });
    hub.ingest({
      deviceId: 'device-1',
      periods: {
        today: { totalTokens: 1200, costUsd: 0.25, models: { 'gpt-5': 1200 } }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].token, 'b'.repeat(64));
    assert.equal(pushes[0].state.primaryValue, '1.2K');
    assert.equal(hub.unregisterLiveActivity('activity-1'), true);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

async function waitFor(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('timed out waiting for push');
}

function registration(activityID, token = 'a'.repeat(64)) {
  return { activityID, token, preferences: { livePeriod: 'today' } };
}

test('Hub serializes pushes, coalesces latest state and preserves a replacement token', async () => {
  const dataFile = tempDataFile();
  const pushes = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const hub = createHub({ dataFile, logger: { warn() {} }, apns: {
    enabled: true, minIntervalMs: 0,
    async send(token, state) {
      pushes.push({ token, state });
      return pushes.length === 1 ? pending : { sent: true };
    }
  } });
  try {
    hub.registerLiveActivity(registration('activity'));
    await waitFor(() => pushes.length === 1);
    hub.registerLiveActivity(registration('activity', 'b'.repeat(64)));
    hub.ingest({ deviceId: 'device', periods: { today: { totalTokens: 100 } } });
    hub.ingest({ deviceId: 'device', periods: { today: { totalTokens: 200 } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pushes.length, 1, 'no concurrent batches while APNs is pending');
    release({ invalid: true });
    await waitFor(() => pushes.length === 2);
    assert.equal(pushes[1].token, 'b'.repeat(64));
    assert.equal(pushes[1].state.tokensValue, '200');
    assert.equal(JSON.parse(fs.readFileSync(dataFile)).liveActivities.activity.token, 'b'.repeat(64));
  } finally {
    release({ sent: true });
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('Hub stop cancels follow-up work from an in-flight push', async () => {
  const dataFile = tempDataFile();
  let pushes = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const hub = createHub({ dataFile, apns: {
    enabled: true, minIntervalMs: 0,
    async send() { pushes += 1; return pending; }
  } });
  try {
    hub.registerLiveActivity(registration('activity'));
    await waitFor(() => pushes === 1);
    hub.ingest({ deviceId: 'device' });
    await hub.stop();
    release({ invalid: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pushes, 1);
    assert.ok(JSON.parse(fs.readFileSync(dataFile)).liveActivities.activity, 'late results do not mutate stopped hub');
  } finally {
    release({ sent: true });
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('one failed target does not prevent invalid token cleanup for other targets', async () => {
  const dataFile = tempDataFile();
  let calls = 0;
  const hub = createHub({ dataFile, logger: { warn() {} }, apns: {
    enabled: true, minIntervalMs: 0,
    async send(token) {
      calls += 1;
      if (token.startsWith('a')) throw new Error('offline');
      return { invalid: true };
    }
  } });
  try {
    hub.registerLiveActivity(registration('offline'));
    hub.registerLiveActivity(registration('invalid', 'b'.repeat(64)));
    await waitFor(() => calls === 2 && !JSON.parse(fs.readFileSync(dataFile)).liveActivities.invalid);
    assert.ok(JSON.parse(fs.readFileSync(dataFile)).liveActivities.offline);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('registration API enforces auth, validates JSON and never exposes tokens in stats', async () => {
  const dataFile = tempDataFile();
  const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'secret', dataFile, apns: { enabled: false } });
  try {
    await hub.start();
    const url = `http://127.0.0.1:${hub.server.address().port}`;
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    assert.equal((await fetch(`${url}/api/live-activities/register`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${url}/api/live-activities/register`, { method: 'POST', headers, body: '{' })).status, 400);
    const response = await fetch(`${url}/api/live-activities/register`, { method: 'POST', headers, body: JSON.stringify(registration('activity')) });
    assert.deepEqual(await response.json(), { ok: true, activityID: 'activity', pushEnabled: false });
    assert.equal((await (await fetch(`${url}/api/health`)).json()).liveActivityPushEnabled, false);
    const stats = await (await fetch(`${url}/api/stats`, { headers })).text();
    assert.ok(!stats.includes('a'.repeat(64)));
    assert.ok(!stats.includes('liveActivities'));
    const abort = new AbortController();
    const stream = await fetch(`${url}/api/stats/stream`, { headers, signal: abort.signal });
    const reader = stream.body.getReader();
    try {
      const frame = new TextDecoder().decode((await reader.read()).value);
      assert.match(frame, /event: snapshot/);
      assert.ok(!frame.includes('a'.repeat(64)));
      assert.ok(!frame.includes('liveActivities'));
    } finally {
      abort.abort();
      await reader.cancel().catch(() => {});
    }
    assert.equal((await fetch(`${url}/api/live-activities/activity`, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${url}/api/live-activities/%ZZ`, { method: 'DELETE', headers })).status, 400);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('Hub cooldown sends only the latest snapshot and cancels deleted or stopped targets', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  const dataFile = tempDataFile();
  const pushes = [];
  const hub = createHub({ dataFile, apns: {
    enabled: true, minIntervalMs: 200,
    async send(token, state) { pushes.push({ token, state }); return { sent: true }; }
  } });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    hub.registerLiveActivity(registration('activity'));
    t.mock.timers.tick(0);
    await flush();
    assert.equal(pushes.length, 1);
    hub.ingest({ deviceId: 'device', periods: { today: { totalTokens: 100 } } });
    t.mock.timers.tick(100);
    hub.ingest({ deviceId: 'device', periods: { today: { totalTokens: 500 } } });
    t.mock.timers.tick(99);
    assert.equal(pushes.length, 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].state.tokensValue, '500');

    hub.ingest({ deviceId: 'device', periods: { today: { totalTokens: 600 } } });
    hub.unregisterLiveActivity('activity');
    t.mock.timers.tick(200);
    await flush();
    assert.equal(pushes.length, 2, 'unregistered targets are not sent from an old timer');
    hub.registerLiveActivity(registration('activity'));
    await hub.stop();
    t.mock.timers.tick(200);
    await flush();
    assert.equal(pushes.length, 2, 'stop cancels a queued batch');
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});

test('Hub reloads private registrations and retries a failed target after the next update', async () => {
  const dataFile = tempDataFile();
  const original = createHub({ dataFile, apns: { enabled: false } });
  original.registerLiveActivity(registration('activity'));
  await original.stop();
  let calls = 0;
  const hub = createHub({ dataFile, logger: { warn() {} }, apns: {
    enabled: true, minIntervalMs: 0,
    async send() { calls += 1; if (calls === 1) throw new Error('offline'); return { sent: true }; }
  } });
  try {
    hub.ingest({ deviceId: 'device' });
    await waitFor(() => calls === 1);
    assert.ok(JSON.parse(fs.readFileSync(dataFile)).liveActivities.activity);
    hub.deleteDevice('device');
    await waitFor(() => calls === 2);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
});
