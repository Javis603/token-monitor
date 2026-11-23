'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { runManualDeviceRefresh } = require('../../src/electron/deviceRuntimeCoordinator');
const { createLatestCoalescer } = require('../../src/electron/latestCoalescer');
const { createStatsPublicationBatcher } = require('../../src/electron/statsPublisher');

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const refreshSource = main.slice(main.indexOf('let manualStatsRefreshInFlight ='), main.indexOf('function managedPricingSidecarPath('));
const dockSource = main.slice(main.indexOf('function configuredDockItemLists('), main.indexOf('function edgeDockShowsLiveRate('))
  + main.slice(main.indexOf('// Week / last-7 / last-30 are not collector periods'), main.indexOf('// Hand cells to the controller'));
const pushSource = main.slice(main.indexOf('function sendPush('), main.indexOf('function statsHistoryRevision('));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
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
    desktopQuotaStats: stats => stats,
    syncPluginQuotaSurfaceDemand() {},
    edgeDockController: { isRunning: () => true },
    notchController: null,
    pushEdgeDockCells: (cells) => {
      context.edgeDockCellCoalescer?.cancel();
      context.dockStats = cells.stats;
      context.dockPeriods = cells.derivedPeriods;
    },
    // The live lane coalesces dock cells; these tests exercise the explicit
    // repaint paths, so the queue hands each value straight through with the
    // same projection the immediate path uses.
    edgeDockCellCoalescer: {
      enqueue: (stats) => context.pushEdgeDockCells(context.edgeDockCellsFor(stats)),
      cancel() {}
    },
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
    edgeDockRateHistory: require('../../src/electron/renderer/tokenRatePresentation').createLiveTokenRateHistory(), edgeDockLiveRateSample: () => null,
    statsHistoryRevision: (stats) => stats?.historyRevision,
    injectLocalDeviceStatus: (stats) => stats,
    getAccountPresentationSync: () => ({ notifyStats() {}, refresh: async () => {} }),
    getSyncContentRuntime: () => ({ notifyStats() {} }),
    getLimitsHistoryStore: () => ({ record: (...args) => calls.push(['history', ...args]) }),
    limitsHistoryController: null,
    migrateCodexAdditionalLimits() {},
    rendererSnapshots: { stamp: (_, stats) => stats },
    rendererStats: (stats) => stats,
    buildStatsDelta: () => ({ delta: null, fingerprint: null }),
    fingerprintStats: () => null,
    lastRendererStatsFingerprint: null,
    scheduleMacWidgetSnapshot() {},
    pluginRuntime: null,
    updateTrayDisplay() {},
    mainWindow: null,
    mainWindowStatsPushWanted: () => true,
    dashboardWindow: null,
    maybeAdoptSharedSubscriptionRevision() {},
    console: { log() {} }
  };
  const clock = { now: 0, timers: new Map(), nextId: 0 };
  if (options.realCoalescer) {
    context.edgeDockCellCoalescer = createLatestCoalescer({
      intervalMs: 5000,
      flush: (stats) => context.pushEdgeDockCells(context.edgeDockCellsFor(stats)),
      now: () => clock.now,
      setTimer: (callback, ms) => {
        const id = ++clock.nextId;
        clock.timers.set(id, { at: clock.now + ms, callback });
        return id;
      },
      clearTimer: (id) => clock.timers.delete(id)
    });
  }
  vm.runInNewContext(`${refreshSource}\n${dockSource}\n${pushSource}`, context);
  return {
    context, usage, limits, history, calls,
    advance(ms) {
      clock.now += ms;
      for (const [id, timer] of [...clock.timers]) {
        if (timer.at <= clock.now) { clock.timers.delete(id); timer.callback(); }
      }
    }
  };
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
  context.repaintDockSurfaces();
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
  const syncSource = main.slice(main.indexOf('function syncDockSurfaces('), main.indexOf('function refreshLimitStatsPresentation('));
  Object.assign(context, {
    screenUiSuspended: false,
    canUseEdgeDock: () => true,
    syncNotch() {},
    ensureEdgeDockController: () => ({ setAppearance() {}, sync() {} }),
    edgeDockAppearance: () => ({}),
    scheduleSessionExpiry() {}
  });
  vm.runInNewContext(syncSource, context);
  context.syncDockSurfaces({});
  assert.equal(context.dockStats, fresh, 'settings must re-project the manual snapshot');
  context.hubModeGeneration += 1;
  context.repaintDockSurfaces();
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
    Date,
    edgeDockSessionExpiryTimer: null,
    edgeDockLastCells: [{ metric: 'sessions', runningExpiresAt: Date.now() + 1000 }],
    EDGE_DOCK_EXPIRY_FLOOR_MS: 20,
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout() {}
  });
  const schedulerSource = main.slice(main.indexOf('function edgeDockNextSessionExpiry('), main.indexOf('function ensureEdgeDockController('));
  vm.runInNewContext(schedulerSource, context);
  context.scheduleSessionExpiry();
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(context.dockStats, context.localStats, 'session expiry must retain the manual snapshot');
  limits.resolve();
});

