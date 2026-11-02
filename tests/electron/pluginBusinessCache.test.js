'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const servicePath = path.resolve(__dirname, '../../src/electron/plugins/businessData.js');
const serviceRequire = createRequire(servicePath);
const source = fs.readFileSync(process.env.BUSINESS_SERVICE_PATH || servicePath, 'utf8');
const shared = serviceRequire('../../shared/plugins/businessData');
const auth = (pluginId = 'reader') => ({ pluginId, active: true, revision: 1 });
const q = (resource = 'sessions', rest = {}) => ({ version: 1, resource, ...rest });
const flush = () => new Promise(resolve => setImmediate(resolve));
const tick = () => new Promise(resolve => setTimeout(resolve, 120));
function fixture(count = 3) {
  const sessions = Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, { sessionId: `s${i}`, client: 'codex', title: `Session ${i}`, totalTokens: i + 1, costUsd: 0, unpricedTokens: 0, models: { model: i + 1 } }]));
  const period = { totalTokens: count, costUsd: 0, unpricedTokens: 0, sessions, models: { model: count, another: 2 }, clients: { codex: count }, projects: {} };
  return { updatedAt: '2026-10-23T00:00:00Z', periods: { today: period, month: period, allTime: period }, devices: [] };
}
function setup(t, options, runtime = {}) {
  let calls = 0;
  const module = { exports: {} };
  let lazyHelper;
  if (runtime.performance) {
    // Use the same work-clock seam for source scans, indexing and service work.
    const lazyModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(path.dirname(servicePath), 'lazySessions.js'), 'utf8'), {
      module: lazyModule, exports: lazyModule.exports,
      require: name => name === 'node:perf_hooks' ? { performance: runtime.performance } : serviceRequire(name)
    });
    lazyHelper = lazyModule.exports;
  }
  vm.runInNewContext(source, { module, exports: module.exports, require(name) {
    if (name === './lazySessions' && lazyHelper) return lazyHelper;
    if (name === 'node:perf_hooks' && runtime.performance) return { performance: runtime.performance };
    return name === '../../shared/plugins/businessData' ? { ...shared, projectResource(...args) { calls++; return (runtime.projectResource || shared.projectResource)(...args); } } : serviceRequire(name);
  }, Buffer, AbortController, setTimeout: runtime.setTimeout || setTimeout, clearTimeout: runtime.clearTimeout || clearTimeout });
  const service = module.exports.createBusinessDataService(options);
  t.after(() => service.dispose());
  return { service, calls: () => calls };
}
function next(query, first) { return { ...query, page: { ...query.page, cursor: first.pageInfo.nextCursor } }; }

test('unchanged accounting maps survive timestamp, limits and subscription publications', async t => {
  const { service } = setup(t), stats = fixture(), extras = { sourceId: 'local', subscriptions: [] };
  service.publish(stats, extras);
  for (const resource of ['sessions', 'models']) {
    const query = q(resource, { page: { limit: 1 } }), first = await service.query(query, auth());
    service.publish({ ...stats, updatedAt: '2026-10-23T00:00:05Z', limits: { providers: [] } }, { ...extras, subscriptions: [{ id: 'new' }] });
    const second = await service.query(next(query, first), auth());
    assert.equal(second.availability, 'available');
    assert.equal(second.snapshotRevision, first.snapshotRevision);
    assert.equal(second.asOf, first.asOf, 'cursor is a captured immutable snapshot');
  }
});

test('only subscriptions of the changed resource invalidate; session activity leaves models and history alone', async t => {
  const { service } = setup(t), stats = fixture();
  const extras = { historyRevision: 'h1', history: { daily: [] }, subscriptions: [] };
  service.publish(stats, extras);
  const events = {};
  for (const resource of ['sessions', 'models', 'history', 'subscriptions']) {
    events[resource] = [];
    service.subscribe(resource, q(resource), () => auth(), event => events[resource].push(event));
  }
  await flush();
  service.publish({ ...stats, updatedAt: '2026-10-23T00:00:05Z', periods: { ...stats.periods, today: { ...stats.periods.today, sessions: { ...stats.periods.today.sessions } } } }, extras);
  await tick();
  assert.equal(events.sessions.length, 2);
  for (const resource of ['models', 'history', 'subscriptions']) assert.equal(events[resource].length, 1, resource);
  service.publish(stats, { ...extras, subscriptions: [{ id: 'new', amountMinor: 42 }] });
  await tick();
  assert.equal(events.subscriptions.length, 2);
});

