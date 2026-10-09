'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { SESSION_ACTIVITY_PROVIDERS, SESSION_ACTIVITY_CLIENTS, isSessionActivityClient } = require('../../src/shared/sessionActivityProviders');
const { SESSION_ACTIVITY_REGISTRY, sessionActivityProvidersFor, refreshSessionActivity } = require('../../src/shared/sessionActivityRegistry');
const { normalizeClientName } = require('../../src/shared/usage');

const sharedDir = path.join(__dirname, '../../src/shared');
const source = (file) => fs.readFileSync(path.join(sharedDir, file), 'utf8');
const now = Date.parse('2026-10-09T00:01:00Z');
const observation = (state, clock = now) => ({ state, observedAt: new Date(clock).toISOString() });

test('activity declarations bind unique canonical client IDs to the uniform adapter contract', () => {
  assert.deepEqual(SESSION_ACTIVITY_CLIENTS, SESSION_ACTIVITY_REGISTRY.map((entry) => entry.id));
  assert.equal(new Set(SESSION_ACTIVITY_CLIENTS).size, SESSION_ACTIVITY_CLIENTS.length);
  assert.ok(Object.isFrozen(SESSION_ACTIVITY_PROVIDERS));
  for (const entry of SESSION_ACTIVITY_PROVIDERS) {
    assert.ok(Object.isFrozen(entry));
    assert.equal(normalizeClientName(entry.id), entry.id);
    assert.equal(isSessionActivityClient(entry.id), true);
    const adapter = require(`../../src/shared/providers/${entry.id}/sessionActivity`);
    assert.equal(typeof adapter.readActivity, 'function');
    assert.equal(typeof adapter.projectActivity, 'function');
  }
  assert.equal(isSessionActivityClient('unregistered'), false);
  assert.deepEqual(sessionActivityProvidersFor(['unregistered']), []);
  assert.deepEqual(sessionActivityProvidersFor(new Set(['codex', 'codex'])).map((entry) => entry.id), ['codex']);
});

test('selecting providers never loads disabled native adapters', () => {
  const loads = [];
  const context = { module: { exports: {} }, require: (id) => {
    if (id === './sessionActivityProviders') return { SESSION_ACTIVITY_PROVIDERS };
    loads.push(id);
    return { readActivity: () => ({ readings: new Map(), sessions: {} }) };
  } };
  vm.runInNewContext(source('sessionActivityRegistry.js'), context);
  const registry = context.module.exports;
  assert.equal(registry.sessionActivityProvidersFor(['unregistered']).length, 0);
  const codex = registry.sessionActivityProvidersFor(['codex']);
  assert.deepEqual(loads, []);
  codex[0].read({}, {});
  assert.deepEqual(loads, ['./providers/codex/sessionActivity']);
});

test('registered adapters preserve Claude and Codex projection behavior and accounting identity', () => {
  const summary = { updatedAt: new Date(now - 1000).toISOString(), today: { totalTokens: 100, sessions: {
    'claude:c': { client: 'claude', sessionId: 'c', totalTokens: 50 },
    'codex:x': { client: 'codex', sessionId: 'x', totalTokens: 50 }
  } }, month: { sessions: {} }, allTime: { sessions: {} } };
  for (const [client, id] of [['claude', 'c'], ['codex', 'x']]) {
    const activity = { readings: new Map([[id, observation('waiting')]]), sessions: {} };
    const entry = sessionActivityProvidersFor([client])[0];
    const adapter = require(`../../src/shared/providers/${client}/sessionActivity`);
    const expected = client === 'claude'
      ? adapter.projectSessionActivity(summary, activity.readings, now, activity.sessions)
      : adapter.projectSessionActivity(summary, activity, now);
    const actual = entry.project(summary, activity, now);
    assert.deepEqual(actual, expected);
    assert.equal(actual.today.sessions, summary.today.sessions);
    assert.equal(actual.today.totalTokens, 100);
  }
});

