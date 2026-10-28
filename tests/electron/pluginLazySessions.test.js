'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setImmediate: immediate } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const servicePath = path.resolve(__dirname, '../../src/electron/plugins/businessData.js');
const helper = require('../../src/electron/plugins/lazySessions');
const ledgers = new WeakMap();
let lastLedger;
const compiled = new Module(servicePath, module);
compiled.filename = servicePath; compiled.paths = module.paths;
const normalRequire = compiled.require.bind(compiled);
// These tests assert data/lifetime/retention semantics, not machine throughput.
// Keep work admission deterministic under the full suite's concurrent load;
// pluginBusinessCache separately tests measured debt/refill with a controlled clock.
const workPerformance = { now: () => 0 };
const lazyPath = path.join(path.dirname(servicePath), 'lazySessions.js');
const lazyModule = new Module(lazyPath, module);
lazyModule.filename = lazyPath; lazyModule.paths = module.paths;
const lazyRequire = lazyModule.require.bind(lazyModule);
lazyModule.require = name => name === 'node:perf_hooks' ? { performance: workPerformance } : lazyRequire(name);
lazyModule._compile(fs.readFileSync(lazyPath, 'utf8'), lazyPath);
const semanticHelper = lazyModule.exports;
compiled.require = name => name === 'node:perf_hooks' ? { performance: workPerformance }
  : name === './lazySessions' ? { ...semanticHelper, createSessionBacking(options) { lastLedger = semanticHelper.createSessionBacking(options); return lastLedger; } } : normalRequire(name);
compiled._compile(fs.readFileSync(process.env.BUSINESS_SERVICE_PATH || servicePath, 'utf8'), servicePath);
const { createBusinessDataService } = compiled.exports;
const shared = require('../../src/shared/plugins/businessData');
const { buildSessionIndex } = require('../../src/electron/plugins/lazySessions');
const { applyActivityPatch } = require('../../src/shared/sessionActivityProjection');
const { sessionWithActivity } = require('../../src/shared/sessionLive');
const secret = 'lazy-test';
const authority = { pluginId: 'reader', active: true, revision: 1 };
const q = (rest = {}) => ({ version: 1, resource: 'sessions', page: { limit: 500 }, ...rest });
const id = (kind, value) => `${kind}_${createHmac('sha256', secret).update(JSON.stringify(['reader', 'default', '1', kind, String(value)])).digest('base64url')}`;

for (const count of [2, 5001]) test(`${count} sessions capture activity-only publications and preserve old cursor observations`, async t => {
  const sessions = Object.fromEntries(Array.from({ length: count }, (_, i) => [`codex:s${i}`, {
    client: 'codex', sessionId: `s${i}`, totalTokens: count - i, costUsd: 1,
    liveActivity: { state: 'running', observedAt: '2020-01-01T00:00:00.000Z' }
  }]));
  const stats = { periods: { today: { sessions } } }, service = setup(t, stats);
  const query = q({ sort: { field: 'totalTokens', direction: 'desc' }, page: { limit: 1 } });
  const first = await admitted(service, query, authority, { owner: 'running' });
  assert.equal(first.rows[0].liveActivity.state, 'running');
  assert.equal((await service.query(next(query, first), authority, { owner: 'running' })).rows[0].liveActivity.state, 'running');
  const patch = (input, state, observedAt) => applyActivityPatch(input, { observations: [0, 1].map(i => ({ client: 'codex', sessionId: `s${i}`, liveActivity: { state, observedAt } })) });
  const waiting = patch(stats, 'waiting', '2020-01-01T00:00:01.000Z');
  assert.equal(waiting.periods.today.sessions, sessions);
  service.publish(waiting);
  const fresh = await admitted(service, query, authority, { owner: 'waiting' });
  assert.equal(fresh.snapshotRevision, first.snapshotRevision + 1);
  assert.equal(fresh.aggregateCoverage.totalRows, count);
  assert.deepEqual(fresh.rows[0].liveActivity, sessionWithActivity(waiting.periods.today, 'codex:s0').liveActivity);
  assert.equal((await service.query(next(query, fresh), authority, { owner: 'waiting' })).rows[0].liveActivity.state, 'waiting');
  service.publish(patch(waiting, 'idle', '2020-01-01T00:00:02.000Z'));
  assert.equal((await service.query(next(query, first), authority, { owner: 'running' })).rows[0].liveActivity.state, 'running');
  assert.equal((await service.query(next(query, fresh), authority, { owner: 'waiting' })).rows[0].liveActivity.state, 'waiting');
  assert.equal((await admitted(service, query)).rows[0].liveActivity.state, 'idle');
});