test('title policy immediately expires old identity cursors and cached search projections', async t => {
  const { service } = setup(t), stats = fixture();
  service.publish(stats, { preferences: { sessionTitlesEnabled: true } });
  const query = q('sessions', { page: { limit: 1 } }), first = await service.query(query, auth());
  assert.equal(typeof first.rows[0].title, 'string');
  service.publish(stats, { preferences: { sessionTitlesEnabled: false } });
  assert.equal((await service.query(next(query, first), auth())).availability, 'snapshotExpired');
  assert.equal((await service.query(query, auth())).rows[0].title, null);
  assert.equal((await service.query(q('sessions', { filter: { search: 'Session' } }), auth())).rows.length, 0);
});

test('history in-flight and completed results reuse host revision across unrelated publishes', async t => {
  let resolve, loads = 0, captured;
  const { service } = setup(t, { loadHistory: args => { loads++; captured = args.stats; return new Promise(r => { resolve = r; }); } });
  const stats = fixture();
  service.publish(stats, { sourceId: 'local', historyRevision: 'h1' });
  const one = service.query(q('history'), auth()); await flush();
  service.publish(fixture(), { sourceId: 'local', historyRevision: 'h1' });
  const two = service.query(q('history'), auth()); await flush();
  assert.equal(loads, 1); assert.equal(captured, stats);
  resolve({ daily: [{ date: '2026-10-23', totalTokens: 7 }] });
  assert.equal((await one).availability, 'available');
  assert.equal((await two).rows[0].totalTokens, 7);
  service.publish(fixture(), { sourceId: 'local', historyRevision: 'h1' });
  await service.query(q('history'), auth()); assert.equal(loads, 1);
  service.publish(fixture(), { sourceId: 'local', historyRevision: 'h2' });
  const three = service.query(q('history'), auth()); await flush();
  assert.equal(loads, 2); resolve({ daily: [{ date: '2026-10-23', totalTokens: 9 }] });
  assert.equal((await three).rows[0].totalTokens, 9);
});

test('explicit history cache replacement wins even with unchanged host revision', async t => {
  const { service } = setup(t);
  service.publish(fixture(), { historyRevision: 'h1', history: { daily: [{ date: '2026-10-23', totalTokens: 1 }] } });
  assert.equal((await service.query(q('history'), auth())).rows[0].totalTokens, 1);
  service.publish(fixture(), { historyRevision: 'h1', history: { daily: [{ date: '2026-10-23', totalTokens: 2 }] } });
  assert.equal((await service.query(q('history'), auth())).rows[0].totalTokens, 2);
});

for (const change of ['source', 'revision', 'source-roundtrip', 'revision-roundtrip', 'revoke', 'auth', 'dispose']) test(`pending history fences ${change}`, async t => {
  let resolve, active = true;
  const { service } = setup(t, { loadHistory: () => new Promise(r => { resolve = r; }) });
  const stats = fixture(), extras = { sourceId: 'one', historyRevision: 'h1' };
  service.publish(stats, extras);
  const pending = service.query(q('history'), () => ({ ...auth(), active })); await flush();
  if (change.startsWith('source')) service.publish(stats, { ...extras, sourceId: 'two' });
  if (change.startsWith('revision')) service.publish(stats, { ...extras, historyRevision: 'h2' });
  if (change.endsWith('roundtrip')) service.publish(stats, extras);
  if (change === 'revoke') service.revoke('reader');
  if (change === 'auth') active = false;
  if (change === 'dispose') service.dispose();
  resolve({ daily: [{ date: '2026-10-23', totalTokens: 999 }] });
  assert.equal((await pending).availability, ['revoke', 'auth', 'dispose'].includes(change) ? 'denied' : 'snapshotExpired');
});

