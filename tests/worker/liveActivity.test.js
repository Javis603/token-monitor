'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

test('Worker stores and removes authenticated ActivityKit registrations', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const entries = new Map();
  const storage = {
    async get(key) { return entries.get(key); },
    async list({ prefix }) {
      return new Map(Array.from(entries.entries()).filter(([key]) => key.startsWith(prefix)));
    },
    async put(key, value) { entries.set(key, value); },
    async delete(key) { entries.delete(key); }
  };
  const hub = new worker.HubDO({ storage }, { TOKEN_MONITOR_SECRET: 'secret' });
  const payload = {
    activityID: 'activity-1',
    token: 'c'.repeat(64),
    locale: 'en-US',
    preferences: { liveActivityEnabled: true }
  };
  const headers = {
    authorization: 'Bearer secret',
    'content-type': 'application/json'
  };

  const register = await hub.fetch(new Request(
    'https://example.com/api/live-activities/register',
    { method: 'POST', headers, body: JSON.stringify(payload) }
  ));
  assert.equal(register.status, 200);
  assert.deepEqual(await register.json(), {
    ok: true,
    activityID: 'activity-1',
    pushEnabled: false
  });
  assert.equal(entries.has('activity:activity-1'), true);

  const remove = await hub.fetch(new Request(
    'https://example.com/api/live-activities/activity-1',
    { method: 'DELETE', headers }
  ));
  assert.equal(remove.status, 200);
  assert.equal(entries.has('activity:activity-1'), false);
});

async function makeHub() {
  const { HubDO } = await import('../../worker/src/index.js');
  const entries = new Map();
  const kept = [];
  const state = {
    storage: {
      async get(key) { return structuredClone(entries.get(key)); },
      async put(key, value) { entries.set(key, structuredClone(value)); },
      async delete(key) { entries.delete(key); },
      async list({ prefix }) { return new Map([...entries].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); }
    },
    async blockConcurrencyWhile(fn) { return fn(); },
    waitUntil(promise) { kept.push(promise); }
  };
  const hub = new HubDO(state, { TOKEN_MONITOR_SECRET: 'secret', TOKEN_MONITOR_APNS_MIN_INTERVAL_MS: '0', PUBLIC_STATS_ENABLED: 'true' });
  await hub.ready;
  return { hub, entries, kept };
}

function registerInput(token = 'a'.repeat(64)) {
  return { activityID: 'activity', token, preferences: { livePeriod: 'today' } };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('timed out waiting for push');
}