for (const count of [6, 5001]) test(`${count} session activity follows host archive, client and observation ordering rules`, async t => {
  const stats = fixture(count), sessions = stats.periods.today.sessions;
  const period = stats.periods.today;
  period.sessionActivity = {};
  const controls = [
    { client: 'codex' }, { client: 'codex', archived: true }, { client: 'opencode' },
    { client: 'codex', liveActivity: { state: 'running', observedAt: '2020-01-01T00:00:03Z' } },
    { client: 'codex' }, { client: 'codex', sourceDeleted: true }
  ];
  for (let i = 0; i < controls.length; i++) {
    Object.assign(sessions[`key-${i}`], { totalTokens: count - i, liveActivity: { state: 'running', observedAt: '2020-01-01T00:00:00Z' } }, controls[i]);
    period.sessionActivity[`key-${i}`] = { state: 'waiting', observedAt: i === 4 ? '2999-01-01T00:00:00Z' : '2020-01-01T00:00:01Z' };
  }
  const service = setup(t, stats), result = await admitted(service, q({ sort: { field: 'totalTokens', direction: 'desc' }, page: { limit: 6 } }));
  assert.equal(result.availability, 'available');
  for (let i = 0; i < controls.length; i++) assert.deepEqual(result.rows[i].liveActivity, sessionWithActivity(period, `key-${i}`).liveActivity);
  assert.equal(result.rows[0].liveActivity.state, 'waiting');
  assert.ok(result.rows.slice(1).every(row => row.liveActivity.state === 'running'));
});

test('activity overlays share backing accounting, count as captured generations and release with their last reader', async t => {
  let time = 1000;
  const stats = fixture(5001), sessions = stats.periods.today.sessions;
  const service = setup(t, stats, { now: () => time }), ledger = ledgers.get(service);
  const query = q({ page: { limit: 1 } });
  let previousBytes = 0;
  for (let i = 0; i < 4; i++) {
    const sessionActivity = { 'key-1': { state: 'waiting', observedAt: `2020-01-01T00:00:0${i}Z`, hidden: 'x'.repeat(2048) } };
    service.publish({ periods: { today: { sessions, sessionActivity } } }); time += 10000;
    const first = await admitted(service, query, authority, { owner: `overlay-${i}` });
    assert.equal(first.availability, 'available');
    await service.query(next(query, first), authority, { owner: `overlay-${i}` });
    assert.equal(ledger.usage().sources, i + 2);
    assert.equal(ledger.usage().generations, i + 1);
    assert.equal(ledger.usage().measuredRows, 5002 + i);
    assert.ok(ledger.bytes() > previousBytes + 4096, 'unprojected overlay bytes stay charged');
    previousBytes = ledger.bytes();
  }
  service.publish({ periods: { today: { sessions, sessionActivity: {} } } }); time += 10000;
  assert.equal((await service.query(query, authority)).availability, 'budgetExceeded');
  service.releaseOwner('overlay-0');
  assert.equal(ledger.usage().generations, 3);
  assert.ok(ledger.bytes() < previousBytes);
  assert.equal((await admitted(service, query, authority, { owner: 'replacement' })).availability, 'available');
  for (const owner of ['overlay-1', 'overlay-2', 'overlay-3', 'replacement']) service.releaseOwner(owner);
  assert.equal(ledger.bytes(), 0);
});

