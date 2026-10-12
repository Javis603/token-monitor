'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const projection = require('../../src/shared/sessionActivityProjection');
const titles = require('../../src/electron/sessionTitleDisplay');
const publisher = require('../../src/electron/statsPublisher');
const syncDisplay = require('../../src/electron/syncDisplayStats');
const { mergedLocalAllTimeSessions } = require('../../src/shared/localSessions');

test('host and iCloud activity snapshots retain the captured local history for TOTAL pulls', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const publishStart = source.indexOf('function publishLocalSessionActivity(');
  const publishEnd = source.indexOf('\n// Two options', publishStart);
  const pullStart = source.indexOf('function rendererAllTimeSessions(');
  const pullEnd = source.indexOf('\nlet codexPresentationPendingSince', pullStart);
  for (const mode of ['host', 'icloud']) {
    const session = { client: 'claude', sessionId: 'past', totalTokens: 500, title: 'Past' };
    const local = { deviceId: 'local', allTime: { sessions: { 'claude:past': session } } };
    const previous = { periods: { today: { sessions: {} }, month: { sessions: {} }, allTime: { sessions: {} } } };
    const snapshots = new WeakMap(); snapshots.set(previous, { localDevice: local });
    const patch = { observations: [{ client: 'claude', sessionId: 'past',
      liveActivity: { state: 'waiting', observedAt: new Date().toISOString() } }],
      nativeSessions: { today: {}, month: {}, allTime: {} } };
    const context = {
      settings: {}, latestStats: previous, localStats: previous, lastCollectedDevice: local, localDevice: local,
      ownsUsageRuntime: () => true, ...syncDisplay, ...projection,
      snapshotLocalDevices: snapshots, rendererSnapshots: publisher.createRendererSnapshots({ source: () => mode }),
      presentationCache: publisher.createStatsPresentationCache(), allTimeSessionsCache: publisher.createStatsPresentationCache(),
      mergedLocalAllTimeSessions, projectModelAliasSessions: (_stats, sessions) => sessions,
      electronPresentationStats: stats => stats, updateEdgeDockCells: () => {}, sendPush: () => {},
      withoutSessionTitles: titles.withoutSessionTitles
    };
    vm.runInNewContext(source.slice(publishStart, publishEnd) + '\n' + source.slice(pullStart, pullEnd), context);
    context.publishLocalSessionActivity(patch);
    const pulled = context.rendererAllTimeSessions(context.latestStats);
    assert.equal(pulled['claude:past']?.totalTokens, 500, mode);
    assert.equal(pulled['claude:past']?.liveActivity?.state, 'waiting', mode);
    assert.equal(local.allTime.sessions['claude:past'].liveActivity, undefined, 'original accounting snapshot is immutable');
  }
});

test('a late TOTAL load reapplies title policy after restoring a previously visible native activity row', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const displayStart = source.indexOf('let localSessionActivity = null;');
  const displayEnd = source.indexOf('\nfunction setRendererSettings(', displayStart);
  const loadStart = source.indexOf('const allTimeSessions = allTimeSessionsApi.');
  const loadEnd = source.indexOf('\nfunction handleWindowVisibilityChange', loadStart);
  const snapshot = { id: 1, source: 'local' };
  const state = { stats: { snapshot, periods: { allTime: {} } }, settings: {} };
  let finish;
  const context = { state, allTimeSessionsApi: require('../../src/electron/renderer/allTimeSessions'),
    allTimeSessionsNeeded: () => true, statsRenderScheduler: { request: () => {} }, console,
    window: { TokenMonitorSessionActivityProjection: projection, TokenMonitorSessionTitleDisplay: titles,
      tokenMonitor: { getAllTimeSessions: () => new Promise(resolve => { finish = resolve; }) } } };
  vm.runInNewContext(source.slice(displayStart, displayEnd) + '\n' + source.slice(loadStart, loadEnd)
    + '\nglobalThis.loader = allTimeSessions;', context);
  context.incoming = { snapshot, patch: { observations: [],
    nativeSessions: { today: { zero: { client: 'claude', sessionId: 'zero', title: 'PRIVATE native title' } } } } };
  vm.runInNewContext('localSessionActivity = incoming;', context);
  context.loader.ensure();
  await Promise.resolve();
  state.settings.sessionTitlesEnabled = false;
  finish({ old: { client: 'claude', sessionId: 'old', title: 'PRIVATE history title', totalTokens: 500 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.stats.periods.allTime.sessions.old.title, undefined);
  assert.equal(state.stats.nativeSessions.today.zero.title, undefined);
  assert.equal(state.stats.periods.allTime.sessions.old.totalTokens, 500);
});

test('renderer activity survives late detail loads on the same accounting snapshot and respects title policy and source changes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = source.indexOf('let localSessionActivity = null;');
  const end = source.indexOf('\nfunction setRendererSettings(', start);
  const context = { state: { settings: { sessionTitlesEnabled: false } }, window: {
    TokenMonitorSessionActivityProjection: projection, TokenMonitorSessionTitleDisplay: titles
  } };
  vm.runInNewContext(source.slice(start, end), context);
  const native = { client: 'claude', sessionId: 'zero', title: 'PRIVATE', native: true };
  context.incoming = { snapshot: { id: 1, source: 'local' }, patch: { observations: [{ client: 'claude', sessionId: 'old',
    liveActivity: { state: 'waiting', observedAt: '2026-10-09T00:01:00Z' } }], nativeSessions: { today: { zero: native } } } };
  vm.runInNewContext('localSessionActivity = incoming;', context);
  const lateDetail = { snapshot: { id: 1, source: 'local' }, periods: { allTime: { sessions: {
    old: { client: 'claude', sessionId: 'old', title: 'PRIVATE', totalTokens: 500 }
  } } } };
  const shown = context.sessionStatsForDisplay(lateDetail);
  assert.equal(require('../../src/shared/sessionLive').sessionWithActivity(shown.periods.allTime, 'old').liveActivity.state, 'waiting');
  assert.equal(shown.periods.allTime.sessions.old.title, undefined);
  assert.equal(shown.nativeSessions.today.zero.title, undefined);
  assert.equal(lateDetail.periods.allTime.sessions.old.liveActivity, undefined);
  for (const snapshot of [{ id: 2, source: 'local' }, { id: 1, source: 'new-hub' }]) {
    const next = { ...lateDetail, snapshot };
    assert.equal(context.applyLocalSessionActivity(next), next);
  }
});


