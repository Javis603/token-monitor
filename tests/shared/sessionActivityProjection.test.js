'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const projection = require('../../src/shared/sessionActivityProjection');
const { sessionWithActivity } = require('../../src/shared/sessionLive');
const claude = require('../../src/shared/providers/claude/sessionActivity');
const { createDeviceState } = require('../../src/shared/usage/deviceState');
const { createDeviceRuntime } = require('../../src/shared/usage/deviceRuntime');
const { composeLocalOnlySummary, projectLocalActivity, completeLocalSyncStats } = require('../../src/electron/syncDisplayStats');
const { createRendererSnapshots, createStatsPresentationCache } = require('../../src/electron/statsPublisher');
const now = Date.parse('2026-10-09T00:01:00Z');
const observation = (state, time = now) => ({ state, observedAt: new Date(time).toISOString() });
function fixture(count = 5000) {
  const sessions = Object.fromEntries(Array.from({ length: count }, (_, i) => [`claude:id-${i}`, {
    client: 'claude', sessionId: `id-${i}`, totalTokens: 100, costUsd: 0, models: {},
    lastUsedAt: '2026-10-01T12:00:00Z', turnEnded: true
  }]));
  return { deviceId: 'test', updatedAt: '2026-10-08T23:59:00Z', today: { sessions: {}, totalTokens: 0 },
    month: { sessions, totalTokens: count * 100 }, allTime: { sessions, totalTokens: count * 100 } };
}

test('historical and cross-midnight activity uses the index without enumerating history again', () => {
  const summary = fixture();
  let traversals = 0;
  const sessions = new Proxy(summary.month.sessions, { ownKeys(target) { traversals += 1; return Reflect.ownKeys(target); } });
  summary.month.sessions = sessions;
  summary.allTime.sessions = sessions;
  const first = claude.projectSessionActivity(summary, new Map([['id-4', observation('waiting')]]), now);
  assert.equal(sessionWithActivity(first.month, 'claude:id-4').liveActivity.state, 'waiting');
  assert.equal(first.month.sessions, summary.month.sessions);
  assert.equal(summary.month.sessions['claude:id-4'].liveActivity, undefined);
  assert.equal(first.today, summary.today);
  const indexed = traversals;
  const running = claude.projectSessionActivity(first, new Map([['id-4', observation('running')]]), now + 2000);
  assert.equal(sessionWithActivity(running.month, 'claude:id-4').liveActivity.state, 'running');
  assert.equal(running.month.sessions, summary.month.sessions);
  assert.equal(traversals, indexed); // even a changed state never copies history
  assert.equal(claude.projectSessionActivity(first, new Map([['id-4', observation('waiting')]]), now + 3000), null);
  assert.equal(traversals, indexed);
  const cleared = claude.projectSessionActivity(first, new Map(), now + 4000);
  const patch = projection.activityPatch(first, cleared);
  assert.deepEqual(patch.observations, [{ client: 'claude', sessionId: 'id-4', liveActivity: observation('unknown', now + 4000) }]);
  assert.ok(JSON.stringify(patch).length < 500);
  assert.equal(cleared.allTime.totalTokens, summary.allTime.totalTokens);
});

test('a first running observation and its waiting transition cross the activity patch lane', () => {
  const baseline = fixture(10);
  const running = claude.projectSessionActivity(baseline, new Map([['id-4', observation('running')]]), now);
  const first = projection.activityPatch(baseline, running);
  assert.deepEqual(first.observations, [{ client: 'claude', sessionId: 'id-4', liveActivity: observation('running') }]);
  const waiting = claude.projectSessionActivity(running, new Map([['id-4', observation('waiting')]]), now + 1000);
  const received = projection.applyActivityPatch(projection.applyActivityPatch(baseline, first), projection.activityPatch(running, waiting));
  assert.equal(sessionWithActivity(received.allTime, 'claude:id-4').liveActivity.state, 'waiting');
  assert.equal(received.allTime.sessions, baseline.allTime.sessions);
  assert.equal(received.updatedAt, baseline.updatedAt);
});

test('history locations use direct keys and evict cold lookups without rescanning canonical maps', () => {
  const baseline = fixture(50_000);
  let traversals = 0;
  let reads = 0;
  const sessions = new Proxy(baseline.allTime.sessions, {
    ownKeys(target) { traversals += 1; return Reflect.ownKeys(target); },
    get(target, key) { reads += 1; return Reflect.get(target, key); }
  });
  baseline.month.sessions = sessions;
  baseline.allTime.sessions = sessions;
  assert.equal(projection.hasKnownSession(baseline, 'claude', 'id-0'), true);
  const seeded = traversals;
  for (let i = 1; i < 600; i += 1) assert.equal(projection.hasKnownSession(baseline, 'claude', `id-${i}`), true);
  const warmed = reads;
  assert.equal(projection.hasKnownSession(baseline, 'claude', 'id-599'), true);
  assert.equal(reads, warmed);
  assert.equal(projection.hasKnownSession(baseline, 'claude', 'id-0'), true);
  assert.ok(reads > warmed); // the oldest location was evicted
  assert.equal(traversals, seeded);
  const changed = { ...baseline, allTime: { ...baseline.allTime, sessions: {} }, month: { ...baseline.month, sessions: {} } };
  assert.equal(projection.hasKnownSession(changed, 'claude', 'id-0'), false);
  assert.equal(projection.hasKnownSession(baseline, 'claude', 'id-0'), true);
});