test('filtered-out oversized activity observations cannot bypass lazy backing admission', async t => {
  const stats = fixture(5001);
  stats.periods.today.sessionActivity = { unrelated: { state: 'waiting', observedAt: '2020-01-01T00:00:00Z', hidden: 'x'.repeat(256 * 1024) } };
  const service = setup(t, stats);
  const result = await admitted(service, q({ filter: { search: 'no-match' } }));
  assert.equal(result.availability, 'budgetExceeded');
  assert.equal(ledgers.get(service).bytes(), 0);
});
function fixture(count = 10037) {
  const sessions = {};
  for (let i = 0; i < count; i++) sessions[`key-${i}`] = { sessionId: `s${i}`, client: i % 2 ? 'codex' : 'claude', title: `Session ${i % 11}`, projectLabel: 'Project', projectId: '/private/path', totalTokens: i % 17, costUsd: i % 19 ? i % 7 : null, unpricedTokens: i % 3, lastUsedAt: '2026-10-23T00:00:00Z', models: { [i % 2 ? 'a' : 'b']: 3 }, modelCosts: { a: 0 }, providers: {}, promptCache: { ttlSeconds: 1800 }, liveActivity: { state: 'idle' }, secret: 'NEVER_EXPOSE' };
  const period = { sessions };
  return { updatedAt: '2026-10-23T00:00:00Z', periods: { today: period, month: period, allTime: period }, devices: [] };
}
async function admitted(service, query, auth = authority, options) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const result = await service.query(query, auth, options);
    if (result.availability !== 'rateLimited') return result;
    assert.ok(Number.isInteger(result.retryAfterMs) && result.retryAfterMs > 0);
    assert.ok(Date.now() + result.retryAfterMs <= deadline, 'rate denial must recover within 10 seconds');
    await new Promise(resolve => setTimeout(resolve, result.retryAfterMs));
  }
}
function setup(t, stats = fixture(), options = {}, extras = {}) {
  const service = createBusinessDataService({ identitySecret: secret, ...options });
  ledgers.set(service, lastLedger);
  service.publish(stats, extras); t.after(() => service.dispose()); return service;
}
const next = (query, result) => ({ ...query, page: { ...query.page, cursor: result.pageInfo.nextCursor } });
async function traverse(service, query, auth = authority, first) {
  let result = first || await service.query(query, auth), rows = [], total;
  do {
    assert.equal(result.availability, 'available');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 56 * 1024);
    total ??= result.aggregateCoverage.totalRows;
    assert.equal(result.aggregateCoverage.totalRows, total);
    rows.push(...result.rows);
    result = result.pageInfo.hasMore ? await service.query(next(query, result), auth) : null;
  } while (result);
  assert.equal(rows.length, total); return rows;
}
function oracle(stats, query, auth = authority, extras = {}) {
  const normalized = shared.normalizeQuery(query);
  let rows = shared.projectResource(stats, extras, normalized, auth, id).rows;
  // Legacy DTO operations, independently spelled out to check compact keys.
  for (const [field, value] of Object.entries(query.filter || {})) {
    if (field === 'deviceId') continue;
    if (field === 'search') rows = rows.filter(r => typeof r.title === 'string' && r.title.toLowerCase().includes(value.toLowerCase()));
    else if (field === 'model') rows = rows.filter(r => r.models.some(m => m.model === value));
    else rows = rows.filter(r => r[field] === value);
  }
  const compare = (a, b) => a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : 1;
  rows.sort((a, b) => {
    const field = normalized.sort.field;
    const c = compare(field === 'knownUsd' ? a.cost.knownUsd : a[field], field === 'knownUsd' ? b.cost.knownUsd : b[field]);
    return (normalized.sort.direction === 'desc' ? -c : c) || compare(a.id, b.id);
  });
  return rows;
}
test('10037 rich sessions fully traverse in oracle order with duplicate sort keys and stable captured contents', async t => {
  const stats = fixture(), service = setup(t, stats), query = q({ sort: { field: 'totalTokens', direction: 'desc' } });
  let heartbeats = 0, running = true;
  const pulse = async () => { while (running) { await immediate(); heartbeats++; } };
  const heartbeat = pulse(), firstPending = service.query(query, authority);
  await immediate();
  service.publish(fixture(2)); // Update during scan must not restart old work.
  const first = await firstPending;
  running = false; await heartbeat;
  assert.equal(first.availability, 'available');
  assert.ok(heartbeats > 10, `real event loop turns: ${heartbeats}`);
  assert.equal(first.aggregateCoverage.totalRows, 10037);
  assert.equal(first.snapshotRevision, 1);
  const second = await service.query(next(query, first), authority);
  service.publish(fixture(1)); // Also update between cursor pages.
  assert.equal(second.snapshotRevision, 1);
  const rows = await traverse(service, query, authority, first);
  assert.equal(new Set(rows.map(r => r.id)).size, 10037);
  assert.deepEqual(rows, oracle(stats, query));
  assert.doesNotMatch(JSON.stringify(rows), /NEVER_EXPOSE|"sessionId"/);
  assert.equal((await admitted(service, query, authority)).aggregateCoverage.totalRows, 1);
});
for (const sort of ['totalTokens', 'id', 'knownUsd', 'lastUsedAt', 'label', 'updatedAt', 'date']) test(`large compact ${sort} keys and filters equal full DTO oracle`, async t => {
  const stats = fixture();
  Object.assign(stats.periods.today.sessions['key-1'], { totalTokens: NaN, costUsd: -4, title: 'z'.repeat(512) + 'hidden-suffix' });
  Object.assign(stats.periods.today.sessions['key-3'], { totalTokens: -4, costUsd: Infinity });
  const service = setup(t, stats);
  const query = q({ filter: { client: 'codex', model: 'a' }, sort: { field: sort, direction: 'desc' } });
  assert.deepEqual(await traverse(service, query), oracle(stats, query));
});
test('large title-disabled sessions cannot search hidden values; relation filters use opaque canonical IDs', async t => {
  const stats = fixture(), service = setup(t, stats), query = q({ filter: { projectId: id('project', 'aggregate:project') }, sort: { field: 'totalTokens' } });
  assert.deepEqual(await traverse(service, query), oracle(stats, query));
  service.publish(stats, { preferences: { sessionTitlesEnabled: false } });
  const empty = await admitted(service, q({ filter: { search: 'Session' } }), authority);
  assert.equal(empty.aggregateCoverage.totalRows, 0);
});
test('large lifetime coverage distinguishes partial, scoped complete and remote unavailable with duplicate identities preserved', async t => {
  const stats = fixture(), period = stats.periods.allTime;
  // Deliberately duplicated canonical IDs are separate accounting rows.
  period.sessions['key-1'] = { ...period.sessions['key-0'] };
  const extras = { allTime: { sessionSources: [
    { deviceId: 'local', periods: { allTime: period }, sessionDetailAvailable: true },
    { deviceId: 'remote', periods: { allTime: { totalTokens: 3 } }, sessionDetailAvailable: false }
  ] } };
  const service = setup(t, stats, {}, extras), query = q({ period: 'allTime', sort: { field: 'label' } });
  const first = await admitted(service, query, authority);
  assert.equal(first.aggregateCoverage.kind, 'partial');
  const rows = await traverse(service, query, authority, first);
  assert.deepEqual(rows, oracle(stats, query, authority, extras));
  assert.equal(rows.length, 10037); assert.equal(new Set(rows.map(r => r.id)).size, 10036);
  assert.equal((await admitted(service, { ...query, filter: { deviceId: id('device', 'local') } }, authority)).aggregateCoverage.kind, 'authorizedCollection');
  assert.equal((await admitted(service, { ...query, filter: { deviceId: id('device', 'remote') } }, authority)).availability, 'notCollected');
});
for (const action of ['releaseOwner', 'signal', 'revoke', 'dispose', 'auth', 'privacy-roundtrip', 'source-roundtrip']) test(`pending large build cancels on ${action}`, async t => {
  const stats = fixture(), service = setup(t, stats), controller = new AbortController(); let active = true;
  const pending = service.query(q(), () => ({ ...authority, active }), { owner: 'closing', signal: controller.signal });
  await immediate();
  if (action === 'signal') controller.abort();
  else if (action === 'auth') active = false;
  else if (action.endsWith('roundtrip')) {
    service.publish(stats, action.startsWith('privacy') ? { preferences: { sessionTitlesEnabled: false } } : { sourceId: 'other' });
    service.publish(stats);
  } else service[action](action === 'revoke' ? 'reader' : 'closing');
  assert.equal((await pending).availability, action.endsWith('roundtrip') ? 'snapshotExpired' : 'denied');
  await immediate(); await immediate();
  assert.equal(ledgers.get(service).bytes(), 0, 'cancelled build releases all measured source bytes');
});
test('deduped build survives releasing one sibling; released last owner drops its retained lazy cursor', async t => {
  const service = setup(t), query = q();
  const one = service.query(query, authority, { owner: 'one' }), two = service.query(query, authority, { owner: 'two' });
  await immediate(); service.releaseOwner('one');
  assert.equal((await one).availability, 'denied');
  const first = await two; assert.equal(first.availability, 'available');
  service.releaseOwner('two');
  assert.equal((await service.query(next(query, first), authority)).availability, 'snapshotExpired');
});
test('unsubscribe cancels initialization while a live sibling gets exactly one snapshot', async t => {
  const service = setup(t), closed = [], live = [];
  const id = service.subscribe('one', q(), () => authority, value => closed.push(value));
  const delivered = new Promise(resolve => service.subscribe('two', q(), () => authority, value => { live.push(value); resolve(); }));
  await immediate(); service.unsubscribe('one', id);
  await delivered; assert.equal(closed.length, 0); assert.equal(live.length, 1);
  assert.equal(live[0].value.aggregateCoverage.totalRows, 10037);
});
test('lifetime build pins old loader capture through an ordinary publish and owner closes without waiting for loader', async t => {
  let finish;
  const stats = fixture(), service = setup(t, stats, { loadAllTime: () => new Promise(resolve => { finish = resolve; }) });
  const query = q({ period: 'allTime' });
  const one = service.query(query, authority, { owner: 'one' }); await immediate();
  service.releaseOwner('one'); assert.equal((await one).availability, 'denied');
  const two = service.query(query, authority, { owner: 'two' }); await immediate();
  service.publish(fixture(2)); finish(stats.periods.allTime);
  assert.equal((await two).aggregateCoverage.totalRows, 10037);
});
test('lazy TTL is non-sliding, and expiry during a build refuses an incomplete collection', async t => {
  let time = 1000;
  const service = setup(t, fixture(), { now: () => time, snapshotTtlMs: 100 });
  const first = await service.query(q(), authority); time += 90;
  assert.equal((await service.query(next(q(), first), authority)).availability, 'available');
  time += 11;
  assert.equal((await service.query(next(q(), first), authority)).availability, 'snapshotExpired');
  // Refill measured-work debt before starting the separate build-expiry case.
  // The previous cursor has already expired; the new build gets its own 100ms TTL.
  time += 60000;
  const pending = service.query(q(), authority); await immediate(); time += 101;
  assert.equal((await pending).availability, 'snapshotExpired');
});
test('resource refusals have no exact total; oversized output row never masquerades as end of collection', async t => {
  const stats = fixture();
  stats.periods.today.sessions['key-0'].secret = 'x'.repeat(300000);
  const service = setup(t, stats);
  const failed = await service.query(q({ filter: { search: 'no-match' } }), authority);
  assert.equal(failed.availability, 'budgetExceeded'); assert.equal(failed.aggregateCoverage.totalRows, null);
  const big = fixture();
  big.periods.today.sessions['key-0'].totalTokens = -1;
  big.periods.today.sessions['key-0'].models = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`model-${i}`, 1]));
  service.publish(big);
  assert.equal((await service.query(q({ sort: { field: 'totalTokens' } }), authority)).availability, 'payloadTooLarge');
});
test('bounded distinct builds refuse excess demand; exact query siblings share one build', async t => {
  const service = setup(t), pending = [];
  for (let i = 0; i < 3; i++) pending.push(service.query(q({ filter: { search: String(i) } }), authority, { owner: `o${i}` }));
  const sibling = service.query(q({ filter: { search: '0' } }), authority, { owner: 'sibling' });
  assert.equal((await pending[2]).availability, 'budgetExceeded');
  assert.equal((await pending[0]).availability, 'available'); assert.equal((await pending[1]).availability, 'available');
  assert.equal((await sibling).availability, 'available');
});
test('bounded sort/merge yields after scanning and cancels before admission', async () => {
  const stats = fixture(), query = shared.normalizeQuery(q()), plan = shared.sessionSources(stats, {}, query, id);
  let checks = 0, sortChecks = 0, scanning = true;
  const last = stats.periods.today.sessions['key-10036'];
  Object.defineProperty(last, 'title', { enumerable: true, get() { scanning = false; return 'last'; } });
  const callbacks = { charge() {}, check() {
    checks++; if (!scanning && ++sortChecks > 100) throw new Error('denied');
  } };
  const lease = helper.createSessionBacking().pin(plan, 'reader', callbacks);
  const pending = buildSessionIndex(plan, query, id, { ...callbacks, lease });
  await assert.rejects(pending, /denied/);
  lease.release();
  assert.ok(checks > 100); assert.ok(sortChecks > 100);
});
test('synthetic event-loop probe reports chunked first-page latency without a machine-specific timing assertion', async t => {
  const service = require(servicePath).createBusinessDataService({ identitySecret: secret }), query = q();
  service.publish(fixture()); t.after(() => service.dispose());
  let stopped = false, last = performance.now(), maxGap = 0, turns = 0;
  const monitor = (async () => { while (!stopped) { await immediate(); const current = performance.now(); maxGap = Math.max(maxGap, current - last); last = current; turns++; } })();
  const start = performance.now(), first = await service.query(query, authority), duration = performance.now() - start;
  stopped = true; await monitor;
  assert.equal(first.availability, 'available'); assert.ok(turns > 10);
  t.diagnostic(JSON.stringify({ rows: first.aggregateCoverage.totalRows, firstPageMs: duration, maxImmediateGapMs: maxGap, eventLoopTurns: turns }));
});