test('App manual-button IPC uses the shared entry; other stats reads retain their options', () => {
  assert.match(main, /options\?\.force === true && options\?\.feedback === true \? refreshManualStats\(\) : fetchStats\(options\)/);
});

for (const first of ['App', 'native']) test(`${first} manual refresh starts one shared plugin refresh without waiting for quota`, async () => {
  const { context, usage, limits } = fixture();
  const quota = deferred(), logs = [];
  let pluginCalls = 0, handler;
  context.pluginRuntime = { refreshLimits: () => { pluginCalls++; return quota.promise; }, manager: { surfaceCatalog: () => [] }, publishStats() {} };
  context.console.log = message => logs.push(message);
  context.statsPushSource = null; context.latestStats = null;
  context.ipcMain = { handle: (_name, fn) => { handler = fn; } };
  const start = main.indexOf("  ipcMain.handle('stats:get',");
  vm.runInNewContext(main.slice(start, main.indexOf("  ipcMain.handle('devices:delete',", start)), context);
  const app = () => handler({}, { force: true, feedback: true });
  const native = () => context.refreshStatsFromEdgeDock();
  const pending = [first === 'App' ? app() : native()];
  assert.equal(pluginCalls, 1, 'the initiating entry point refreshes plugin quotas');
  pending.push(first === 'App' ? native() : app());
  assert.equal(pluginCalls, 1, 'both actual entry points join one plugin refresh');
  usage.resolve(true); await Promise.all(pending);
  quota.reject(Error('synthetic quota failure')); await new Promise(setImmediate);
  assert.ok(logs.some(message => message.includes('[plugins] Limits refresh failed: synthetic quota failure')));
  context.pluginRuntime.refreshLimits = async () => { pluginCalls++; };
  await native(); assert.equal(pluginCalls, 2, 'a later manual action can retry');
  limits.resolve();
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
  context.repaintDockSurfaces();
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
    context.repaintDockSurfaces();
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
  context.repaintDockSurfaces();
  assert.equal(context.dockStats, old);
  nextUsage.resolve(true);
  await pending;
  assert.equal(context.dockStats, old);
  limits.resolve();
});