test('identity epoch expires cursors; data refresh preserves traversal and its original expiry deadline', async t => {
  let clock = 1000;
  const { service } = setup(t, { now: () => clock, snapshotTtlMs: 100 });
  const stats = fixture(), query = q('sessions', { page: { limit: 1 } });
  service.publish(stats, { identityEpoch: 'one' });
  const first = await service.query(query, auth());
  service.publish(stats, { identityEpoch: 'two' });
  assert.equal((await service.query(next(query, first), auth())).availability, 'snapshotExpired');
  const second = await service.query(query, auth());
  service.publish({ ...stats, periods: { ...stats.periods, today: { ...stats.periods.today, sessions: {} } } }, { identityEpoch: 'two' });
  assert.equal((await service.query(next(query, second), auth())).availability, 'available');
  assert.equal((await service.query(query, auth())).rows.length, 0, 'new first page reads refreshed data');
  service.publish(stats);
  const third = await service.query(query, auth());
  clock += 101; service.publish({ ...stats, updatedAt: 'later' });
  assert.equal((await service.query(next(query, third), auth())).availability, 'snapshotExpired');
});

test('search and sort variations share a projection for an active trusted plugin', async t => {
  const { service, calls } = setup(t);
  service.publish(fixture(100));
  for (let i = 0; i < 5; i++) assert.equal((await service.query(q('sessions', { filter: { search: String(i) }, sort: { field: i % 2 ? 'id' : 'totalTokens' } }), auth())).availability, 'available');
  assert.equal(calls(), 1, 'one projection despite five distinct filters/sorts');

});

test('expensive filter flood is bounded per plugin and does not expire another plugin cursor', async t => {
  const clock = controlledClock(10);
  const { service, calls } = setup(t, { now: clock.now }, clock);
  service.publish(fixture(100));
  const query = q('sessions', { page: { limit: 1 } }), first = await service.query(query, auth('quiet'));
  const results = [];
  for (let i = 0; i < 80; i++) results.push(await service.query(q('sessions', { filter: { search: String(i) } }), auth('noisy')));
  assert.ok(results.some(r => r.availability === 'rateLimited' && r.retryAfterMs > 0));
  assert.ok(results.filter(r => r.availability === 'available').length <= 24);
  assert.equal(calls(), 2);
  assert.equal((await service.query(next(query, first), auth('quiet'))).availability, 'available');
  await clock.advance(10000);
  assert.equal((await service.query(q('sessions', { filter: { search: 'again' } }), auth('noisy'))).availability, 'available');
});

test('another plugin cannot FIFO-evict an admitted cursor with many resources and filters', async t => {
  let clock = 1000;
  const { service } = setup(t, { now: () => clock });
  service.publish(fixture());
  const query = q('sessions', { page: { limit: 1 } }), first = await service.query(query, auth('quiet'));
  for (let i = 0; i < 40; i++) {
    clock += 250;
    await service.query(q('sessions', { filter: { search: String(i) } }), auth('noisy'));
  }
  assert.equal((await service.query(next(query, first), auth('quiet'))).availability, 'available');
});

test('large sessions build query indices without eager projections across searches', async t => {
  // This checks projection reuse, not CPU debt under machine-dependent load.
  const { service, calls } = setup(t, undefined, { performance: { now: () => 0 } });
  service.publish(fixture(5001));
  for (const search of ['one', 'two', 'three']) {
    const result = await service.query(q('sessions', { filter: { search } }), auth());
    assert.equal(result.availability, 'available');
    assert.equal(result.aggregateCoverage.totalRows, 0);
  }
  assert.equal(calls(), 0);
});

test('all-time preflight includes base data when extras only provide metadata', async t => {
  const { service, calls } = setup(t);
  service.publish(fixture(5001), { allTime: { updatedAt: 'metadata' } });
  assert.equal((await service.query(q('sessions', { period: 'allTime' }), auth())).aggregateCoverage.totalRows, 5001);
  assert.equal(calls(), 0);
});

test('zero-demand publish never enumerates session maps', t => {
  const { service, calls } = setup(t);
  const stats = fixture();
  stats.periods.today.sessions = new Proxy({}, { ownKeys() { assert.fail('publish enumerated sessions'); } });
  for (let i = 0; i < 100; i++) service.publish({ ...stats, updatedAt: String(i) }, { historyRevision: 'stable' });
  assert.equal(calls(), 0);
});