test('Codex alias lookup prefers verified files and bounds both cached hits and misses', () => {
  const baseline = fixture(10);
  const id = 'rollout-2025-10-01T12-00-00-native-old';
  baseline.allTime.sessions = { ...baseline.allTime.sessions, [`codex:${id}`]: { client: 'codex', sessionId: id } };
  let traversals = 0;
  baseline.allTime.sessions = new Proxy(baseline.allTime.sessions, {
    ownKeys(target) { traversals += 1; return Reflect.ownKeys(target); }
  });
  projection.hasKnownSession(baseline, 'codex', id);
  const seeded = traversals;
  const files = new Map([[id, { nativeId: 'verified-native' }]]);
  assert.deepEqual([...projection.codexActivityCandidates(baseline, ['verified-native'], files)], [id]);
  assert.equal(traversals, seeded);
  assert.deepEqual([...projection.codexActivityCandidates(baseline, ['native-old'])], [id]);
  const cold = traversals;
  assert.deepEqual([...projection.codexActivityCandidates(baseline, ['native-old'])], [id]);
  assert.equal(traversals, cold);
  const misses = Array.from({ length: 600 }, (_, i) => `missing-${i}`);
  assert.equal(projection.codexActivityCandidates(baseline, misses).size, 0);
  const filled = traversals;
  assert.equal(projection.codexActivityCandidates(baseline, ['missing-599']).size, 0);
  assert.equal(traversals, filled);
  assert.equal(projection.codexActivityCandidates(baseline, ['missing-0']).size, 0);
  assert.ok(traversals > filled); // negative entries obey the same retention budget
  assert.deepEqual([...projection.codexActivityCandidates(baseline, ['native-old'])], [id]);
});

test('activity overlays remain cloneable and materialize to ordinary wire rows without leaking local fields', () => {
  const summary = fixture(20);
  const next = projection.applyActivityPatch(summary, { observations: [{ client: 'claude', sessionId: 'id-4', liveActivity: observation('waiting') }] });
  const cloned = structuredClone(next);
  assert.equal(sessionWithActivity(cloned.month, 'claude:id-4').liveActivity.state, 'waiting');
  const ordinary = projection.materializeActivity(next);
  assert.equal(ordinary.month.sessionActivity, undefined);
  assert.equal(ordinary.month.sessions['claude:id-4'].liveActivity.state, 'waiting');
  assert.equal(summary.month.sessions['claude:id-4'].liveActivity, undefined);
  const normalized = require('../../src/shared/usage').normalizeDeviceRecord(next);
  assert.equal(normalized.periods.month.sessionActivity, undefined);
  assert.equal(normalized.periods.month.sessions['claude:id-4'].liveActivity.state, 'waiting');
  assert.equal(require('../../src/electron/renderer/sessionRows').sessionRowsForPeriod(next.month, { now: new Date(now) }).find(row => row.key === 'session:claude:id-4').activityState, 'waiting');
});

test('patches preserve totals, usage freshness, archive exclusions, native clients and prior snapshots', () => {
  const summary = fixture(10);
  summary.month.sessions['claude:id-5'].archived = true;
  summary.nativeSessions = { today: { other: { client: 'reasonix', sessionId: 'other' } } };
  const patch = { observations: [
    { client: 'claude', sessionId: 'id-4', liveActivity: observation('waiting') },
    { client: 'claude', sessionId: 'id-5', liveActivity: observation('waiting') }
  ], nativeSessions: { today: { fresh: { client: 'codex', sessionId: 'new', native: true } } } };
  const next = projection.applyActivityPatch(summary, patch);
  assert.equal(next.updatedAt, summary.updatedAt);
  assert.equal(next.month.totalTokens, summary.month.totalTokens);
  assert.equal(summary.month.sessions['claude:id-4'].liveActivity, undefined);
  assert.equal(next.month.sessions['claude:id-5'].liveActivity, undefined);
  assert.ok(next.nativeSessions.today.other);
  assert.ok(next.nativeSessions.today.fresh);
  const stale = projection.applyActivityPatch(next, { observations: [{ client: 'claude', sessionId: 'id-4', liveActivity: observation('running', now - 1000) }] });
  assert.equal(sessionWithActivity(stale.month, 'claude:id-4').liveActivity.state, 'waiting');
});