test('Settings gets completed local quotas before Host, iCloud, or cold Client stats', () => {
  const { accountStatus } = require('../../src/electron/renderer/limits/accountSlotsPanel');
  const accountIdentityApi = require('../../src/electron/renderer/accountIdentity');
  const app = fs.readFileSync(require.resolve('../../src/electron/renderer/app.js'), 'utf8');
  const scope = { provider: 'antigravity', account: null };
  const reading = { provider: 'antigravity', status: 'ok' };
  const result = { updatedAt: '2026-11-19T10:01:00.000Z', providers: [reading] };
  const oldLimits = { updatedAt: result.updatedAt, providers: [] };

  for (const hubMode of ['host', 'icloud', 'client']) {
    const trace = [];
    const publishedLimits = hubMode === 'icloud' ? { providers: [] } : oldLimits;
    const previousStats = hubMode === 'client' ? null : { devices: [{ deviceId: 'here', limits: publishedLimits }] };
    const state = { settings: { deviceId: 'here' }, stats: previousStats };
    const renderer = vm.createContext({
      state, accountIdentityApi, settingsLocalLimits: null, limitProbes: [],
      localDeviceLimitsProviders: () => accountIdentityApi.localDeviceLimitsProviders(state.stats, 'here'),
      isSettingsSurfaceVisible: () => true, preserveSettingsPanelScroll: paint => paint(),
      limitWindowsView: { syncLimitRefreshButtons() {} },
      accountSlotPanels: new Map(), automaticAccountPanels: new Map(), legacyAccountOwners: {
        antigravity: { refreshReadings() {
          trace.push(accountStatus({ enabled: true }, renderer.localProviderStatuses('antigravity')[0],
            true, renderer.limitProbes.some(probe => probe.provider === 'antigravity')));
        } }
      }
    });
    vm.runInContext(app.slice(app.indexOf('function settingsLocalDeviceLimitsProviders('), app.indexOf('function renderWorkbuddyStatus(')), renderer);
    vm.runInContext(app.slice(app.indexOf('function setLimitProbes('), app.indexOf('let limitProbesPushed')), renderer);
    const microtasks = [];
    const mainContext = vm.createContext({
      settings: { deviceId: 'here', hubMode }, edgeDockController: null,
      mainWindow: { isDestroyed: () => false, webContents: { send(_channel, { probes, local }) {
        renderer.setLimitProbes(probes, local);
      } } },
      queueMicrotask: (callback) => microtasks.push(callback)
    });
    vm.runInContext(main.slice(main.indexOf('let limitProbes = [];'), main.indexOf('let copilotLoginController')), mainContext);
    mainContext.publishLimitProbes([scope]);
    mainContext.updateSettingsLocalLimits(result);
    mainContext.publishLimitProbes([]);
    microtasks.shift()();
    assert.deepEqual(trace, ['checking', 'connected'], hubMode);
    assert.deepEqual(renderer.localProviderStatuses('antigravity'), [reading], hubMode);
    assert.equal(state.stats, previousStats, 'the usage/sync snapshot has not arrived');

    state.stats = { devices: [{ deviceId: 'here', limits: { ...result, providers: [{ ...reading, stale: true }] } }] };
    assert.equal(renderer.localProviderStatuses('antigravity')[0].stale, true, 'return to published presentation once it catches up');
    mainContext.clearSettingsLimitState();
    state.stats = previousStats;
    mainContext.publishLimitProbes([scope]);
    mainContext.updateSettingsLocalLimits({ ...result, providers: [] });
    mainContext.publishLimitProbes([]);
    microtasks.shift()();
    assert.deepEqual(trace.slice(-2), ['checking', 'unavailable'], 'a finished check with no reading remains unavailable');
  }
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
    context.repaintDockSurfaces();
    assert.equal(context.dockStats.remote, 'fresh');
  });
}


test('manual App refresh feeds an independently enabled Notch through the same snapshot source', async () => {
  const { context, usage, limits } = fixture();
  context.edgeDockController = null;
  context.notchController = { isRunning: () => true };
  let topStats;
  context.pushNotchCells = (stats) => { topStats = stats; };
  const refreshed = context.refreshManualStats();
  usage.resolve(true);
  await refreshed;
  assert.equal(topStats, context.localStats);
  limits.resolve();
});