test('5000 ordinary sessions remain fully pageable within the explicit admitted bound', async t => {
  const { service } = setup(t);
  service.publish(fixture(5000));
  const query = q('sessions', { page: { limit: 500 }, sort: { field: 'totalTokens', direction: 'asc' } });
  let result = await service.query(query, auth()), count = 0;
  do {
    assert.equal(result.availability, 'available');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 56 * 1024);
    for (const row of result.rows) assert.equal(row.totalTokens, ++count);
    result = result.pageInfo.hasMore ? await service.query(next(query, result), auth()) : null;
  } while (result);
  assert.equal(count, 5000);
});

// Hub / SSE JSON does not preserve host object identity. A revision may be
// conservatively invalidated, but the cursor must still finish its captured rows.
test('JSON-cloned Hub pushes preserve admitted traversal even when totals subsequently change', async t => {
  const { service } = setup(t), stats = fixture();
  service.publish(stats, { sourceId: 'hub' });
  const query = q('sessions', { page: { limit: 1 }, sort: { field: 'totalTokens', direction: 'asc' } });
  const first = await service.query(query, auth());
  const cloned = JSON.parse(JSON.stringify(stats));
  cloned.updatedAt = '2026-10-23T00:00:05Z';
  service.publish(cloned, { sourceId: 'hub' });
  const second = await service.query(next(query, first), auth());
  assert.equal(second.availability, 'available');
  assert.equal(second.rows[0].totalTokens, 2);
  service.publish({ ...cloned, periods: { ...cloned.periods, today: { ...cloned.periods.today, sessions: {} } } }, { sourceId: 'hub' });
  const third = await service.query(next(query, second), auth());
  assert.equal(third.availability, 'available');
  assert.equal(third.rows[0].totalTokens, 3);
  assert.equal((await service.query(query, auth())).rows.length, 0);
  service.publish(stats, { sourceId: 'different-hub' });
  assert.equal((await service.query(next(query, first), auth())).availability, 'snapshotExpired');
});

for (const change of ['privacy', 'source']) test(`invalidation reset distinguishes data updates and coalesces ${change} fences`, async t => {
  const { service } = setup(t), stats = fixture(), events = [];
  service.publish(stats, { sourceId: 'one', preferences: { sessionTitlesEnabled: true } });
  service.subscribe('page', q(), () => auth(), event => events.push(event)); await flush();
  service.publish(JSON.parse(JSON.stringify(stats)), { sourceId: 'one', preferences: { sessionTitlesEnabled: true } });
  await tick();
  assert.equal(events[1].type, 'invalidate'); assert.equal(events[1].reset, false);
  const extras = { sourceId: change === 'source' ? 'two' : 'one', preferences: { sessionTitlesEnabled: change !== 'privacy' } };
  service.publish(stats, extras);
  service.publish(JSON.parse(JSON.stringify(stats)), extras);
  await tick();
  assert.equal(events.length, 3); assert.equal(events[2].reset, true, 'ordinary update cannot clear pending reset');
  service.publish(JSON.parse(JSON.stringify(stats)), extras);
  await tick();
  assert.equal(events[3].reset, false, 'reset is consumed once');
});