test('DeviceState and runtime publish activity separately from accounting and the sink', () => {
  let configured;
  let records = 0;
  let uploads = 0;
  let transforms = 0;
  const patches = [];
  const runtime = createDeviceRuntime({
    transformUsage: (summary) => { transforms += 1; return summary; },
    onRecord: () => { records += 1; }, sink: { enqueue: () => { uploads += 1; } },
    onSessionActivity: (patch) => patches.push(patch)
  }, {
    createUsageRuntime(options) { configured = options; return { stop() {} }; },
    createLimitsRuntime: () => ({ stop() {} })
  });
  const patch = { observations: [{ client: 'claude', sessionId: 'id-4', liveActivity: observation('waiting') }], nativeSessions: {} };
  configured.onSessionActivity(patch);
  assert.equal(patches.length, 0); // no completed baseline yet
  configured.onUpdate(fixture(10), 'startup');
  configured.onSessionActivity(patch);
  assert.equal(records, 1);
  assert.equal(uploads, 1);
  assert.equal(transforms, 1);
  assert.equal(patches.length, 1);
  runtime.stop();
  configured.onSessionActivity(patch);
  assert.equal(patches.length, 1);
  const state = createDeviceState();
  state.updateUsage(fixture(10));
  state.updateActivity(patch);
  patch.observations[0].liveActivity.state = 'running';
  assert.equal(state.getSnapshot().month.sessions['claude:id-4'].liveActivity.state, 'waiting');
});

test('lazy all-time completion and presentation caches retain accounting identity through activity patches', () => {
  const record = fixture(10);
  const summary = composeLocalOnlySummary(record, (value) => value);
  const original = completeLocalSyncStats(summary);
  const snapshots = createRendererSnapshots({ source: () => 'local' });
  const tag = snapshots.stamp(summary, {}).snapshot;
  const cache = createStatsPresentationCache();
  let projections = 0;
  cache.get(summary, 'settings', () => { projections += 1; return summary; });
  const wait = { observations: [{ client: 'claude', sessionId: 'id-4', liveActivity: observation('waiting') }], nativeSessions: {} };
  const next = projectLocalActivity(summary, wait, now);
  const running = { observations: [{ client: 'claude', sessionId: 'id-6', liveActivity: observation('running', now + 3000) }], nativeSessions: {} };
  const latest = projectLocalActivity(next, running, now + 3000);
  assert.equal(completeLocalSyncStats(latest).periods.allTime.sessions['claude:id-4'].liveActivity.state, 'waiting');
  assert.equal(completeLocalSyncStats(latest).periods.allTime.sessions['claude:id-6'].liveActivity.state, 'running');
  assert.equal(original.periods.allTime.sessions['claude:id-4'].liveActivity, undefined);
  assert.deepEqual(snapshots.updateActivity(summary, latest), tag);
  assert.equal(snapshots.get(tag.id), latest);
  cache.updateActivity(summary, latest, (stats) => projection.applyActivityPatch(stats, wait));
  cache.get(latest, 'settings', () => { projections += 1; return latest; });
  assert.equal(projections, 1);
  cache.get(latest, 'changed', () => { projections += 1; return latest; });
  assert.equal(projections, 2);
});

test('same-poll process validations batch together but a new poll always rechecks PID identity', async () => {
  const { createProcessStartBatch } = require('../../src/shared/processStarts');
  const calls = [];
  const read = async (pids, platform) => { calls.push({ pids, platform }); return new Map(pids.map((pid) => [pid, 42])); };
  const batch = createProcessStartBatch(read);
  const [registry, t3] = await Promise.all([batch([12, 34], 'darwin'), batch([34, 56], 'darwin')]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { pids: [12, 34, 56], platform: 'darwin' });
  assert.deepEqual([...registry], [[12, 42], [34, 42]]);
  assert.deepEqual([...t3], [[34, 42], [56, 42]]);
  await batch([34], 'darwin');
  assert.equal(calls.length, 1);
  await createProcessStartBatch(read)([34], 'darwin');
  assert.equal(calls.length, 2);
});

test('successive activity detail pulls compose the accounting baseline only once', () => {
  let compositions = 0;
  const summary = composeLocalOnlySummary(fixture(10), (stats) => { compositions += 1; return stats; });
  const patch = (state, time) => ({ observations: [{ client: 'claude', sessionId: 'id-4', liveActivity: observation(state, time) }], nativeSessions: {} });
  const waiting = projectLocalActivity(summary, patch('waiting', now), now);
  assert.equal(completeLocalSyncStats(waiting).periods.allTime.sessions['claude:id-4'].liveActivity.state, 'waiting');
  const running = projectLocalActivity(waiting, patch('running', now + 3000), now + 3000);
  assert.equal(completeLocalSyncStats(running).periods.allTime.sessions['claude:id-4'].liveActivity.state, 'running');
  assert.equal(compositions, 2); // initial summary and one lazy baseline composition
});

