'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { serialize, deserialize } = require('node:v8');
const test = require('node:test');
const { normalizePeriod, mergePeriods, normalizeDeviceRecord, stripSessionTextFromDeviceRecord } = require('../../worker/src/shared/usage');
const { normalizeUsageIdentity, packUsageIdentity } = require('../../worker/src/shared/usageIdentity');
const { normalizeHistory, parseGraphResult } = require('../../worker/src/shared/history');

const CAP = 2 * 1024 * 1024;
const SIZE_ERROR = 'string or blob too big: SQLITE_TOOBIG';
const MODEL = 'claude-sonnet-4-5';
const SESSION = 'claude:session-a';
const NOW = new Date().toISOString();
const DAY = NOW.slice(0, 10);

function usage(tokens) {
  return normalizePeriod({
    totalTokens: tokens, costUsd: tokens / 1000000, cacheReadTokens: tokens / 2, outputTokens: tokens / 10,
    capabilities: { tokenComponents: true, throughput: true },
    timedTokens: tokens, timedOutputTokens: tokens / 10, timedDurationMs: tokens,
    modelThroughput: { [MODEL]: { timedTokens: tokens, timedOutputTokens: tokens / 10, timedDurationMs: tokens } },
    clients: { claude: tokens }, clientCosts: { claude: tokens / 1000000 },
    clientCacheReads: { claude: tokens / 2 }, clientOutputs: { claude: tokens / 10 },
    models: { [MODEL]: tokens }, modelCosts: { [MODEL]: tokens / 1000000 },
    modelCacheReads: { [MODEL]: tokens / 2 }, modelOutputs: { [MODEL]: tokens / 10 },
    clientModels: { claude: { [MODEL]: tokens } }, clientModelCosts: { claude: { [MODEL]: tokens / 1000000 } },
    sessions: { [SESSION]: { client: 'claude', sessionId: 'session-a', title: 'Private title',
      totalTokens: tokens, costUsd: tokens / 1000000, messageCount: 1, cacheReadTokens: tokens / 2,
      outputTokens: tokens / 10, timedOutputTokens: tokens / 10, timedDurationMs: tokens,
      models: { [MODEL]: tokens }, modelCosts: { [MODEL]: tokens / 1000000 }, providers: { anthropic: tokens },
      projectId: 'repo', projectLabel: 'repo' } },
    projects: { repo: { tokens, costUsd: tokens / 1000000, clients: { claude: tokens } } }
  });
}

function payload(deviceId, count, { kind = 'native', history = false, retainedTiming = false,
  rootOnlyTiming = false, periodNames = ['today', 'month', 'allTime'] } = {}) {
  const contribution = usage(100);
  if (rootOnlyTiming) delete contribution.modelThroughput;
  const events = Array.from({ length: count }, (_, index) => ({
    id: `sha256:${(index + 1).toString(16).padStart(64, '0')}`,
    observationKind: kind, sessionId: 'session-a', usage: contribution
  }));
  const period = mergePeriods(...events.map(event => event.usage));
  if (retainedTiming) {
    delete period.modelThroughput;
    period.capabilities.throughput = false;
  }
  const record = { deviceId, hostname: deviceId, updatedAt: NOW,
    today: period, month: period, allTime: { ...period, sessions: {} },
    usageIdentity: { version: 1, eventIdentityVersion: 2,
      periods: Object.fromEntries(periodNames.map(name => [name, { capturedAt: NOW, events }])) } };
  if (history) {
    const graph = tokens => parseGraphResult({ contributions: [{ date: DAY, clients: [{ client: 'claude', modelId: MODEL,
      tokens: { input: tokens * 0.4, output: tokens * 0.1, cacheRead: tokens * 0.5, cacheWrite: 0 },
      cost: tokens / 1000000, messages: tokens / 100 }] }] });
    const day = graph(100).contributions[0];
    record.history = normalizeHistory(graph(count * 100), { todayKey: DAY });
    record.usageIdentity.history = { capturedAt: NOW, events: events.map(({ usage: _usage, ...event }) => ({
      ...event, days: [{ date: DAY, usage: day }]
    })) };
  }
  record.usageIdentity = packUsageIdentity(normalizeDeviceRecord(record).usageIdentity);
  assert.ok(record.usageIdentity, 'fixture must carry valid compact proof');
  return record;
}