// Wall time, CPU charges and timer delivery are independent and deterministic.
// No production hooks or sleeps are needed to exhaust/refill a work bucket.
function controlledClock(costMs = 0) {
  let wall = 1000, cpu = 0;
  const timers = new Map();
  return {
    now: () => wall,
    performance: { now() { const value = cpu; cpu += costMs; return value; } },
    setTimeout(callback, ms) { const id = { unref() {} }; timers.set(id, { at: wall + ms, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const end = wall + ms;
      for (let count = 0; ; count++) {
        assert.ok(count < 1000, 'timer loop must make progress');
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > end) break;
        wall = entry[1].at; timers.delete(entry[0]); entry[1].callback(); await flush();
      }
      wall = end; await flush();
    }
  };
}
async function exhaust(service) {
  for (let i = 0; i < 40; i++) await service.query(q('sessions', { filter: { search: `drain-${i}` } }), auth());
}
function liveReader(service, owner, query, values, events = []) {
  return service.subscribe(owner, query, () => auth(), event => {
    events.push(event);
    if (event.type === 'snapshot') values.push(event.value);
    else if (event.type === 'invalidate') void service.query(query, auth()).then(value => values.push(value));
  });
}

test('projection hits pay no fixed query token, while exact snapshots remain free even in debt', async t => {
  const clock = controlledClock(), { service, calls } = setup(t, { now: clock.now }, clock);
  service.publish(fixture());
  for (let i = 0; i < 80; i++) {
    assert.equal((await service.query(q('sessions', { filter: { search: String(i) } }), auth())).availability, 'available');
  }
  assert.equal(calls(), 1);
  const costlyClock = controlledClock(200), costly = setup(t, { now: costlyClock.now }, costlyClock).service;
  costly.publish(fixture());
  const first = await costly.query(q(), auth());
  assert.equal(first.availability, 'available');
  assert.equal((await costly.query(q(), auth())).availability, 'available', 'exact cache hit needs no work admission');
  assert.equal((await costly.query(q('sessions', { filter: { search: 'other' } }), auth())).availability, 'rateLimited');
});

for (const siblings of [1, 4]) test(`last rate-denied publication recovers ${siblings} live siblings without any new publish`, async t => {
  const clock = controlledClock(10), { service } = setup(t, { now: clock.now }, clock);
  service.publish(fixture());
  const readers = Array.from({ length: siblings }, (_, i) => ({ query: q('sessions', { page: { limit: i % 2 + 1 } }), values: [], events: [] }));
  for (const [i, reader] of readers.entries()) liveReader(service, `owner-${i}`, reader.query, reader.values, reader.events);
  await flush(); await exhaust(service);
  service.publish(fixture());
  await clock.advance(100);
  const denied = readers.map(r => r.values.at(-1));
  // Repeated denials of the same queries must not allocate more timers.
  for (let i = 0; i < 10; i++) for (const r of readers) await service.query(r.query, auth());
  assert.ok(clock.pending() <= siblings);
  await clock.advance(10000);
  for (const r of readers) {
    assert.equal(r.values.at(-1).availability, 'available', 'last refetch must recover after publication stops');
    assert.equal(r.values.at(-1).snapshotRevision, 2, 'every sibling eventually reads the last publication');
  }
  assert.ok(denied.some(value => value.availability === 'rateLimited'));
  // A shared-query sibling can have its first invalidation deferred by the
  // preceding sibling denial, instead of being made to refetch too early.
  for (const value of denied.filter(value => value.availability !== 'available')) {
    assert.equal(value.availability, 'rateLimited');
    assert.ok(Number.isInteger(value.retryAfterMs) && value.retryAfterMs > 0);
  }
  assert.equal(clock.pending(), 0, 'no periodic polling once recovered');
});

test('initial throttled subscription schedules recovery after initialization', async t => {
  const clock = controlledClock(10), { service } = setup(t, { now: clock.now }, clock), values = [];
  service.publish(fixture()); await exhaust(service);
  liveReader(service, 'late-reader', q(), values); await flush();
  await clock.advance(10000);
  assert.equal(values.at(-1).availability, 'available');
  assert.equal(values[0].availability, 'rateLimited');
  assert.equal(clock.pending(), 0);
});

for (const action of ['unsubscribe', 'releaseOwner', 'revoke', 'dispose']) test(`${action} cancels pending throttled subscription retries`, async t => {
  const clock = controlledClock(10), { service } = setup(t, { now: clock.now }, clock), values = [], events = [];
  service.publish(fixture()); await exhaust(service);
  const id = liveReader(service, 'owner', q(), values, events); await flush();
  assert.equal(clock.pending(), 1);
  if (action === 'unsubscribe') service.unsubscribe('owner', id);
  else if (action === 'releaseOwner') service.releaseOwner('owner');
  else if (action === 'revoke') service.revoke('reader');
  else service.dispose();
  assert.equal(clock.pending(), 0);
  const count = events.length; await clock.advance(10000);
  assert.equal(events.length, count);
});

test('releasing one throttled sibling leaves the remaining owner retry live', async t => {
  const clock = controlledClock(10), { service } = setup(t, { now: clock.now }, clock), released = [], retained = [];
  service.publish(fixture()); await exhaust(service);
  liveReader(service, 'released', q(), released);
  liveReader(service, 'retained', q(), retained); await flush();
  service.releaseOwner('released');
  assert.equal(clock.pending(), 1);
  await clock.advance(10000);
  assert.equal(released.length, 1);
  assert.equal(retained.at(-1).availability, 'available');
});

for (const change of ['privacy', 'source']) test(`throttled retry promptly delivers ORed ${change} reset despite work debt`, async t => {
  const clock = controlledClock(200), { service } = setup(t, { now: clock.now }, clock), values = [], events = [];
  service.publish(fixture(), { sourceId: 'one' });
  liveReader(service, 'owner', q(), values, events); await flush(); await exhaust(service);
  service.publish(fixture(), { sourceId: 'one' }); await clock.advance(100);
  assert.equal(values.at(-1).availability, 'rateLimited');
  assert.ok(values.at(-1).retryAfterMs > 1000, 'reset must preempt substantial existing CPU debt');
  const beforeReset = events.length;
  const extras = { sourceId: change === 'source' ? 'two' : 'one', preferences: { sessionTitlesEnabled: change !== 'privacy' } };
  service.publish(fixture(), extras);
  assert.equal(clock.pending(), 1, 'reset replaces the retry timer');
  await clock.advance(50);
  service.publish(fixture(), extras);
  assert.equal((await service.query(q(), auth())).availability, 'rateLimited');
  assert.equal(clock.pending(), 1, 'ordinary publish and denial cannot duplicate or postpone a pending reset');
  await clock.advance(49);
  assert.equal(events.length, beforeReset, 'normal coalescing window is retained');
  await clock.advance(1);
  assert.equal(events.length, beforeReset + 1, 'reset must arrive within 100ms, independently of work debt');
  assert.equal(events.at(-1).type, 'invalidate');
  assert.equal(events.at(-1).reset, true);
  assert.equal(values.at(-1).availability, 'rateLimited', 'prompt reset does not bypass work admission');
  assert.equal(clock.pending(), 1, 'denied reset refetch leaves exactly one eventual retry');
  await clock.advance(10000);
  assert.equal(values.at(-1).availability, 'available');
  assert.equal(values.at(-1).snapshotRevision, 4);
  if (change === 'privacy') assert.ok(values.at(-1).rows.every(row => row.title === null));
  assert.equal(events.filter(e => e.type === 'invalidate' && e.reset).length, 1, 'reset OR is consumed once');
  assert.equal(clock.pending(), 0, 'successful recovery leaves no polling timer');
  service.publish(fixture(), extras); await clock.advance(100);
  assert.equal(events.at(-1).reset, false, 'subsequent ordinary updates do not repeat the reset');
});

for (const sibling of ['usage', 'sessions']) test(`page2 survives sixteen same-plugin ${sibling} sibling refreshes and retains original TTL`, async t => {
  const clock = controlledClock(), { service } = setup(t, { now: clock.now }, clock);
  service.publish(fixture(20));
  const query = q('sessions', { page: { limit: 1 }, sort: { field: 'totalTokens' } });
  const first = await service.query(query, auth()), second = await service.query(next(query, first), auth());
  const values = [];
  liveReader(service, 'home', { ...query, resource: sibling }, values); await flush();
  for (let i = 0; i < 16; i++) {
    const stats = fixture(20); stats.periods.today.totalTokens = 100 + i;
    service.publish(stats); await clock.advance(1000);
    assert.equal(values.at(-1).availability, 'available');
  }
  assert.equal(values.length, 17, 'sibling really refetched on every update');
  const third = await service.query(next(query, second), auth());
  assert.equal(third.availability, 'available');
  assert.equal(third.snapshotRevision, first.snapshotRevision);
  assert.equal(third.rows[0].totalTokens, 3);
  await clock.advance(44001);
  assert.equal((await service.query(next(query, second), auth())).availability, 'snapshotExpired', 'reads do not slide expiry');
});

test('snapshot pressure retires nontraversed queries before page2, and still caps traversals at eight', async t => {
  const clock = controlledClock(), { service } = setup(t, { now: clock.now }, clock);
  service.publish(fixture(50));
  const query = q('sessions', { page: { limit: 1 } });
  const first = await service.query(query, auth()), second = await service.query(next(query, first), auth());
  for (let limit = 2; limit <= 20; limit++) await service.query(q('sessions', { page: { limit } }), auth());
  assert.equal((await service.query(next(query, second), auth())).availability, 'available');
  const cursors = [];
  for (let limit = 2; limit <= 12; limit++) {
    const query = q('sessions', { page: { limit } }), first = await service.query(query, auth());
    await service.query(next(query, first), auth()); cursors.push({ query, first });
  }
  let available = 0;
  for (const { query, first } of cursors) if ((await service.query(next(query, first), auth())).availability === 'available') available++;
  assert.equal(available, 8);
  assert.equal((await service.query(next(query, second), auth())).availability, 'snapshotExpired', 'all-traversed capacity falls back to oldest');
});

test('projection pressure still caps traversed collections at four per plugin', async t => {
  const clock = controlledClock(), { service } = setup(t, { now: clock.now }, clock), cursors = [];
  const query = q('sessions', { page: { limit: 1 } });
  for (let i = 0; i < 8; i++) {
    service.publish(fixture());
    const first = await service.query(query, auth());
    await service.query(next(query, first), auth()); cursors.push(first);
  }
  let available = 0;
  for (const first of cursors) if ((await service.query(next(query, first), auth())).availability === 'available') available++;
  assert.equal(available, 4);
});

test('global snapshot capacity rejects new admissions without evicting another plugin traversal', async t => {
  const clock = controlledClock(), { service } = setup(t, { now: clock.now }, clock), cursors = [];
  service.publish(fixture(20));
  for (let plugin = 0; plugin < 33; plugin++) for (let limit = 1; limit <= 8; limit++) {
    const query = q('sessions', { page: { limit } }), authority = auth(`plugin-${plugin}`);
    const first = await service.query(query, authority);
    if (cursors.length < 256) {
      assert.equal(first.availability, 'available');
      await service.query(next(query, first), authority); cursors.push({ query, first, authority });
    } else assert.equal(first.availability, 'budgetExceeded');
  }
  for (const { query, first, authority } of cursors) assert.equal((await service.query(next(query, first), authority)).availability, 'available');
});

test('owner and global byte ledgers include traversed projections and reject overflow fairly', async t => {
  // Controlled already-projected DTOs exercise serialized byte admission without
  // depending on the shared projector field layout. Each page is below 56 KiB.
  const clock = controlledClock();
  const projected = { availability: 'available', rows: Array.from({ length: 200 }, (_, i) => ({ id: String(i), label: 'x'.repeat(32768) })) };
  const bytes = projected.rows.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row)), 0);
  assert.ok(bytes < 8 * 1024 * 1024 && bytes * 2 > 12 * 1024 * 1024);
  const { service } = setup(t, { now: clock.now }, { ...clock, projectResource: () => projected });
  const query = q('sessions', { page: { limit: 1 } });
  service.publish(fixture());
  const old = await service.query(query, auth()); await service.query(next(query, old), auth());
  service.publish(fixture());
  const fresh = await service.query(query, auth());
  assert.equal(fresh.availability, 'available');
  assert.equal((await service.query(next(query, old), auth())).availability, 'snapshotExpired', '12 MiB overrides traversal preference');
  const admitted = [{ first: fresh, authority: auth() }];
  for (let plugin = 0; plugin < 12; plugin++) {
    const authority = auth(`bytes-${plugin}`), first = await service.query(query, authority);
    if ((admitted.length + 1) * bytes <= 64 * 1024 * 1024) {
      assert.equal(first.availability, 'available'); admitted.push({ first, authority });
    } else assert.equal(first.availability, 'budgetExceeded');
  }
  assert.equal(admitted.length, Math.floor(64 * 1024 * 1024 / bytes));
  for (const { first, authority } of admitted) assert.equal((await service.query(next(query, first), authority)).availability, 'available');
});