test('Dock reuses accounting rows while resolving fresh activity and native rows', t => {
  const dock = require('../../src/electron/renderer/edgeDock/presentation');
  const clock = Date.now();
  let wall = clock;
  t.mock.method(Date, 'now', () => wall);
  const summary = fixture(100);
  let traversals = 0;
  summary.month.sessions = new Proxy(summary.month.sessions, {
    ownKeys(target) { traversals += 1; return Reflect.ownKeys(target); }
  });
  const stats = { periods: { month: summary.month, today: summary.today } };
  projection.hasKnownSession(stats, 'claude', 'id-4');
  dock.recentSessionRows(stats);
  const warmed = traversals;
  const patch = (state, time) => ({ observations: [{ client: 'claude', sessionId: 'id-4', liveActivity: observation(state, time) }] });
  const waiting = projection.applyActivityPatch(stats, patch('waiting', clock));
  assert.equal(dock.recentSessionRows(waiting).find(row => row.sessionId === 'id-4').liveActivity.state, 'waiting');
  wall += 1000;
  const running = projection.applyActivityPatch(waiting, patch('running', wall));
  assert.equal(dock.recentSessionRows(running).find(row => row.sessionId === 'id-4').liveActivity.state, 'running');
  assert.equal(traversals, warmed);

  const native = { client: 'codex', sessionId: 'new', title: 'Native wait', lastUsedAt: new Date(clock).toISOString(), liveActivity: observation('waiting', clock) };
  const withNative = { ...running, nativeSessions: { today: { 'codex:new': native } } };
  assert.equal(dock.recentSessionRows(withNative)[0].sessionId, 'new');
  assert.equal(dock.recentSessionRows(running).some(row => row.sessionId === 'new'), false);
  assert.equal(traversals, warmed);

  const nextMonth = { ...summary.month, sessions: { ...summary.month.sessions,
    'claude:id-4': { ...summary.month.sessions['claude:id-4'], title: 'Updated usage title' } } };
  const updated = { ...running, periods: { ...running.periods, month: nextMonth } };
  assert.equal(dock.recentSessionRows(updated, 100).find(row => row.sessionId === 'id-4').title, 'Updated usage title');
  assert.equal(dock.recentSessionRows(waiting).find(row => row.sessionId === 'id-4').liveActivity.state, 'waiting');
});

test('clock-skewed synced observations cannot poison Hub merge or block a local waiting patch', t => {
  const clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const { createHub } = require('../../src/hub/server');
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-skew-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = (deviceId, state, time) => ({ deviceId, updatedAt: new Date(clock).toISOString(),
    ...Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, { totalTokens: 100, sessions: {
      'claude:shared': { client: 'claude', sessionId: 'shared', totalTokens: 100,
        lastUsedAt: new Date(clock - 1000).toISOString(), turnEnded: false, liveActivity: observation(state, time) }
    } }])) });
  for (const reverse of [false, true]) {
    const hub = createHub({ dataFile: path.join(dir, String(reverse) + '.json') });
    const local = make('local', 'running', clock - 1000);
    const remote = make('remote', 'idle', clock + 60000);
    for (const record of reverse ? [remote, local] : [local, remote]) hub.ingest(record);
    const aggregate = hub.getStats();
    assert.equal(aggregate.periods.month.sessions['claude:shared'].liveActivity.state, 'running');
    const { composeLocalSyncSummary } = require('../../src/electron/syncDisplayStats');
    const stats = composeLocalSyncSummary(aggregate, local, { nowMs: clock });
    // Exercise a cached aggregate from an older peer as well as the fixed merge.
    stats.periods.month.sessions['claude:shared'].liveActivity = observation('idle', clock + 60000);
    const patch = { observations: [{ client: 'claude', sessionId: 'shared', liveActivity: observation('waiting', clock) }] };
    const next = projectLocalActivity(stats, patch, clock);
    const row = sessionWithActivity(next.periods.month, 'claude:shared');
    assert.equal(row.liveActivity.state, 'waiting');
    assert.equal(next.periods.month.totalTokens, 200);
    assert.equal(next.periods.month.sessions, stats.periods.month.sessions);
    const cleared = projectLocalActivity(next, { observations: [{ ...patch.observations[0], liveActivity: observation('unknown', clock) }] }, clock + 1);

    assert.equal(sessionWithActivity(cleared.periods.month, 'claude:shared').liveActivity.state, 'unknown');
    hub.server.close();
  }
});