test('dispatch shares options, passes each projection to the next adapter, and accepts a third adapter', async () => {
  const calls = [];
  const shared = { homeDir: '/shared', readProcessStarts: () => {}, t3Activity: Promise.resolve(new Map()) };
  const providers = ['claude', 'codex', 'fixture'].map((id) => ({
    id, metadataDepsKey: id,
    async read(summary, options) {
      calls.push({ id, summary, options });
      return { readings: new Map(), sessions: {} };
    },
    project(summary, _activity, clock) { return { ...summary, visited: [...summary.visited, id], clock }; }
  }));
  const baseline = { visited: [], today: { totalTokens: 10 } };
  const next = await refreshSessionActivity(baseline, providers, { sessionMetadataDeps: {
    claude: { marker: 'claude', homeDir: '/wrong' }, codex: { marker: 'codex' }, fixture: { marker: 'third' }
  } }, shared, { now: () => now });
  assert.deepEqual(next.visited, ['claude', 'codex', 'fixture']);
  assert.equal(next.today, baseline.today);
  assert.equal(next.clock, now);
  assert.equal(calls[1].summary.visited[0], 'claude');
  for (const call of calls) {
    assert.equal(call.options.homeDir, shared.homeDir);
    assert.equal(call.options.readProcessStarts, shared.readProcessStarts);
    assert.equal(call.options.t3Activity, shared.t3Activity);
  }
  assert.equal(calls[2].options.marker, 'third');
  assert.deepEqual(baseline.visited, []);
  assert.equal(await refreshSessionActivity(baseline, [], {}, {}), baseline);
});

test('a retired read cannot project or start the next adapter', async () => {
  let current = true;
  let reads = 0;
  let projections = 0;
  const adapter = {
    read: async () => { reads += 1; current = false; return {}; },
    project: () => { projections += 1; return {}; }
  };
  assert.equal(await refreshSessionActivity({}, [adapter, adapter], {}, {}, { isCurrent: () => current }), null);
  assert.equal(reads, 1);
  assert.equal(projections, 0);
  assert.equal(await refreshSessionActivity({}, [adapter], {}, {}, { isCurrent: () => false }), null);
  assert.equal(reads, 1);
});

test('an adapter failure preserves the baseline and prevents later reads', async () => {
  let laterReads = 0;
  const baseline = { today: { sessions: {} } };
  await assert.rejects(refreshSessionActivity(baseline, [
    { read: async () => { throw new Error('reader failed'); } },
    { read: async () => { laterReads += 1; } }
  ], {}, {}), /reader failed/);
  assert.equal(laterReads, 0);
  assert.deepEqual(baseline, { today: { sessions: {} } });
});

