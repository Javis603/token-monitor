'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { runManualDeviceRefresh } = require('../../src/electron/deviceRuntimeCoordinator');
const { createStatsPublicationBatcher } = require('../../src/electron/statsPublisher');

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const refreshSource = main.slice(main.indexOf('let manualStatsRefreshInFlight ='), main.indexOf('function managedPricingSidecarPath('));
const dockSource = main.slice(main.indexOf('// Week / last-7 / last-30 are not collector periods'), main.indexOf('// Hand cells to the controller'));
const pushSource = main.slice(main.indexOf('function sendPush('), main.indexOf('function statsHistoryRevision('));
const rateDisplaySource = main.slice(main.indexOf('function normalizeEdgeDockRateDisplay('), main.indexOf('function normalizeLiveTokenRateScope('));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const usage = deferred();
  const limits = deferred();
  const history = deferred();
  const calls = [];
  const context = {
    deviceRuntimeHandle: {
      refreshLimits: (...args) => { calls.push(['limits', ...args]); return limits.promise; },
      tick: (...args) => { calls.push(['usage', ...args]); return usage.promise; }
    },
    hubModeGeneration: 1,
    statsPushRevision: 0,
    settings: { hubMode: 'local', limitsEnabled: false, limitProviders: [] },
    mode: 'local',
    localStats: { updatedAt: '2026-10-07T00:00:00Z' },
    currentHubStatsIdentity: () => 'local',
    ownsUsageRuntime: () => Boolean(context.deviceRuntimeHandle),
    runManualDeviceRefresh,
    electronPresentationStats: (stats) => stats,
    edgeDockController: { isRunning: () => true },
    pushEdgeDockCells: (cells) => { context.dockStats = cells.stats; context.dockPeriods = cells.derivedPeriods; },
    buildEdgeDockCells: (stats, options) => ({ stats, derivedPeriods: options.derivedPeriods }),
    EDGE_DOCK_DERIVED_PERIODS: ['week', 'last7', 'last30'],
    fixedPeriodRangesApi: {
      localDayKey: () => '2026-10-07',
      deviceInventorySignature: () => 'devices',
      joinDeviceHistorySources: (_, devices) => devices,
      fixedPeriodSnapshotFromDevices: (_, devices) => ({ status: 'ready', period: devices[0] })
    },
    getDashboardHistory: () => history.promise,
    app: { getLocale: () => 'en' },
    resolveRegionalLocale: () => 'en',
    trayMenuLocale: () => 'en',
    syncCodexPresentationActiveAccount() {},
    syncProvenanceActive: () => true,
    codexAccountsForRenderer: () => [],
    codexPresentationPendingAccountId: '',
    codexPresentationActiveAccountId: '',
    edgeDockLiveRateSample: () => null,
    tokenRateApi: require('../../src/electron/renderer/tokenRatePresentation'),
    statsHistoryRevision: (stats) => stats?.historyRevision,
    injectLocalDeviceStatus: (stats) => stats,
    getSyncContentRuntime: () => ({ notifyStats() {} }),
    migrateCodexAdditionalLimits() {},
    rendererSnapshots: { stamp: (_, stats) => stats },
    rendererStats: (stats) => stats,
    scheduleMacWidgetSnapshot() {},
    updateTrayDisplay() {},
    mainWindow: null,
    dashboardWindow: null,
    maybeAdoptSharedSubscriptionRevision() {},
    console: { log() {} }
  };
  vm.runInNewContext(`${rateDisplaySource}\n${refreshSource}\n${dockSource}\n${pushSource}`, context);
  return { context, usage, limits, history, calls };
}