// Same 30k shapes as the independent review, including unprojected raw fields.
function benchmarkFixture(count, rich) {
  const sessions = {};
  for (let i = 0; i < count; i++) {
    const row = { sessionId: `session-${i}`, client: 'codex', title: `Session ${i}`, totalTokens: i % 97, costUsd: i % 7, models: { model: i } };
    if (rich) Object.assign(row, { projectLabel: 'Project', projectId: '/private/path/project', unpricedTokens: i % 3, lastUsedAt: '2026-10-23T00:00:00Z', modelCosts: { model: 0 }, providers: { provider: i }, promptCache: { observedAt: '2026-10-23T00:00:00Z', ttlSeconds: 1800 }, liveActivity: { state: 'idle', observedAt: '2026-10-23T00:00:00Z' }, secret: 'NEVER_EXPOSE' });
    sessions[`key-${i}`] = row;
  }
  return { updatedAt: '2026-10-23T00:00:00Z', periods: { today: { sessions } }, devices: [] };
}
for (const rich of [false, true]) test(`30000 ${rich ? 'rich' : 'slim'} sessions traverse every DTO with shared backing`, async t => {
  const stats = benchmarkFixture(30000, rich), service = setup(t, stats);
  const query = q({ sort: { field: 'totalTokens', direction: 'desc' } });
  const first = await admitted(service, query, authority, { owner: 'first' });
  assert.equal(first.availability, 'available');
  assert.equal(first.aggregateCoverage.totalRows, 30000);
  assert.deepEqual(await traverse(service, query, authority, first), oracle(stats, query));
  const ledger = ledgers.get(service), before = ledger.usage();
  assert.ok(before.bytes > (rich ? 64 : 20) * 1024 * 1024, 'all raw backing remains globally charged');
  const otherQuery = q({ sort: { field: 'id' } });
  assert.equal((await admitted(service, otherQuery, authority, { owner: 'second' })).availability, 'available');
  const otherPlugin = { ...authority, pluginId: 'other-plugin' };
  const other = await admitted(service, query, otherPlugin, { owner: 'other-plugin' });
  assert.equal(other.availability, 'available');
  assert.notEqual(other.rows[0].id, first.rows[0].id, 'opaque IDs are never shared');
  assert.deepEqual(ledger.usage(), before, 'queries and plugins share physical backing and its measurement');
  assert.equal((await service.query(next(query, first), otherPlugin)).availability, 'invalidCursor');
  const empty = await admitted(service, q({ filter: { search: 'impossible-no-match' } }));
  assert.equal(empty.availability, 'available'); assert.equal(empty.aggregateCoverage.totalRows, 0);
  assert.deepEqual(ledger.usage(), before);
  service.revoke('reader'); assert.equal(ledger.bytes(), before.bytes);
  service.releaseOwner('other-plugin'); assert.equal(ledger.bytes(), 0);
});
test('30000 rich zero-match query measures raw backing and releases its generation', async t => {
  const service = setup(t, benchmarkFixture(30000, true));
  const result = await admitted(service, q({ filter: { search: 'no-match' } }));
  assert.equal(result.availability, 'available'); assert.equal(result.aggregateCoverage.totalRows, 0);
  assert.equal(ledgers.get(service).usage().measuredRows, 30000);
  assert.equal(ledgers.get(service).bytes(), 0);
});
test('COW generations share unchanged row measurements and release only the last physical pin', async t => {
  let time = 1000;
  const stats = fixture(6000), service = setup(t, stats, { now: () => time });
  const first = await admitted(service, q(), authority, { owner: 'old' }), ledger = ledgers.get(service);
  const before = ledger.usage();
  const sessions = { ...stats.periods.today.sessions, 'key-0': { ...stats.periods.today.sessions['key-0'], title: 'Updated' } };
  service.publish({ ...stats, periods: { today: { sessions } } }); time += 10000;
  // Mark old as traversed so its snapshot is not replaced by the new first page.
  assert.equal((await service.query(next(q(), first), authority, { owner: 'old' })).availability, 'available');
  const fresh = await admitted(service, q(), authority, { owner: 'new' });
  assert.equal(fresh.availability, 'available');
  assert.equal(ledger.usage().measuredRows, 6001);
  assert.equal(ledger.usage().generations, 2);
  assert.ok(ledger.bytes() > before.bytes && ledger.bytes() < before.bytes * 1.3);
  service.releaseOwner('old'); assert.equal(ledger.usage().generations, 1);
  assert.ok(Math.abs(ledger.bytes() - before.bytes) < 100);
  time += 60001;
  assert.equal((await service.query(next(q(), fresh), authority)).availability, 'snapshotExpired');
  assert.equal(ledger.bytes(), 0);
});
test('four generation entitlement refuses a fifth, then owner release allows recovery', async t => {
  let time = 1000;
  const service = setup(t, fixture(5001), { now: () => time });
  const firsts = [];
  for (let i = 0; i < 4; i++) {
    service.publish(fixture(5001)); time += 1000;
    const first = await admitted(service, q(), authority, { owner: `owner-${i}` });
    assert.equal(first.availability, 'available'); firsts.push(first);
    await service.query(next(q(), first), authority, { owner: `owner-${i}` });
  }
  service.publish(fixture(5001)); time += 10000;
  const failure = await service.query(q(), authority);
  assert.equal(failure.availability, 'budgetExceeded'); assert.equal(failure.aggregateCoverage.totalRows, null);
  assert.equal(ledgers.get(service).usage().generations, 4);
  service.releaseOwner('owner-0');
  assert.equal((await admitted(service, q(), authority)).availability, 'available');
  assert.equal((await service.query(next(q(), firsts[0]), authority)).availability, 'snapshotExpired');
});
test('shared backing survives one distinct build cancellation and drops after final release', async t => {
  const service = setup(t), ledger = ledgers.get(service);
  const one = service.query(q(), authority, { owner: 'one' });
  const two = service.query(q({ sort: { field: 'totalTokens' } }), authority, { owner: 'two' });
  await immediate(); service.releaseOwner('one');
  assert.equal((await one).availability, 'denied');
  assert.equal((await two).availability, 'available');
  assert.equal(ledger.usage().measuredRows, 10037);
  service.releaseOwner('two'); assert.equal(ledger.bytes(), 0);
});
test('source backing stays charged while an evicted snapshot has an active page', async t => {
  let time = 1000;
  const service = setup(t, fixture(6000), { now: () => time }), ledger = ledgers.get(service);
  const first = await admitted(service, q(), authority, { owner: 'page' });
  const pending = service.query(next(q(), first), authority, { owner: 'page' });
  service.revoke('reader');
  assert.ok(ledger.bytes() > 0, 'active page owns the final source pin');
  assert.equal((await pending).availability, 'denied');
  await immediate(); assert.equal(ledger.bytes(), 0);
  time += 10000;
});
test('global backing cap counts independent raw generations and recovers after reclamation', async t => {
  let time = 1000;
  const service = setup(t, benchmarkFixture(30000, true), { now: () => time }), ledger = ledgers.get(service);
  const first = await admitted(service, q(), authority, { owner: 'old' });
  assert.equal(first.availability, 'available');
  service.publish(benchmarkFixture(30000, true)); time += 10000;
  const denied = await service.query(q(), { ...authority, pluginId: 'second' });
  assert.equal(denied.availability, 'budgetExceeded'); assert.equal(denied.aggregateCoverage.totalRows, null);
  assert.equal(ledger.usage().generations, 1);
  service.releaseOwner('old'); assert.equal(ledger.bytes(), 0);
  time += 10000;
  assert.equal((await admitted(service, q(), { ...authority, pluginId: 'second' })).availability, 'available');
});