function mainActivityHarness(hubMode, externalAgent = false) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const body = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length));
  const clock = Date.now();
  const row = { client: 'claude', sessionId: 'live', totalTokens: 100, costUsd: 1,
    lastUsedAt: new Date(clock - 5000).toISOString(), turnEnded: false,
    liveActivity: { state: 'running', observedAt: new Date(clock - 5000).toISOString() } };
  const local = { deviceId: 'local', updatedAt: new Date(clock - 5000).toISOString(),
    ...Object.fromEntries(['today', 'month', 'allTime'].map(name =>
      [name, { totalTokens: 100, costUsd: 1, sessions: { 'claude:live': row } }])) };
  const aggregate = () => require('../../src/shared/usage').aggregateDevices([local], 600_000, clock);
  const pushes = [];
  let get;
  const context = {
    console, Date, settings: { hubMode }, mode: 'sync', hubModeGeneration: 1,
    lastCollectedDevice: local, localDevice: null, localStats: null, latestStats: null, statsPushSource: null,
    statsPushRevision: 0, lastExportAt: 0, edgeDockManualStats: null, deviceRuntimeHandle: {},
    ...projection, ...syncDisplay, rendererStats: publisher.rendererStats,
    rendererSnapshots: publisher.createRendererSnapshots({ source: () => context.currentHubStatsIdentity() }),
    snapshotLocalDevices: new WeakMap(), presentationCache: publisher.createStatsPresentationCache(),
    isExternalAgentActive: () => externalAgent,
    canRefreshUsageRuntime: require('../../src/electron/deviceRuntimeCoordinator').canRefreshUsageRuntime,
    embeddedHub: { hub: { getStats: aggregate } }, icloudRuntimeHandle: { getStats: aggregate },
    currentHubStatsCache: () => null, currentHubStatsIdentity: () => hubMode,
    effectiveHubConfig: () => ({ url: 'https://fixture.invalid' }),
    fetch: async () => ({ ok: true, json: async () => aggregate() }),
    modeQueue: Promise.resolve(), setLatestHubStatsCache() {},
    getSyncContentRuntime: () => ({ notifyStats() {} }), electronPresentationStats: stats => stats,
    migrateCodexAdditionalLimits() {}, scheduleMacWidgetSnapshot() {}, updateEdgeDockCells() {},
    syncCodexPresentationActiveAccount() {}, updateTrayDisplay() {}, statsHistoryRevision: () => '',
    maybeAdoptSharedSubscriptionRevision() {}, withoutSessionTitles: titles.withoutSessionTitles,
    mainWindow: { isDestroyed: () => false, webContents: { send: (_topic, payload) => pushes.push(payload) } },
    dashboardWindow: null,
    ipcMain: { handle: (channel, handler) => { if (channel === 'stats:get') get = handler; } }
  };
  vm.runInNewContext(body('function hubModeRequestIsCurrent(', '\nfunction currentHubStatsIdentity(')
    + body('function ownsUsageRuntime(', '\nasync function deleteDeviceFromHub(')
    + body('function injectLocalDeviceStatus(', '\nfunction macWidgetConfiguration(')
    + body('function publishLocalSessionActivity(', '\n// Two options')
    + body('function sendPush(', '\nfunction statsHistoryRevision(')
    + body('async function fetchStats(', '\nfunction managedPricingSidecarPath(')
    + body("  ipcMain.handle('stats:get',", "  ipcMain.handle('devices:delete',"), context);
  const patch = state => ({ observations: [{ client: 'claude', sessionId: 'live',
    liveActivity: { state, observedAt: new Date(clock).toISOString() } }],
    nativeSessions: { today: {}, month: {}, allTime: {} } });
  const state = stats => require('../../src/shared/sessionLive').sessionWithActivity(stats.periods.month, 'claude:live').liveActivity.state;
  return { context, get, aggregate, pushes, patch, state, local };
}