test('generic settings/account refresh waits for new limits without dispatching usage', async () => {
  const { context, limits, calls } = fixture();
  let completed = false;
  const request = context.fetchStats({ force: true }).then((stats) => { completed = true; return stats; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false, 'do not return the previous limits snapshot');
  assert.equal(JSON.stringify(calls), JSON.stringify([['limits', { all: true }, 'manual']]));
  context.localStats = { limits: 'fresh' };
  limits.resolve();
  assert.equal(await request, context.localStats);
});

test('manual refresh reconciles older-only usage in Month, All Time and History', async () => {
  const { startCollector, localTodayKey } = require('../../src/shared/collector');
  const { context } = fixture();
  const calls = [];
  let imported = false;
  let graphs = 0;
  const runtime = startCollector({
    clients: 'claude', allTimeSince: '2024-01-01', deviceId: 'manual-history-test',
    intervalMs: 3600000, watchEnabled: false, wslScanEnabled: false,
    historyEnabled: true, historyIntervalMs: 3600000,
    dailyHistoryArchiveEnabled: false, anchorPersistenceEnabled: false,
    sessionUsageArchiveEnabled: false, sessionActivityPolling: false,
    codexLocalUsageEnabled: false, projectsEnabled: false, limitsEnabled: false,
    runTokscale: async ({ flags }) => {
      calls.push(flags);
      const input = flags.includes('--today') ? 10 : imported ? 150 : 100;
      return { entries: [{ client: 'claude', sessionId: 's1', model: 'test', input, output: 0, cost: 0 }] };
    },
    runGraph: async () => {
      graphs += 1;
      return { contributions: [{ date: localTodayKey(new Date(Date.now() - 86400000)), clients: [
        { client: 'claude', modelId: 'test', tokens: { input: imported ? 140 : 90 }, cost: 0 }
      ] }] };
    },
    onUpdate: (summary) => { context.localStats = summary; }
  });
  try {
    await runtime.whenIdle();
    assert.equal(context.localStats.month.totalTokens, 100);
    imported = true;
    context.deviceRuntimeHandle = { refreshLimits: async () => {}, tick: (...args) => runtime.tick(...args) };
    calls.length = 0;
    const beforeGraphs = graphs;
    const stats = await context.refreshManualStats();
    assert.equal(stats.today.totalTokens, 10);
    assert.equal(stats.month.totalTokens, 150);
    assert.equal(stats.allTime.totalTokens, 150);
    assert.equal(stats.history.daily[0].tokens, 140);
    assert.equal(JSON.stringify(calls), JSON.stringify([['--today'], ['--month'], ['--since', '2024-01-01']]));
    assert.equal(graphs, beforeGraphs + 1, 'manual refresh bypasses the History interval');
  } finally {
    await runtime.stop();
  }
});

test('Tray-menu refresh retains its existing full usage request', async () => {
  const { context, usage, limits, calls } = fixture();
  let pluginCalls = 0;
  Object.assign(context, {
    pluginRuntime: { refreshLimits: async () => { pluginCalls++; } },
    trayRefreshInFlight: false,
    captureMacWidgetProducerOwner: () => null,
    runTrayMenuAction: ({ action }) => action(),
    refreshTrayContextMenu() {},
    latestStats: context.localStats,
    showTrayRefreshError: (error) => { throw new Error(error); }
  });
  const trayRefresh = main.slice(main.indexOf('async function refreshFromTray'), main.indexOf('function setTrayContentFromMenu'));
  vm.runInNewContext(trayRefresh, context);
  const request = context.refreshFromTray();
  assert.equal(pluginCalls, 1, 'the Tray menu also refreshes desktop-local plugin quotas');
  assert.equal(JSON.stringify(calls), JSON.stringify([
    ['limits', { all: true }, 'manual'],
    ['usage', 'manual', { forceHistory: false, forceSelfSync: false }]
  ]));
  usage.resolve();
  limits.resolve();
  await request;
});

test('a newer push during a manual read is painted at completion, not after the live floor', async () => {
  const { context, usage, limits, advance } = fixture({ realCoalescer: true });
  const first = { historyRevision: '1', devices: [{ today: 'first' }] };
  const newer = { historyRevision: '2', devices: [{ today: 'newer' }] };
  context.latestStats = first;
  context.sendPush({ event: 'stats', data: { stats: first, reason: 'local' } });
  assert.equal(context.dockStats, first, 'the first push opens the window immediately');

  const request = context.refreshManualStats();
  context.sendPush({ event: 'stats', data: { stats: newer, reason: 'local' } });
  assert.equal(context.dockStats, first, 'the newer push waits behind the floor');

  limits.resolve(true);
  usage.resolve(true);
  await request;
  assert.equal(context.dockStats, newer, 'completion paints the newer snapshot without the timer');

  advance(5000);
  assert.equal(context.dockStats, newer);
});

test('an explicit manual push is not held behind the live floor', () => {
  const { context } = fixture({ realCoalescer: true });
  const live = { historyRevision: '1', devices: [{ today: 'live' }] };
  const manual = { historyRevision: '2', devices: [{ today: 'manual' }] };
  context.latestStats = live;
  context.sendPush({ event: 'stats', data: { stats: live, reason: 'local' } });
  context.sendPush({ event: 'stats', data: { stats: manual, reason: 'manual' } });
  assert.equal(context.dockStats, manual, 'the user-waited refresh is painted at once');
});

test('a publication during an explicit quota probe bypasses the live floor', () => {
  const { context } = fixture({ realCoalescer: true });
  const live = { historyRevision: '1', devices: [{ today: 'live' }] };
  const fresh = { historyRevision: '2', devices: [{ today: 'fresh' }] };
  context.latestStats = live;
  context.sendPush({ event: 'stats', data: { stats: live, reason: 'local' } });

  const request = context.beginEdgeDockExplicitRefresh();
  context.sendPush({ event: 'stats', data: { stats: fresh, reason: 'local' } });
  assert.equal(context.dockStats, fresh, 'the probe publication is painted at once');
  context.finishEdgeDockExplicitRefresh(request, true);

  const batched = { historyRevision: '3', devices: [{ today: 'batched' }] };
  context.sendPush({ event: 'stats', data: { stats: batched, reason: 'local' } });
  assert.equal(context.dockStats, batched, 'the grace window covers the batched publication');
});

test('outside the explicit window the live floor applies again', () => {
  const { context, advance } = fixture({ realCoalescer: true });
  const live = { historyRevision: '1', devices: [{ today: 'live' }] };
  const later = { historyRevision: '2', devices: [{ today: 'later' }] };
  context.latestStats = live;
  context.sendPush({ event: 'stats', data: { stats: live, reason: 'local' } });

  // Leave the expired token in the set: the explicit check must prune it.
  context.beginEdgeDockExplicitRefresh(0);
  context.sendPush({ event: 'stats', data: { stats: later, reason: 'local' } });
  assert.equal(context.dockStats, live, 'outside the window the floor applies again');
  advance(5000);
  assert.equal(context.dockStats, later);
});

test('one probe finishing cannot clear another probe bypass', () => {
  const { context } = fixture({ realCoalescer: true });
  const live = { historyRevision: '1', devices: [{ today: 'live' }] };
  const fresh = { historyRevision: '2', devices: [{ today: 'fresh' }] };
  context.latestStats = live;
  context.sendPush({ event: 'stats', data: { stats: live, reason: 'local' } });

  const first = context.beginEdgeDockExplicitRefresh();
  const second = context.beginEdgeDockExplicitRefresh();
  context.finishEdgeDockExplicitRefresh(first, true);
  context.finishEdgeDockExplicitRefresh(second, false);
  context.sendPush({ event: 'stats', data: { stats: fresh, reason: 'local' } });
  assert.equal(context.dockStats, fresh, 'the successful probe keeps its grace');
});

test('explicit manual and quota-row refreshes paint the rail immediately', () => {
  const provider = main.slice(main.indexOf('async function refreshLimitProvider('), main.indexOf('// The limits probes running right now'));
  assert.match(provider, /const explicitRefresh = beginEdgeDockExplicitRefresh\(\);/);
  assert.match(provider, /settleEdgeDockExplicitRefresh\(explicitRefresh, outcome\.ok\);/);
  assert.match(provider, /settleEdgeDockExplicitRefresh\(explicitRefresh, false\);/);
  const settlePath = main.slice(main.indexOf('function settleEdgeDockExplicitRefresh('), main.indexOf('function updateEdgeDockCells('));
  assert.match(settlePath, /edgeDockCellCoalescer\?\.flushNow\(\);/);
  const manualPath = main.slice(main.indexOf('function refreshManualStats('), main.indexOf('async function fetchStats('));
  assert.match(manualPath, /repaintDockSurfaces\(\);/);
  const pushPath = main.slice(main.indexOf('function sendPush('), main.indexOf('function statsHistoryRevision('));
  assert.match(pushPath, /payload\.data\.reason === 'manual' \|\| edgeDockRefreshIsExplicit\(\)\) updateEdgeDockCells\(visibleStats\);/);
});