for (const first of ['App', 'Edge Dock']) {
  test(`${first} and the other refresh button share the existing App refresh`, async () => {
    const { context, usage, limits, calls } = fixture();
    let completed = false;
    const app = () => context.refreshManualStats();
    const dock = () => context.refreshStatsFromEdgeDock();
    const requests = first === 'App' ? [app(), dock()] : [dock(), app()];
    const both = Promise.all(requests).then((values) => { completed = true; return values; });
    assert.equal(JSON.stringify(calls), JSON.stringify([
      ['limits', { all: true }, 'manual'],
      ['usage', 'manual', { forceHistory: true, forceSelfSync: true }]
    ]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    usage.resolve(true);
    const values = await both;
    assert.equal(completed, true, 'background limits must not hold either button open');
    assert.equal(JSON.stringify(values[first === 'App' ? 1 : 0]), JSON.stringify({ ok: true }));
    assert.equal(values[first === 'App' ? 0 : 1], context.localStats);
    assert.equal(context.dockStats, context.localStats);
    limits.reject(new Error('background quota failure'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2, 'each producer was dispatched only once');
  });
}

test('a rejected shared refresh releases both callers and permits retry', async () => {
  const { context, usage, limits, calls } = fixture();
  const error = new Error('usage transport failed');
  const observed = Promise.allSettled([context.refreshManualStats(), context.refreshStatsFromEdgeDock()]);
  usage.reject(error);
  const results = await observed;
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason === error));
  context.deviceRuntimeHandle.tick = async () => true;
  await context.refreshManualStats();
  assert.equal(calls.filter(([source]) => source === 'limits').length, 2);
  limits.resolve();
});

test('runtime or mode replacement does not join an obsolete refresh', async () => {
  const { context, usage, limits } = fixture();
  const old = context.refreshManualStats();
  const nextUsage = deferred();
  let ticks = 0;
  context.hubModeGeneration += 1;
  context.deviceRuntimeHandle = {
    refreshLimits: async () => {},
    tick: () => { ticks += 1; return nextUsage.promise; }
  };
  const next = context.refreshManualStats();
  assert.notEqual(old, next);
  usage.resolve(true);
  await old;
  assert.equal(context.dockStats, undefined, 'an obsolete request must not update the replacement dock source');
  assert.equal(context.refreshManualStats(), next, 'old cleanup must not clear the new request');
  assert.equal(ticks, 1);
  nextUsage.resolve(true);
  await next;
  limits.resolve();
});

test('Edge Dock refresh is available without local collection or limits', async () => {
  const { context, usage, limits } = fixture();
  assert.equal(context.canRefreshEdgeDockStats(), true);
  usage.resolve(true);
  assert.equal(JSON.stringify(await context.refreshStatsFromEdgeDock()), JSON.stringify({ ok: true }));
  limits.resolve();
  context.deviceRuntimeHandle = null;
  assert.equal(context.canRefreshEdgeDockStats(), true);
  assert.equal((await context.refreshStatsFromEdgeDock()).ok, true);
});

test('Client manual refresh paints the fresh Hub response without a stats push or local runtime', async () => {
  const { context } = fixture();
  const old = { updatedAt: 'old' };
  const fresh = { updatedAt: 'fresh' };
  const requests = [];
  context.deviceRuntimeHandle = null;
  context.mode = 'client';
  context.settings.hubMode = 'client';
  context.latestStats = old;
  context.dockStats = old;
  context.effectiveHubConfig = () => ({ url: 'https://hub.example', secret: 'test' });
  context.fetch = async (url) => { requests.push(url); return { ok: true, json: async () => fresh }; };
  context.hubModeRequestIsCurrent = () => true;
  context.setLatestHubStatsCache = () => {};
  context.composeLocalSyncSummary = (stats) => stats;
  context.injectLocalDeviceStatus = (stats) => stats;
  context.lastCollectedDevice = null;
  assert.equal(context.canRefreshEdgeDockStats(), true);
  assert.equal((await context.refreshStatsFromEdgeDock()).ok, true);
  assert.deepEqual(requests, ['https://hub.example/api/stats']);
  assert.equal(context.dockStats, fresh);
  assert.equal(context.latestStats, old, 'a manual read must not become latestStats');
});

test('a delayed derived-period repaint retains the manually refreshed snapshot until a stats push replaces it', async () => {
  const { context, history } = fixture();
  const old = { historyRevision: '1', devices: [{ today: 'old' }] };
  const fresh = { historyRevision: '2', devices: [{ today: 'fresh' }] };
  context.latestStats = old;
  Object.assign(context, {
    deviceRuntimeHandle: null,
    mode: 'client',
    effectiveHubConfig: () => ({ url: 'https://hub.example' }),
    fetch: async () => ({ ok: true, json: async () => fresh }),
    hubModeRequestIsCurrent: () => true,
    setLatestHubStatsCache() {},
    composeLocalSyncSummary: (stats) => stats,
    lastCollectedDevice: null
  });
  context.settings.hubMode = 'client';
  context.settings.edgeDockItems = [{ type: 'stat', metric: 'week' }];
  await context.refreshStatsFromEdgeDock();
  assert.equal(context.dockStats, fresh);
  history.resolve({ fixedPeriods: { historyTransportAvailable: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.dockStats, fresh, 'history completion must not repaint the old push snapshot');
  assert.equal(context.dockPeriods.week, fresh.devices[0]);
  assert.equal(context.latestStats, old, 'manual reads must not change the shared push snapshot');
  const pushed = { historyRevision: '3', devices: [{ today: 'pushed' }] };
  context.sendPush({ event: 'stats', data: { stats: pushed } });
  await new Promise((resolve) => setImmediate(resolve));
  context.repaintEdgeDockCells();
  assert.equal(context.dockStats, pushed, 'a new push must replace the manually refreshed source');
  assert.equal(context.dockPeriods.week, pushed.devices[0]);
});

test('dock re-projections keep manual stats through settings updates but never across a mode generation', async () => {
  const { context, usage, limits } = fixture();
  const old = { updatedAt: 'old' };
  context.latestStats = old;
  usage.resolve(true);
  await context.refreshStatsFromEdgeDock();
  const fresh = context.localStats;
  const syncSource = main.slice(main.indexOf('function syncEdgeDock('), main.indexOf('function refreshLimitStatsPresentation('));
  Object.assign(context, {
    canUseEdgeDock: () => true,
    ensureEdgeDockController: () => ({ setAppearance() {}, sync() {} }),
    edgeDockAppearance: () => ({}),
    scheduleEdgeDockSessionExpiry() {}
  });
  vm.runInNewContext(syncSource, context);
  context.syncEdgeDock({});
  assert.equal(context.dockStats, fresh, 'settings must re-project the manual snapshot');
  context.hubModeGeneration += 1;
  context.repaintEdgeDockCells();
  assert.equal(context.dockStats, old, 'a different mode must not reuse the manual snapshot');
  limits.resolve();
});

test('forecast completion and session expiry re-project the manually refreshed dock source', async () => {
  const { context, usage, limits } = fixture();
  const forecast = deferred();
  const timers = [];
  context.latestStats = { updatedAt: 'old' };
  context.settings.codexResetForecastEnabled = true;
  context.codexResetForecastClient = { getForecast: () => forecast.promise };
  usage.resolve(true);
  await context.refreshStatsFromEdgeDock();
  forecast.resolve({ status: 'ready' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.dockStats, context.localStats, 'forecast completion must retain the manual snapshot');
  Object.assign(context, {
    edgeDockSessionExpiryTimer: null,
    edgeDockLastCells: [{ metric: 'sessions', runningExpiresAt: Date.now() + 1000 }],
    EDGE_DOCK_EXPIRY_FLOOR_MS: 20,
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout() {}
  });
  const schedulerSource = main.slice(main.indexOf('function edgeDockNextSessionExpiry('), main.indexOf('function ensureEdgeDockController('));
  vm.runInNewContext(schedulerSource, context);
  context.scheduleEdgeDockSessionExpiry();
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(context.dockStats, context.localStats, 'session expiry must retain the manual snapshot');
  limits.resolve();
});

test('App manual-button IPC uses the shared entry; other stats reads retain their options', () => {
  assert.match(main, /options\?\.force === true && options\?\.feedback === true \? refreshManualStats\(\) : fetchStats\(options\)/);
});

function clientFixture() {
  const fixtureResult = fixture();
  const { context } = fixtureResult;
  const response = deferred();
  Object.assign(context, {
    deviceRuntimeHandle: null,
    mode: 'client',
    effectiveHubConfig: () => ({ url: 'https://hub.example' }),
    fetch: async () => ({ ok: true, json: () => response.promise }),
    hubModeRequestIsCurrent: () => true,
    setLatestHubStatsCache() {},
    composeLocalSyncSummary: (stats) => stats,
    lastCollectedDevice: null
  });
  context.settings.hubMode = 'client';
  const old = { updatedAt: 'old' };
  context.latestStats = old;
  context.dockStats = old;
  return { ...fixtureResult, response, old };
}

test('App-only Client refresh updates the dock and replaces its previous manual snapshot', async () => {
  const { context, response, old } = clientFixture();
  const fresh = { updatedAt: 'fresh' };
  const request = context.refreshManualStats();
  response.resolve(fresh);
  assert.equal(await request, fresh);
  assert.equal(context.dockStats, fresh);
  assert.equal(context.latestStats, old);
  const newer = { updatedAt: 'newer' };
  context.fetch = async () => ({ ok: true, json: async () => newer });
  assert.equal(await context.refreshManualStats(), newer);
  context.repaintEdgeDockCells();
  assert.equal(context.dockStats, newer);
});

for (const entry of ['App', 'Edge Dock']) {
  test(`${entry} pending manual read cannot overwrite a stats push that arrives before it completes`, async () => {
    const { context, response } = clientFixture();
    const pushed = { historyRevision: '3', devices: [{ today: 'pushed' }] };
    const freshRead = { historyRevision: '2', devices: [{ today: 'read' }] };
    const request = entry === 'App' ? context.refreshManualStats() : context.refreshStatsFromEdgeDock();
    context.sendPush({ event: 'stats', data: { stats: pushed } });
    assert.equal(context.dockStats, pushed);
    response.resolve(freshRead);
    await request;
    assert.equal(context.dockStats, pushed, 'late manual completion must not repaint over the push');
    context.repaintEdgeDockCells();
    assert.equal(context.dockStats, pushed, 'late manual completion must not retain an override');
  });
}

test('runtime replacement without a mode change invalidates the dock manual source and pending completion', async () => {
  const { context, usage, limits } = fixture();
  const old = { updatedAt: 'pushed' };
  context.latestStats = old;
  usage.resolve(true);
  await context.refreshManualStats();
  assert.equal(context.dockStats, context.localStats);
  const nextUsage = deferred();
  context.deviceRuntimeHandle.tick = () => nextUsage.promise;
  const pending = context.refreshManualStats();
  context.deviceRuntimeHandle = null;
  context.repaintEdgeDockCells();
  assert.equal(context.dockStats, old);
  nextUsage.resolve(true);
  await pending;
  assert.equal(context.dockStats, old);
  limits.resolve();
});

for (const entry of ['App', 'Edge Dock']) {
  test(`${entry} Client refresh adopts fresh Hub stats after its pending local publication batch`, async () => {
    const { context, response } = clientFixture();
    const timers = [];
    Object.assign(context, {
      mode: 'sync',
      latestHubStats: { remote: 'old' },
      lastCollectedDevice: { local: 'fresh' },
      composeLocalSyncSummary: (hub, local) => ({ ...hub, ...local }),
      setLatestHubStatsCache: (stats) => { context.latestHubStats = stats; },
      updateDiscordRpcDisplay() {},
      createStatsPublicationBatcher: (options) => createStatsPublicationBatcher({
        ...options,
        setTimeout: (callback) => { timers.push(callback); return timers.length; },
        clearTimeout() {}
      })
    });
    const batchSource = main.slice(main.indexOf('const SYNC_STATS_PUBLISH_WINDOW_MS ='), main.indexOf('function startSyncCollector('));
    vm.runInNewContext(batchSource, context);
    const request = entry === 'App' ? context.refreshManualStats() : context.refreshStatsFromEdgeDock();
    context.requestSyncDisplayStats({ reason: 'local', generation: context.hubModeGeneration });
    assert.equal(timers.length, 1);
    timers[0]();
    assert.equal(context.dockStats.remote, 'old');
    assert.equal(context.dockStats.local, 'fresh');
    response.resolve({ remote: 'fresh' });
    await request;
    assert.equal(context.dockStats.remote, 'fresh');
    assert.equal(context.dockStats.local, 'fresh');
    context.repaintEdgeDockCells();
    assert.equal(context.dockStats.remote, 'fresh');
  });
}