test('subscription dependencies include captured calendar, rates and limits but ignore equal context copies', async t => {
  const clock = controlledClock(), { service } = setup(t, { now: clock.now }, clock);
  const stats = fixture(), subscriptions = [], events = [];
  const extras = { subscriptions, subscriptionContext: { date: '2026-10-23', rates: { USD: 1, HKD: 8 } } };
  service.publish(stats, extras);
  service.subscribe('subscriptions', q('subscriptions'), () => auth(), e => events.push(e)); await flush();
  service.publish(stats, { ...extras, subscriptionContext: { ...extras.subscriptionContext, rates: { HKD: 8, USD: 1 } } });
  await clock.advance(1000); assert.equal(events.length, 1);
  service.publish(stats, { ...extras, subscriptionContext: { ...extras.subscriptionContext, date: '2026-10-24' } });
  await clock.advance(1000); assert.equal(events.length, 2);
  service.publish(stats, { ...extras, subscriptionContext: { date: '2026-10-24', rates: { USD: 1, HKD: 9 } } });
  await clock.advance(1000); assert.equal(events.length, 3);
  const withLimits = { ...stats, limits: { providers: [] } };
  const currentExtras = { ...extras, subscriptionContext: { date: '2026-10-24', rates: { USD: 1, HKD: 9 } } };
  service.publish(withLimits, currentExtras);
  await clock.advance(1000); assert.equal(events.length, 4);
  service.publish({ ...withLimits, stale: true }, currentExtras);
  await clock.advance(1000); assert.equal(events.length, 5, 'host freshness suppresses forecasts even when limits identity is unchanged');
});