test('incremental index ceiling remains 32 MiB even when 100000 rows share tiny backing', async t => {
  const row = fixture(1).periods.today.sessions['key-0'];
  const sessions = Object.fromEntries(Array.from({ length: 100000 }, (_, i) => [`key-${i}`, row]));
  const service = setup(t, { periods: { today: { sessions } } });
  const result = await service.query(q(), authority);
  assert.equal(result.availability, 'budgetExceeded'); assert.equal(result.aggregateCoverage.totalRows, null);
  assert.equal(ledgers.get(service).bytes(), 0);
});
test('per-plugin incremental 64 MiB guard rejects excess indices below global backing cap', async t => {
  let time = 1000;
  const service = setup(t, benchmarkFixture(30000, false), { now: () => time });
  const fields = ['id', 'totalTokens', 'knownUsd', 'lastUsedAt', 'updatedAt'];
  for (const field of fields) {
    time += 10000;
    assert.equal((await service.query(q({ sort: { field } }), authority)).availability, 'available');
  }
  time += 10000;
  const denied = await service.query(q({ sort: { field: 'date' } }), authority);
  assert.equal(denied.availability, 'budgetExceeded'); assert.equal(denied.aggregateCoverage.totalRows, null);
  assert.equal(ledgers.get(service).usage().generations, 1);
  service.revoke('reader'); assert.equal(ledgers.get(service).bytes(), 0);
});
test('snapshot slot eviction keeps shared backing until its last retained query is released', async t => {
  let time = 1000;
  const service = setup(t, fixture(5001), { now: () => time }), ledger = ledgers.get(service);
  let first;
  for (let i = 1; i <= 9; i++) {
    time += 5000;
    const query = q({ page: { limit: i } });
    const result = await service.query(query, authority, { owner: 'all' });
    assert.equal(result.availability, 'available'); first ??= result;
  }
  assert.equal((await service.query(next(q({ page: { limit: 1 } }), first), authority)).availability, 'snapshotExpired');
  assert.equal(ledger.usage().generations, 1); assert.equal(ledger.usage().measuredRows, 5001);
  service.releaseOwner('all'); assert.equal(ledger.bytes(), 0);
});
test('shared ledger has eight global generation slots independently of byte and plugin limits', async () => {
  const ledger = helper.createSessionBacking(), leases = [];
  const callbacks = { check() {}, charge() {} };
  const plan = () => ({ contexts: [{ sessions: { row: { title: 'tiny' } } }] });
  for (let i = 0; i < 8; i++) { const lease = ledger.pin(plan(), `plugin-${i}`, callbacks); leases.push(lease); await lease.ready(); }
  assert.throws(() => ledger.pin(plan(), 'plugin-9', callbacks), /budgetExceeded/);
  assert.equal(ledger.usage().generations, 8);
  leases.shift().release();
  const replacement = ledger.pin(plan(), 'plugin-9', callbacks); await replacement.ready(); replacement.release();
  for (const lease of leases) lease.release();
  assert.equal(ledger.bytes(), 0);
});