test('an explicit paint cancels a queued live snapshot', () => {
  const { context, advance } = fixture({ realCoalescer: true });
  const a = { historyRevision: '1', devices: [{ today: 'a' }] };
  const b = { historyRevision: '2', devices: [{ today: 'b' }] };
  const c = { historyRevision: '3', devices: [{ today: 'c' }] };
  context.latestStats = a;
  context.sendPush({ event: 'stats', data: { stats: a, reason: 'local' } });
  context.sendPush({ event: 'stats', data: { stats: b, reason: 'local' } });
  context.sendPush({ event: 'stats', data: { stats: c, reason: 'manual' } });
  assert.equal(context.dockStats, c, 'the explicit paint wins at once');
  advance(5000);
  assert.equal(context.dockStats, c, 'the cancelled snapshot never replays');
});

test('a settled explicit refresh flushes a queued publication', () => {
  const { context } = fixture({ realCoalescer: true });
  const a = { historyRevision: '1', devices: [{ today: 'a' }] };
  const b = { historyRevision: '2', devices: [{ today: 'b' }] };
  context.latestStats = a;
  context.sendPush({ event: 'stats', data: { stats: a, reason: 'local' } });
  context.sendPush({ event: 'stats', data: { stats: b, reason: 'local' } });
  assert.equal(context.dockStats, a, 'b waits behind the floor');
  context.edgeDockCellCoalescer.flushNow();
  assert.equal(context.dockStats, b, 'settlement paints the queued snapshot');
});