test('a third declared client reuses browser patch, materialization, expiry and renewal logic', () => {
  const ids = [...SESSION_ACTIVITY_CLIENTS, 'fixture'];
  const window = { TokenMonitorSessionActivityProviders: {
    SESSION_ACTIVITY_CLIENTS: ids, isSessionActivityClient: (id) => ids.includes(id)
  } };
  const context = vm.createContext({ window });
  for (const file of ['sessionLive.js', 'sessionActivityProjection.js']) vm.runInContext(source(file), context);
  const live = window.TokenMonitorSessionLive;
  const projection = window.TokenMonitorSessionActivityProjection;
  const baseline = { updatedAt: new Date(now).toISOString(), today: { totalTokens: 7, sessions: {
    'fixture:new': { client: 'fixture', sessionId: 'new', lastUsedAt: '2026-09-01T00:00:00Z', turnEnded: true },
    'unregistered:u': { client: 'unregistered', sessionId: 'u' }
  } }, nativeSessions: { today: { keep: { client: 'reasonix' } } } };
  const patch = { observations: [
    { client: 'fixture', sessionId: 'new', liveActivity: observation('waiting') },
    { client: 'unregistered', sessionId: 'u', liveActivity: observation('waiting') }
  ], nativeSessions: { today: { 'fixture:zero': { client: 'fixture', sessionId: 'zero', liveActivity: observation('running') } } } };
  const next = projection.applyActivityPatch(baseline, patch);
  assert.equal(next.today.sessions, baseline.today.sessions);
  assert.equal(next.updatedAt, baseline.updatedAt);
  assert.equal(next.today.totalTokens, 7);
  const row = live.sessionWithActivity(next.today, 'fixture:new');
  assert.equal(live.sessionActivityState(row, now), 'waiting');
  assert.equal(live.sessionActivityState(row, now + live.LIVE_ACTIVITY_TTL_MS), 'idle');
  assert.equal(live.sessionActivityState({ ...row, archived: true }, now), 'idle');
  assert.equal(live.sessionActivityState({ ...row, liveActivity: observation('waiting', now + 1000) }, now), 'idle');
  assert.equal(live.sessionWithActivity(next.today, 'unregistered:u').liveActivity, undefined);
  assert.ok(next.nativeSessions.today.keep);
  assert.ok(next.nativeSessions.today['fixture:zero']);
  assert.equal(projection.needsActivityRenewal(next), true);
  const emitted = projection.activityPatch(baseline, next);
  assert.equal(emitted.observations.length, 1);
  assert.equal(emitted.observations[0].client, 'fixture');
  assert.ok(emitted.nativeSessions.today['fixture:zero']);
  assert.equal(projection.materializeActivity(next).today.sessions['fixture:new'].liveActivity.state, 'waiting');
  // The Hub normalizer uses the same declarations, not its own client list.
  const usageContext = { module: { exports: {} }, require: (id) => {
    if (id === './sessionActivityProviders') return window.TokenMonitorSessionActivityProviders;
    if (id === './sessionLive') return live;
    return require(path.join(sharedDir, id));
  } };
  vm.runInNewContext(source('usage.js'), usageContext);
  const normalized = usageContext.module.exports.normalizeDeviceRecord(next);
  assert.equal(normalized.periods.today.sessions['fixture:new'].liveActivity.state, 'waiting');
  assert.equal(normalized.periods.today.sessions['unregistered:u'].liveActivity, undefined);
});

test('a third native-only adapter reuses bounded SQLite watches without discovering T3', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-registry-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const floor = path.join(home, 'fixture');
  fs.mkdirSync(floor);
  const target = path.join(floor, 'activity.sqlite');
  let t3Discovery = 0;
  const context = { module: { exports: {} }, require: (id) => {
    if (id === './sessionActivityRegistry') return { sessionActivityProvidersFor: () => [{
      id: 'fixture', watchTargets: () => [{ target, floor, kind: 'sqlite' }]
    }] };
    if (id === './t3SessionMetadata') return { discoverT3DbPaths: () => { t3Discovery += 1; return []; } };
    return require(id);
  } };
  vm.runInNewContext(source('sessionActivityWatch.js'), context);
  const watch = context.module.exports;
  const sources = watch.activityWatchSources(['fixture'], { homeDir: home });
  assert.equal(t3Discovery, 0);
  assert.equal(sources.length, 1);
  const ignored = watch.activityWatchIgnored(undefined, [], sources);
  assert.equal(ignored(target), false);
  assert.equal(ignored(`${target}-wal`), false);
  assert.equal(ignored(`${target}-shm`), true);
  assert.equal(ignored(path.join(floor, 'server-runtime.json')), true);
  assert.equal(ignored(path.join(floor, 'private.json')), true);
  assert.equal(watch.activityClientsForPath(`${target}-wal`, sources)[0], 'fixture');
});

test('both renderer entry points load portable declarations before activity consumers', () => {
  const browser = { window: {} };
  vm.runInNewContext(source('sessionActivityProviders.js'), browser);
  assert.deepEqual(Array.from(browser.window.TokenMonitorSessionActivityProviders.SESSION_ACTIVITY_CLIENTS), SESSION_ACTIVITY_CLIENTS);
  for (const file of ['index.html', 'edgeDock/index.html']) {
    const html = fs.readFileSync(path.join(sharedDir, '../electron/renderer', file), 'utf8');
    const declarations = html.indexOf('shared/sessionActivityProviders.js');
    assert.ok(declarations >= 0);
    assert.ok(declarations < html.indexOf('shared/sessionLive.js'));
  }
});