test('stats reads adopt the published snapshot used by subsequent activity patches', async () => {
  for (const mode of ['host', 'icloud', 'client']) {
    const f = mainActivityHarness(mode);
    f.context.sendPush({ event: 'stats', data: { stats: f.aggregate() } });
    const first = f.pushes.at(-1).data.stats.snapshot;
    const pulled = await f.get(null, {});
    assert.notEqual(pulled.snapshot.id, first.id, mode);
    assert.equal(pulled.snapshot.id, f.pushes.at(-1).data.stats.snapshot.id, 'other consumers see the adopted read');
    f.context.publishLocalSessionActivity(f.patch('waiting'));
    const event = f.pushes.at(-1).data;
    assert.equal(event.snapshot.id, pulled.snapshot.id, mode);
    assert.equal(f.state(projection.applyActivityPatch(pulled, event.patch)), 'waiting', mode);
    assert.equal(f.context.rendererSnapshots.get(pulled.snapshot.id), f.context.latestStats);
  }
});

test('full aggregates and reads preserve local waiting and unknown clears without changing accounting', async () => {
  for (const mode of ['host', 'icloud']) {
    const f = mainActivityHarness(mode);
    f.context.sendPush({ event: 'stats', data: { stats: f.aggregate() } });
    for (const state of ['waiting', 'unknown']) {
      f.context.publishLocalSessionActivity(f.patch(state));
      f.context.sendPush({ event: 'stats', data: { stats: f.aggregate() } });
      assert.equal(f.state(f.context.latestStats), state, mode);
      assert.equal(f.state(await f.get(null, {})), state, mode);
      assert.equal(f.context.latestStats.periods.month.totalTokens, 100);
      assert.equal(f.local.month.sessions['claude:live'].liveActivity.state, 'running', 'source record stays immutable');
    }
  }
});

test('a full push arriving during a stats read supersedes the old response', async () => {
  const f = mainActivityHarness('client');
  let resolve;
  f.context.fetch = () => new Promise(done => { resolve = done; });
  const pending = f.get(null, {});
  const newer = f.aggregate(); newer.periods.month.totalTokens = 200;
  f.context.sendPush({ event: 'stats', data: { stats: newer } });
  const current = f.context.latestStats;
  resolve({ ok: true, json: async () => f.aggregate() });
  const pulled = await pending;
  assert.equal(f.context.latestStats, current);
  assert.equal(pulled.periods.month.totalTokens, 200);
  assert.equal(pulled.snapshot.id, f.pushes.at(-1).data.stats.snapshot.id);
});

test('activity follows existing Electron runtime ownership with an HTTP agent alive', () => {
  for (const mode of ['host', 'icloud']) {
    const f = mainActivityHarness(mode, true);
    f.context.sendPush({ event: 'stats', data: { stats: f.aggregate() } });
    f.context.publishLocalSessionActivity(f.patch('waiting'));
    assert.equal(f.state(f.context.latestStats), mode === 'icloud' ? 'waiting' : 'running');
  }
});


test('a retried stats read adopts the new Hub even after the old Hub pushed', async () => {
  for (const changeGeneration of [false, true]) {
    const f = mainActivityHarness('client');
    let hub = 'A'; let resolve;
    f.context.currentHubStatsIdentity = () => hub;
    f.context.fetch = () => hub === 'A' ? new Promise(done => { resolve = done; })
      : Promise.resolve({ ok: true, json: async () => ({ ...f.aggregate(), hub: 'B' }) });
    const pending = f.get(null, {});
    f.context.sendPush({ event: 'stats', data: { stats: { ...f.aggregate(), hub: 'A' } } });
    hub = 'B';
    if (changeGeneration) f.context.hubModeGeneration++;
    resolve({ ok: true, json: async () => ({ ...f.aggregate(), hub: 'A' }) });
    const result = await pending;
    assert.equal(result.hub, 'B');
    assert.equal(f.context.latestStats.hub, 'B');
    assert.equal(result.snapshot.source, 'B');
    assert.equal(result.snapshot.id, f.pushes.at(-1).data.stats.snapshot.id);
  }
});