function request(route, method = 'GET', payload) {
  return new Request(`https://hub.example${route}`, {
    method, headers: { authorization: 'Bearer secret', 'content-type': 'application/json', 'x-token-monitor-response': 'minimal' },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
}

test('Worker holds coalesced push lifetime, serializes batches and preserves replaced tokens', async () => {
  const { hub, entries, kept } = await makeHub();
  const pushes = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  hub.apns = { enabled: true, async send(token, state) {
    pushes.push({ token, state });
    return pushes.length === 1 ? pending : { sent: true };
  } };
  try {
    await hub.registerLiveActivity(registerInput());
    await waitFor(() => pushes.length === 1);
    let settled = false;
    kept[0].then(() => { settled = true; });
    await hub.registerLiveActivity(registerInput('b'.repeat(64)));
    const response = await hub.fetch(request('/api/ingest', 'POST', { deviceId: 'device', periods: { today: { totalTokens: 123 } } }));
    assert.equal(response.status, 200);
    await hub.fetch(request('/api/ingest', 'POST', { deviceId: 'device', periods: { today: { totalTokens: 456 } } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pushes.length, 1);
    assert.equal(settled, false, 'waitUntil includes the actual send, not only its timer');
    release({ invalid: true });
    await waitFor(() => pushes.length === 2);
    await Promise.all(kept);
    assert.equal(pushes[1].state.tokensValue, '456');
    assert.equal(pushes[1].token, 'b'.repeat(64));
    assert.equal(entries.get('activity:activity').token, 'b'.repeat(64));
    await hub.fetch(request('/api/devices/device', 'DELETE'));
    await waitFor(() => pushes.length === 3);
    assert.equal(pushes[2].state.tokensValue, '0');
  } finally {
    release({ sent: true });
    await Promise.all(kept);
  }
});

test('Worker isolates transport failures from invalid token cleanup', async (t) => {
  const { hub, entries } = await makeHub();
  await hub.registerLiveActivity(registerInput());
  await hub.registerLiveActivity({ ...registerInput('b'.repeat(64)), activityID: 'invalid' });
  t.mock.method(console, 'warn', () => {});
  hub.apns = { enabled: true, async send(token) {
    if (token.startsWith('a')) throw new Error('offline');
    return { invalid: true };
  } };
  await hub.pushLiveActivityStats(await hub.getStats());
  assert.ok(entries.has('activity:activity'));
  assert.ok(!entries.has('activity:invalid'));
});

test('Worker registration stays private and requires the configured secret', async () => {
  const { hub } = await makeHub();
  const anonymous = await hub.fetch(new Request('https://hub.example/api/live-activities/register', { method: 'POST', body: '{}' }));
  assert.equal(anonymous.status, 401);
  const invalid = await hub.fetch(request('/api/live-activities/register', 'POST', { ...registerInput(), activityID: 'bad/id' }));
  assert.equal(invalid.status, 400);
  await hub.registerLiveActivity(registerInput());
  for (const route of ['/api/stats', '/api/public/stats', '/api/devices', '/api/health']) {
    const text = await (await hub.fetch(request(route))).text();
    assert.ok(!text.includes('a'.repeat(64)), route);
    assert.ok(!text.includes('liveActivities'), route);
  }
  const badDelete = await hub.fetch(request('/api/live-activities/%ZZ', 'DELETE'));
  assert.equal(badDelete.status, 400);
  const abort = new AbortController();
  const stream = await hub.fetch(new Request('https://hub.example/api/stats/stream', {
    headers: { authorization: 'Bearer secret' }, signal: abort.signal
  }));
  const reader = stream.body.getReader();
  try {
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert.match(frame, /event: snapshot/);
    assert.ok(!frame.includes('a'.repeat(64)));
    assert.ok(!frame.includes('activity:activity'));
  } finally {
    abort.abort();
    // Drain the writer's close after abort instead of cancelling its pending write.
    while (!(await reader.read()).done) { /* drain */ }
  }
});

test('Worker late invalid result preserves a same-token registration made in the same millisecond', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { hub, entries, kept } = await makeHub();
  const original = await hub.registerLiveActivity(registerInput());
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  hub.apns = { enabled: true, async send() { calls += 1; return pending; } };
  const dispatch = hub.pushLiveActivityStats(await hub.getStats());
  try {
    await waitFor(() => calls === 1);
    const replacement = await hub.registerLiveActivity({
      ...registerInput(), preferences: { livePeriod: 'month' }
    });
    assert.equal(original.registeredAt, replacement.registeredAt);
    hub.apns.enabled = false;
    release({ invalid: true });
    await dispatch;
    await Promise.all(kept);
    assert.equal(entries.get('activity:activity')?.preferences.livePeriod, 'month');
  } finally {
    hub.apns.enabled = false;
    release({ sent: true });
    await dispatch;
    await Promise.all(kept);
  }
});

test('Worker cooldown retains delayed delivery, coalesces ingests and skips unregistered targets', async (t) => {
  const { hub, kept } = await makeHub();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  hub.apnsMinIntervalMs = 200;
  const pushes = [];
  hub.apns = { enabled: true, async send(token, state) {
    pushes.push({ token, state }); return { sent: true };
  } };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await hub.registerLiveActivity(registerInput());
    t.mock.timers.tick(0);
    await flush();
    assert.equal(pushes.length, 1);
    await hub.fetch(request('/api/ingest', 'POST', { deviceId: 'device', periods: { today: { totalTokens: 100 } } }));
    let settled = false;
    kept[1].then(() => { settled = true; });
    t.mock.timers.tick(100);
    await hub.fetch(request('/api/ingest', 'POST', { deviceId: 'device', periods: { today: { totalTokens: 700 } } }));
    t.mock.timers.tick(99);
    await flush();
    assert.equal(pushes.length, 1);
    assert.equal(settled, false, 'retained promise includes cooldown delay');
    t.mock.timers.tick(1);
    await flush();
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].state.tokensValue, '700');
    assert.equal(settled, true);
    await hub.fetch(request('/api/ingest', 'POST', { deviceId: 'device' }));
    await hub.fetch(request('/api/live-activities/activity', 'DELETE'));
    t.mock.timers.tick(200);
    await flush();
    assert.equal(pushes.length, 2);
  } finally {
    hub.apns.enabled = false;
    t.mock.timers.tick(1000);
    await Promise.all(kept);
  }
});