test('subscription context is detached at publish before any projection or async loader reads it', async t => {
  const { service } = setup(t, {}, { projectResource(_stats, extras) {
    return { availability: 'available', rows: [{ id: 'context', date: extras.subscriptionContext.date, rate: extras.subscriptionContext.rates.HKD }] };
  } });
  const subscriptionContext = { date: '2026-10-23', rates: { USD: 1, HKD: 8 } };
  service.publish(fixture(), { subscriptions: [], subscriptionContext });
  subscriptionContext.date = '2026-10-24'; subscriptionContext.rates.HKD = 9;
  const result = await service.query(q('subscriptions'), auth());
  assert.equal(result.rows[0].date, '2026-10-23'); assert.equal(result.rows[0].rate, 8);
});

test('subscription forecast preflight bounds all account candidates', async t => {
  const { service, calls } = setup(t);
  service.publish({ ...fixture(), limits: { providers: Array.from({ length: 5001 }, (_, i) => ({ accountKey: `a${i}` })) } }, { subscriptions: [] });
  assert.equal((await service.query(q('subscriptions'), auth())).availability, 'budgetExceeded');
  assert.equal(calls(), 0, 'all matching input is charged to the preflight budget');

});


test('lazy scan and page work use the deterministic budget clock; exact cursor survives debt and refill admits new work', async t => {
  let wall = 1000, reads = 0, cost = true;
  const runtime = { performance: { now: () => cost ? Math.floor(++reads / 128) * 40 : Math.floor(reads / 128) * 40 } };
  const { service } = setup(t, { now: () => wall }, runtime);
  service.publish(fixture(5001));
  const query = q('sessions', { page: { limit: 20 } });
  const first = await service.query(query, auth());
  assert.equal(first.availability, 'available');
  cost = false;
  const denied = await service.query(q('sessions', { filter: { search: 'other' } }), auth());
  assert.equal(denied.availability, 'rateLimited');
  assert.ok(Number.isInteger(denied.retryAfterMs) && denied.retryAfterMs > 0);
  assert.equal((await service.query(next(query, first), auth())).availability, 'available');
  wall += denied.retryAfterMs;
  const recovered = await service.query(q('sessions', { filter: { search: 'other' } }), auth());
  assert.equal(recovered.availability, 'available'); assert.equal(recovered.aggregateCoverage.totalRows, 0);
});