test('a push from the new Hub still supersedes its pending retried read', async () => {
  const f = mainActivityHarness('client');
  let hub = 'A'; let resolveA; let resolveB;
  f.context.currentHubStatsIdentity = () => hub;
  f.context.fetch = () => new Promise(done => { if (hub === 'A') resolveA = done; else resolveB = done; });
  const pending = f.get(null, {});
  f.context.sendPush({ event: 'stats', data: { stats: { ...f.aggregate(), hub: 'A' } } });
  hub = 'B'; f.context.hubModeGeneration++;
  resolveA({ ok: true, json: async () => f.aggregate() });
  await new Promise(resolve => setImmediate(resolve));
  f.context.sendPush({ event: 'stats', data: { stats: { ...f.aggregate(), hub: 'B-push' } } });
  resolveB({ ok: true, json: async () => ({ ...f.aggregate(), hub: 'B-read' }) });
  assert.equal((await pending).hub, 'B-push');
});

test('a new Hub local collector batch cannot attribute the old Hub push revision to itself', async () => {
  for (const changeGeneration of [false, true]) {
    const f = mainActivityHarness('client');
    const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
    let hub = 'A'; let resolveA; let resolveB; let sink; let batch;
    Object.assign(f.context, {
      latestHubStats: null,
      currentHubStatsIdentity: () => hub,
      setLatestHubStatsCache: stats => { f.context.latestHubStats = stats; },
      fetch: () => new Promise(done => { if (hub === 'A') resolveA = done; else resolveB = done; }),
      createStatsPublicationBatcher: options => {
        batch = publisher.createStatsPublicationBatcher({ ...options, setTimeout: () => 1, clearTimeout() {} });
        return batch;
      },
      createSyncUploadScheduler: () => ({ enqueue: async () => {}, flush() {}, stop() {} }),
      createDeviceRuntime: options => { sink = options.sink; return {}; },
      createElectronUsageRuntime() {}, stopSyncCollector() {}, updateDiscordRpcDisplay() {},
      captureMacWidgetProducerOwner() {}, syncUploadIntervalMs: () => 300_000, postToHub() {},
      seedInitialLimitProviders() {}, usageTransform: { transform: record => record },
      electronUsageConfig: () => ({}), electronDeviceEnvelope: () => ({}),
      electronLimitsConfig: () => ({}), electronLimitsDeps: () => ({}),
      recordDiagnosticEvent() {}, drainPendingRuntimeActions() {}, usageConfigFingerprint: () => '',
      usageRuntimeReconciler: { setActiveKey() {} }
    });
    vm.runInNewContext(source.slice(source.indexOf('const SYNC_STATS_PUBLISH_WINDOW_MS ='),
      source.indexOf('// Host mode:', source.indexOf('function startSyncCollector('))), f.context);
    const pending = f.get(null, {});
    f.context.sendPush({ event: 'stats', data: { stats: { ...f.aggregate(), hub: 'A' } } });
    const revisionA = f.context.statsPushRevision;
    hub = 'B';
    if (changeGeneration) f.context.hubModeGeneration++;
    resolveA({ ok: true, json: async () => f.aggregate() });
    await new Promise(resolve => setImmediate(resolve));
    f.context.startSyncCollector();
    await sink.enqueue(f.local, 1);
    batch.flush();
    assert.equal(f.pushes.at(-1).data.reason, 'local', 'the real collector batch published');
    assert.equal(f.pushes.at(-1).data.stats.snapshot.source, 'B');
    assert.equal(f.context.statsPushRevision, revisionA, 'local batches do not supersede remote reads');
    assert.deepEqual(Array.from(f.context.latestStats.devices, device => device.deviceId), ['local']);
    const remote = { ...f.local, deviceId: 'remote' };
    const fromB = require('../../src/shared/usage').aggregateDevices([f.local, remote], 600_000);
    resolveB({ ok: true, json: async () => fromB });
    const result = await pending;
    assert.deepEqual(Array.from(result.devices, device => device.deviceId).sort(), ['local', 'remote']);
    assert.deepEqual(Array.from(f.context.latestStats.devices, device => device.deviceId).sort(), ['local', 'remote']);
    assert.equal(result.snapshot.source, 'B');
    assert.equal(result.snapshot.id, f.pushes.at(-1).data.stats.snapshot.id);
  }
});