// DO values use V8 structured serialization, not JSON bytes. Clone reads too so
// a merge cannot silently mutate the persisted value without a checked put().
function storageState() {
  const map = new Map();
  const attempts = [];
  const clone = value => value === undefined ? value : deserialize(serialize(value));
  const state = {
    map, attempts, failure: null,
    async blockConcurrencyWhile(callback) { return callback(); },
    storage: {
      async get(key) { return clone(map.get(key)); },
      async put(key, value) {
        const bytes = Buffer.byteLength(key) + serialize(value).byteLength;
        attempts.push({ key, bytes, proof: !!value.usageIdentity });
        if (state.failure && key.startsWith('dev:')) {
          const failure = typeof state.failure === 'function' ? state.failure(value) : state.failure;
          if (failure) throw failure;
        }
        if (bytes > CAP) throw new Error(SIZE_ERROR);
        map.set(key, clone(value));
      },
      async list({ prefix }) {
        return new Map([...map].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, clone(value)]));
      },
      async transaction(callback) {
        const before = clone(map);
        try { return await callback(state.storage); } catch (error) {
          map.clear(); for (const [key, value] of before) map.set(key, value);
          throw error;
        }
      }
    }
  };
  return state;
}

async function fixture(enabled = false) {
  const { HubDO } = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const state = storageState();
  let hub;
  const restart = async (titles = enabled) => {
    hub = new HubDO(state, { TOKEN_MONITOR_SECRET: 'secret', TOKEN_MONITOR_SYNC_SESSION_TITLES: String(titles), PUBLIC_STATS_ENABLED: '1' });
    await hub.ready;
  };
  await restart();
  const send = (endpoint, method = 'GET', body, minimal = true) => hub.fetch(new Request(`https://hub.example${endpoint}`, {
    method,
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json',
      ...(minimal ? { 'x-token-monitor-response': 'minimal' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }));
  const read = async endpoint => {
    const response = await send(endpoint);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { state, send, read, restart };
}

for (const count of [1000, 2500]) {
  test(`Worker persists ${count} compact event claims under the 2MB V8 cap and reconciles after restart`, async (t) => {
    const client = await fixture();
    const mirror = payload('mirror', count, { kind: 'mirror' });
    const expanded = normalizeDeviceRecord(mirror);
    const expandedBytes = serialize(expanded).byteLength;
    const wireBytes = Buffer.byteLength(JSON.stringify(mirror));
    assert.ok(wireBytes < 1024 * 1024);
    assert.ok(expandedBytes > CAP, 'expanded proof reproduces the SQLite storage failure');
    t.diagnostic(`events=${count} wire=${wireBytes} expandedV8=${expandedBytes}`);
    assert.equal((await client.send('/api/ingest', 'POST', mirror)).status, 200);
    const stored = client.state.map.get('dev:mirror');
    assert.equal(stored.usageIdentity.encoding, 'event-rows-v1');
    assert.equal(stored.usageIdentity.periods.allTime.events.length, count);
    assert.equal(client.state.attempts.length, 1, 'compaction avoids any failed put');
    t.diagnostic(`persistedV8=${serialize(stored).byteLength}`);
    const native = { ...mirror, deviceId: 'native', hostname: 'native' };
    native.usageIdentity = packUsageIdentity({ ...expanded.usageIdentity,
      periods: Object.fromEntries(Object.entries(expanded.usageIdentity.periods).map(([name, evidence]) => [name,
        { ...evidence, events: evidence.events.map(event => ({ ...event, observationKind: 'native' })) }])) });
    const response = await client.send('/api/ingest', 'POST', native, false);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).stats.periods.allTime.totalTokens, count * 100);
    await client.restart();
    const devices = await client.read('/api/devices');
    assert.equal(normalizeDeviceRecord(devices.devices[0]).usageIdentity.periods.allTime.events.length, count);
    const stats = await client.read('/api/stats');
    for (const period of Object.values(stats.periods)) {
      assert.equal(period.totalTokens, count * 100);
      assert.equal(period.clients.claude, count * 100);
      assert.equal(period.models[MODEL], count * 100);
      assert.equal(period.outputTokens, count * 10);
      assert.equal(period.cacheReadTokens, count * 50);
      assert.equal(period.timedOutputTokens, count * 10);
      assert.equal(period.projects.repo.tokens, count * 100);
    }
    assert.equal(stats.devices[0].periods.allTime.totalTokens, count * 100, 'raw device readings stay intact');
    assert.equal(JSON.stringify(stats).includes('usageIdentity'), false);
    const publicStats = await client.read('/api/public/stats');
    assert.equal(publicStats.periods.allTime.totalTokens, count * 100);
    assert.equal(Object.hasOwn(publicStats, 'devices'), false);
  });
}

test('Worker retains compact proof on limits-only updates and carries independent History on a legacy usage tick', async () => {
  const client = await fixture();
  const mirror = payload('mirror', 1000, { kind: 'mirror', history: true, retainedTiming: true });
  const native = payload('native', 1000, { history: true, retainedTiming: true });
  for (const value of [mirror, native]) assert.equal((await client.send('/api/ingest', 'POST', value)).status, 200);
  const before = client.state.map.get('dev:mirror');
  assert.equal((await client.send('/api/ingest', 'POST', { deviceId: 'mirror', limitsOnly: true,
    limits: { updatedAt: NOW, providers: [] } })).status, 200);
  const retained = client.state.map.get('dev:mirror');
  assert.deepEqual(retained.usageIdentity, before.usageIdentity);
  assert.deepEqual(retained.periods, before.periods);
  assert.deepEqual(retained.history, before.history);
  const stats = await client.read('/api/stats');
  assert.equal(stats.periods.allTime.totalTokens, 100000);
  assert.equal(stats.periods.allTime.timedOutputTokens, 10000);
  assert.equal(Object.hasOwn(stats.periods.allTime, 'modelThroughput'), false);
  assert.equal(stats.periods.allTime.capabilities.throughput, false);
  assert.equal((await client.read('/api/history')).summary.totalTokens, 100000);
  const legacy = { ...mirror }; delete legacy.usageIdentity; delete legacy.history;
  assert.equal((await client.send('/api/ingest', 'POST', legacy)).status, 200);
  const carried = client.state.map.get('dev:mirror');
  assert.equal(carried.usageIdentity.encoding, 'event-rows-v1');
  assert.deepEqual(carried.usageIdentity.periods, {});
  assert.equal(normalizeUsageIdentity(carried.usageIdentity, carried).history.events.length, 1000);
  assert.deepEqual(carried.history, before.history);
  await client.restart();
  assert.equal((await client.read('/api/history')).summary.totalTokens, 100000);
  assert.equal((await client.read('/api/stats')).periods.allTime.totalTokens, 200000, 'legacy period readings remain additive');
});

test('Worker title-policy and startup privacy rewrites retain compact evidence', async () => {
  const client = await fixture(true);
  const policy = await (await client.send('/api/sync/titles/titled', 'PUT', { enabled: true })).json();
  const value = { ...payload('titled', 1000), sessionTitleSyncGeneration: policy.generation };
  assert.equal((await client.send('/api/ingest', 'POST', value)).status, 200);
  const before = client.state.map.get('dev:titled');
  assert.equal(before.periods.today.sessions[SESSION].title, 'Private title');
  assert.equal((await client.send('/api/sync/titles/titled', 'PUT', { enabled: false })).status, 200);
  const revoked = client.state.map.get('dev:titled');
  assert.equal(Object.hasOwn(revoked.periods.today.sessions[SESSION], 'title'), false);
  assert.deepEqual(revoked.usageIdentity, before.usageIdentity);
  const nextPolicy = await (await client.send('/api/sync/titles/titled', 'PUT', { enabled: true })).json();
  assert.equal((await client.send('/api/ingest', 'POST', { ...value, sessionTitleSyncGeneration: nextPolicy.generation })).status, 200);
  await client.restart(false);
  const cleaned = client.state.map.get('dev:titled');
  assert.equal(Object.hasOwn(cleaned.periods.today.sessions[SESSION], 'title'), false);
  assert.deepEqual(cleaned.usageIdentity, before.usageIdentity);
  assert.equal((await client.read('/api/stats')).periods.allTime.totalTokens, 100000);
});

test('Worker drops only optional proof when the compact record still exceeds the storage cap', async (t) => {
  const client = await fixture();
  const value = payload('large', 6000, { history: true, periodNames: ['allTime'] });
  const compactBytes = serialize({ ...normalizeDeviceRecord(value), usageIdentity: value.usageIdentity }).byteLength;
  assert.ok(compactBytes > CAP, 'fixture must exceed the real mock cap even when compact');
  const response = await client.send('/api/ingest', 'POST', value);
  assert.equal(response.status, 200);
  const stored = await client.state.storage.get('dev:large');
  assert.equal(Object.hasOwn(stored, 'usageIdentity'), false);
  const expected = deserialize(serialize(normalizeDeviceRecord(stripSessionTextFromDeviceRecord(value))));
  delete expected.usageIdentity;
  delete stored.receivedAt; delete expected.receivedAt;
  assert.deepEqual(stored, expected, 'fallback keeps the entire normalized reading');
  assert.equal(client.state.attempts.length, 2);
  assert.ok(client.state.attempts[0].bytes > CAP);
  assert.equal(client.state.attempts[1].proof, false);
  t.diagnostic(`compactV8=${compactBytes} fallbackV8=${serialize(stored).byteLength}`);
  await client.restart();
  assert.equal((await client.read('/api/stats')).periods.allTime.totalTokens, 600000);
  assert.equal((await client.read('/api/history')).summary.totalTokens, 600000);
});

test('Worker compact storage retains root-only timing through limits carry and repeated reads', async () => {
  const client = await fixture();
  for (const deviceId of ['mirror', 'native']) {
    const value = payload(deviceId, 1000, { kind: deviceId, retainedTiming: true, rootOnlyTiming: true });
    assert.equal((await client.send('/api/ingest', 'POST', value)).status, 200);
    assert.equal((await client.send('/api/ingest', 'POST', { deviceId, limitsOnly: true })).status, 200);
    const stored = client.state.map.get(`dev:${deviceId}`);
    assert.equal(stored.usageIdentity.encoding, 'event-rows-v1');
    assert.equal(Object.hasOwn(stored.periods.allTime, 'modelThroughput'), false);
    assert.equal(stored.periods.allTime.capabilities.throughput, false);
  }
  await client.restart();
  for (let read = 0; read < 2; read += 1) {
    const stats = await client.read('/api/stats');
    assert.equal(stats.periods.allTime.totalTokens, 100000);
    assert.equal(stats.periods.allTime.timedOutputTokens, 10000);
    assert.equal(stats.periods.allTime.timedDurationMs, 100000);
    assert.equal(Object.hasOwn(stats.periods.allTime, 'modelThroughput'), false);
    assert.equal(stats.periods.allTime.capabilities.throughput, false);
  }
});

test('Worker compact persistence and limits carry preserve each event observation time', async () => {
  const client = await fixture();
  const value = payload('mixed', 2, { history: true });
  const early = new Date(Date.parse(NOW) - 3600000).toISOString();
  const proof = normalizeDeviceRecord(value).usageIdentity;
  for (const capture of [...Object.values(proof.periods), proof.history]) {
    capture.events.forEach((event, i) => { event.capturedAt = i ? NOW : early; });
  }
  value.usageIdentity = packUsageIdentity(proof);
  assert.equal((await client.send('/api/ingest', 'POST', value)).status, 200);
  assert.equal((await client.send('/api/ingest', 'POST', { deviceId: 'mixed', limitsOnly: true })).status, 200);
  await client.restart();
  const stored = client.state.map.get('dev:mixed');
  const restored = normalizeUsageIdentity(stored.usageIdentity, stored);
  for (const capture of [...Object.values(restored.periods), restored.history]) {
    assert.deepEqual(capture.events.map(event => event.capturedAt), [early, NOW]);
  }
});

test('Worker propagates unrelated storage errors and does not retry a record without proof', async () => {
  for (const [failure, proof] of [[new Error('disk I/O error: SQLITE_IOERR'), true],
    [new Error('storage quota exceeded: SQLITE_FULL'), true], [new Error('value too large'), true],
    [new Error(SIZE_ERROR), false]]) {
    const client = await fixture();
    const value = payload('error', 1);
    if (!proof) delete value.usageIdentity;
    client.state.failure = failure;
    await assert.rejects(client.send('/api/ingest', 'POST', value), error => error === failure);
    assert.equal(client.state.attempts.length, 1);
    assert.equal(client.state.map.has('dev:error'), false);
  }
});

test('Worker propagates a failed proof-free retry without replacing the prior reading', async () => {
  const client = await fixture();
  assert.equal((await client.send('/api/ingest', 'POST', payload('error', 1))).status, 200);
  const before = await client.state.storage.get('dev:error');
  const failure = new Error('disk I/O error: SQLITE_IOERR');
  client.state.failure = value => value.usageIdentity ? new Error(SIZE_ERROR) : failure;
  await assert.rejects(client.send('/api/ingest', 'POST', payload('error', 2)), error => error === failure);
  assert.equal(client.state.attempts.length, 3, 'one original write and exactly two failed attempts');
  assert.deepEqual(await client.state.storage.get('dev:error'), before);
});
