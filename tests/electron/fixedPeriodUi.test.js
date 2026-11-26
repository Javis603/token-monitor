'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const read = (name) => fs.readFileSync(path.join(rendererDir, name), 'utf8');

test('reset restores the configured middle range from a custom selection', () => {
  const source = read('app.js');
  const start = source.indexOf('function setRendererSettings(next)');
  const end = source.indexOf('function periodContentAvailability()', start);
  const fixedPeriodRangesApi = require('../../src/electron/renderer/fixedPeriodRanges');
  for (const [active, configured, expected] of [
    ['last7', 'month', 'month'],
    ['last30', 'week', 'week'],
    ['today', 'month', 'today'],
    ['allTime', 'month', 'allTime']
  ]) {
    const state = { period: active, settings: { periodTabOrder: ['today', 'month', 'last7', 'last30', 'allTime'], periodMonthMode: configured } };
    let followed = 0;
    const context = {
      state, fixedPeriodRangesApi, tokenNumberAnimationApi: { normalize: value => value },
      setPeriod(period) { state.period = period; return true; },
      followOpenSessionToPeriod() { followed++; }
    };
    vm.runInNewContext(source.slice(start, end), context);
    context.setRendererSettings({ periodTabOrder: [], periodMonthMode: configured });
    context.setRendererSettings({ periodTabOrder: [], periodMonthMode: configured });
    assert.equal(state.period, expected);
    assert.equal(followed, Number(active !== expected));
  }
});

test('fixed periods reuse the existing three-slot control', () => {
  const html = read('index.html');
  const slots = [...html.matchAll(/data-period-slot="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(slots, ['today', 'month', 'allTime']);
  assert.match(html, /data-period-slot="today"[^>]*>DAY<\/button>/);
  assert.match(html, /id="monthPeriodTab"[^>]*aria-haspopup="menu"[^>]*>MONTH<\/button>/);
  assert.match(html, /data-period-slot="allTime"[^>]*>TOTAL<\/button>/);
  assert.doesNotMatch(html, /id="monthPeriodTab"[^>]*>[^<]*(?:▼|▾|⌄)/);
});

test('the middle-slot menu and Settings expose the same fixed choices', () => {
  const html = read('index.html');
  const menu = html.slice(html.indexOf('id="monthPeriodMenu"'), html.indexOf('class="actions-hotspot"'));
  const setting = html.slice(html.indexOf('id="periodMonthModeInput"'), html.indexOf('</select>', html.indexOf('id="periodMonthModeInput"')));
  const expected = ['month', 'yesterday', 'week', 'last7', 'last30'];
  assert.deepEqual([...menu.matchAll(/data-fixed-period="([^"]+)"/g)].map((match) => match[1]), expected);
  assert.deepEqual([...setting.matchAll(/option value="([^"]+)"/g)].map((match) => match[1]), expected);
});

test('fixed-period menu follows the glass theme and keeps labels left aligned', () => {
  const html = read('index.html');
  const css = read('styles.css');
  const app = read('app.js');
  const i18n = read('i18n.js');
  const boot = read('floatingBubbleBoot.js');
  assert.ok(html.indexOf('src="fixedPeriodRanges.js"') < html.indexOf('src="app.js"'));
  assert.match(html, /id="monthPeriodMenu" class="view-switcher-menu period-menu hidden"/);
  assert.equal((html.match(/class="view-switcher-menu-item"/g) || []).length, 5);
  assert.match(css, /\.view-switcher-menu-item\s*\{[^}]*font-size:\s*0\.6875rem;[^}]*text-align:\s*left;/s);
  assert.ok(css.lastIndexOf('.period-menu {') > css.indexOf('.view-switcher-menu {'));
  assert.match(css, /\.titlebar\.period-menu-open\s*\{\s*z-index:\s*13;/);
  assert.match(css, /\.period-menu\s*\{[^}]*-webkit-app-region:\s*no-drag;[^}]*pointer-events:\s*auto;/s);
  assert.match(app, /closest\('\.titlebar'\)\?\.classList\.toggle\('period-menu-open', state\.periodMenuOpen\)/);
  assert.match(app, /button\.classList\.toggle\('is-current', active\)/);
  assert.match(app, /handlePeriodMenuNavigation\(event/);
  assert.match(app, /setPeriodMenuOpen\(true, \{ focus: event\.key === 'ArrowUp' \? 'last' : 'first' \}\)/);
  assert.match(app, /deviceRowsAvailable: Array\.isArray\(state\.fixedPeriodHistory\?\.deviceHistories\)/);
  assert.match(app, /getDashboardHistory\(\{ includeDevices: true \}\)/);
  assert.match(app, /state\.stats\?\.deviceHistoryRevision \|\| state\.stats\?\.historyRevision/);
  assert.match(app, /deviceInventorySignature\(state\.stats\?\.devices \|\| \[\]\)/);
  assert.match(app, /FIXED_PERIOD_HISTORY_MAX_RETRIES = 3/);
  assert.match(app, /fixedPeriodHistoryInventoriesMatch\(fetchedHistory\)/);
  assert.match(app, /shouldRetryFixedPeriodHistory\(\{/);
  assert.match(app, /setTimeout\(\(\) => \{[\s\S]*?void loadFixedPeriodHistory\(\{ force: true \}\);[\s\S]*?FIXED_PERIOD_HISTORY_RETRY_MS\)/);
  const refreshStats = app.slice(
    app.indexOf('async function refreshStats'),
    app.indexOf('function onStatsPush')
  );
  assert.match(refreshStats, /await warmFixedPeriodHistory\(\{[\s\S]*?force: forceFixedPeriodHistory,[\s\S]*?retryFailed: forceFixedPeriodHistory,[\s\S]*?renderOnComplete: false[\s\S]*?\}\);/);
  assert.match(refreshStats, /statsRenderScheduler\.request\(\);\s*void warmFixedPeriodHistory\(\{[\s\S]*?force: forceFixedPeriodHistory,[\s\S]*?retryFailed: forceFixedPeriodHistory,[\s\S]*?renderOnComplete: false[\s\S]*?\}\);/);
  const loader = app.slice(app.indexOf('async function performFixedPeriodHistoryLoad'), app.indexOf('function loadFixedPeriodHistory'));
  assert.doesNotMatch(loader, /status: 'loading'[\s\S]*?if \(fixedPeriodRangesApi\.isDerived\(state\.period\)\) render\(\);/);
  assert.match(app, /createLatestRequestCoordinator\(\{/);
  assert.match(app, /function currentCalendarLocale\(\)[\s\S]*?resolveRegionalLocale\(\[\.\.\.preferredLanguages\(\), state\.settings\?\.locale\]\)/);
  assert.match(app, /fixedPeriodSnapshotFromDevices\(state\.period, fixedPeriodSources\(\), \{[\s\S]*?locale: currentCalendarLocale\(\)/);
  assert.match(app, /force: forceFixedPeriodHistory,[\s\S]*?retryFailed: forceFixedPeriodHistory/);
  assert.match(app, /isDerived\(next\) && state\.fixedPeriodHistoryFailed[\s\S]*?warmFixedPeriodHistory\(\{ retryFailed: true, renderOnComplete: true \}\)/);
  assert.match(app, /fixedPeriodHistorySignature !== signature[\s\S]*?\|\| state\.fixedPeriodHistoryBusy\) \{[\s\S]*?void loadFixedPeriodHistory\(\);/);
  assert.match(boot, /\['today', 'month', 'yesterday', 'week', 'last7', 'last30', 'allTime'\]\.includes\(period\)/);
  assert.match(app, /function fixedPeriodDevices\(\)/);
  assert.match(app, /devicesForReadySnapshot\(state\.fixedPeriodSnapshot, state\.period, localDevice\)/);
  assert.match(app, /fixedPeriodSnapshotFromDevices\(state\.period, fixedPeriodSources\(\)/);
  const snapshotBuilder = app.slice(app.indexOf('function buildFixedPeriodSnapshot()'), app.indexOf('async function loadFixedPeriodHistory'));
  assert.ok(snapshotBuilder.indexOf('historyEnabled === false') < snapshotBuilder.indexOf('fixedPeriodHistoryRequested'));
  assert.match(snapshotBuilder, /readySnapshotForSelection\([\s\S]*?state\.fixedPeriodSnapshot,[\s\S]*?state\.period/);
  assert.doesNotMatch(css, /\.period-menu button\s*\{/);
  assert.match(html, /id="fixedPeriodMessage"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(app, /periodRange\.tokenComponentsUnavailable/);
  assert.match(app, /attributionComponent\(period, 'clientUnclassifiedTokens', client\)/);
  assert.match(app, /attributionComponent\(period, 'modelUnclassifiedTokens', model\)/);
  assert.match(app, /dashboard\.tooltip\.unclassified/);
  assert.match(i18n, /'dashboard\.tooltip\.unclassified': '未分類'/);
});

test('the Settings default uses the standard title-control-description row', () => {
  const html = read('index.html');
  const css = read('styles.css');
  const i18n = read('i18n.js');
  const setting = html.slice(
    html.indexOf('<div class="settings-item period-default-setting">'),
    html.indexOf('</div>', html.indexOf('<div class="settings-item period-default-setting">'))
  );
  assert.ok(setting.indexOf('settings-item-title') < setting.indexOf('id="periodMonthModeInput"'));
  assert.ok(setting.indexOf('id="periodMonthModeInput"') < setting.indexOf('settings-item-desc'));
  assert.doesNotMatch(css, /\.period-default-setting\s*\{[^}]*align-items:/s);
  assert.match(setting, /data-i18n="periodRange\.settingsTitle">Default usage range</);
  assert.match(setting, /data-i18n="periodRange\.settingsNote">Choose the default usage range shown on Home\./);
  assert.doesNotMatch(css, /\.period-default-setting select\s*\{[^}]*min-width:/s);
  assert.doesNotMatch(html, /Middle period button/);
  assert.match(i18n, /'periodRange\.settingsTitle': '預設統計範圍'/);
  assert.match(i18n, /'periodRange\.settingsNote': '選擇主畫面預設顯示的統計範圍。也可在主畫面再次點擊上方目前選取的時段，開啟選單快速切換。'/);
});

test('cold-start boot restores every fixed middle-slot selection', () => {
  const boot = read('floatingBubbleBoot.js');
  for (const period of ['week', 'last7', 'last30']) {
    const window = { location: { search: `?period=${period}&breakdown=home` } };
    const document = { documentElement: { classList: { add() {} } } };
    vm.runInNewContext(boot, { document, URLSearchParams, window });
    assert.deepEqual(
      JSON.parse(JSON.stringify(window.__TOKEN_MONITOR_INITIAL_VIEW_STATE__)),
      { period, breakdown: 'home' }
    );
  }
});

test('a pending local scan shows loading copy for missing range details', () => {
  const source = read('app.js');
  const state = { stats: { nativeRangesPending: true } };
  const context = { state, t: (key) => key };
  vm.runInNewContext(source.slice(source.indexOf('function fixedPeriodMessage('),
    source.indexOf('function hidePeriodContentForMessage(')), context);
  const ready = { status: 'ready' };
  assert.equal(context.fixedPeriodMessage(ready, 'session'), 'periodRange.sessionLoading');
  assert.equal(context.fixedPeriodMessage(ready, 'project'), 'periodRange.projectLoading');
  assert.equal(context.fixedPeriodMessage({ status: 'loading' }), 'periodRange.loading');
  state.stats = {};
  assert.equal(context.fixedPeriodMessage(ready, 'session'), 'periodRange.sessionUnavailable');
  assert.equal(context.fixedPeriodMessage(ready, 'project'), 'periodRange.projectUnavailable');
});

test('refresh renders native Devices before the pending History read completes', async () => {
  const source = read('app.js');
  const state = { period: 'last7', breakdown: 'device' };
  const stats = { nativeRangeWindows: { last7: {} } };
  let resolveHistory;
  const history = new Promise(resolve => { resolveHistory = resolve; });
  let rendered = 0;
  const context = {
    state,
    window: { tokenMonitor: { getStats: async () => stats } },
    observeLiveTokenRate() {},
    observeDisplayLiveTokenRates() {},
    allTimeSessions: { invalidate() {}, attach: value => value },
    sessionStatsForDisplay: value => value,
    applyCodexActiveAccountFromStats() {},
    currentNativeRangeSnapshot: () => state.stats === stats,
    syncedFixedPeriodKey: () => '',
    fixedPeriodRangesApi: { isDerived: () => true },
    statsRenderScheduler: { request() { rendered++; } },
    warmFixedPeriodHistory: () => history,
    maybeUpdateBarsIcon() {}
  };
  const gate = source.match(/function canRenderNativeDevices\(\) \{[^}]+\}/)?.[0];
  if (gate) vm.runInNewContext(gate, context);
  vm.runInNewContext(source.slice(source.indexOf('async function refreshStats('),
    source.indexOf('async function refreshStatusViewManually(')), context);
  const refresh = context.refreshStats();
  await new Promise(setImmediate);
  assert.equal(rendered, 1);
  resolveHistory();
  await refresh;
  assert.equal(rendered, 2);
});

test('fixed Week History and Trends use the synchronized calendar even with a different viewer locale', () => {
  const source = read('app.js');
  const context = {
    fixedPeriodRangesApi: require('../../src/electron/renderer/fixedPeriodRanges'),
    fixedPeriodTodayKey: () => '2026-11-25',
    currentCalendarLocale: () => 'en-US',
    syncedFixedPeriodKey: () => 'selected',
    state: {
      mode: 'sync', period: 'week', settings: { syncWeekStartsOn: 1 },
      fixedPeriodHistory: { fixedPeriods: { historyTransportAvailable: true } },
      syncedFixedPeriod: { key: 'selected', snapshot: { status: 'ready', period: { totalTokens: 25 } } }
    },
    fixedPeriodSources: () => [{
      deviceId: 'remote', historyAvailable: true,
      periodWindows: { today: { key: '2026-11-25', endsAt: '2099-11-26T00:00:00Z' }, timeZone: 'UTC' },
      history: { daily: [
        { date: '2026-11-22', tokens: 11 },
        { date: '2026-11-23', tokens: 25 }
      ] }
    }]
  };
  const extract = (name) => source.match(new RegExp('function ' + name + '\\(\\) \\{[\\s\\S]*?\\n\\}'))[0];
  vm.runInNewContext(extract('buildFixedPeriodSourcesSnapshot') + '\n' + extract('buildFixedPeriodSnapshot'), context);
  assert.equal(context.buildFixedPeriodSourcesSnapshot().period.totalTokens, 25);
  const trends = context.buildFixedPeriodSnapshot().summary;
  assert.equal(trends.peakDayTokens, 25);
  assert.equal(trends.activeDays, 1);
  context.state.mode = 'local';
  assert.equal(context.buildFixedPeriodSourcesSnapshot().period.totalTokens, 36);
});

for (const hubMode of ['icloud', 'client']) test(`${hubMode} retries incomplete fixed range details without another stats event`, async () => {
  const source = read('app.js').match(/function requestSyncedFixedPeriod\(\) \{[\s\S]*?\n\}/)[0];
  let key = 'week';
  let reads = 0;
  const responses = [null, { detailsAvailable: false }, { detailsAvailable: true }, null, null, { detailsAvailable: true }];
  const timers = new Set();
  const context = {
    state: { settings: { hubMode }, stats: { snapshot: { id: 'a' } } },
    window: { tokenMonitor: { getSyncedFixedPeriod: async () => responses[reads++] } },
    syncedFixedPeriodKey: () => key,
    readSyncedFixedPeriod: () => context.window.tokenMonitor.getSyncedFixedPeriod(),
    statsRenderScheduler: { request() {} },
    FIXED_PERIOD_HISTORY_RETRY_MS: 4000,
    FIXED_PERIOD_HISTORY_MAX_RETRIES: 3,
    setTimeout: (callback, delay) => {
      assert.equal(delay, 4000);
      timers.add(callback);
      return callback;
    },
    clearTimeout: callback => timers.delete(callback)
  };
  vm.runInNewContext(source, context);
  const fireRetry = async () => {
    assert.equal(timers.size, 1);
    const [callback] = timers;
    timers.delete(callback);
    callback();
    await Promise.resolve();
  };
  context.requestSyncedFixedPeriod();
  await Promise.resolve();
  context.requestSyncedFixedPeriod();
  assert.equal(reads, 1);
  await fireRetry();
  await fireRetry();
  assert.equal(reads, 3);
  assert.equal(context.state.syncedFixedPeriod.snapshot.detailsAvailable, true);
  assert.equal(timers.size, 0);

  key = 'last7';
  context.requestSyncedFixedPeriod();
  await Promise.resolve();
  key = 'today';
  await fireRetry();
  assert.equal(reads, 4);
  assert.equal(timers.size, 0);

  key = 'yesterday';
  context.requestSyncedFixedPeriod();
  key = 'today';
  await Promise.resolve();
  assert.equal(timers.size, 0);
  key = 'yesterday';
  context.requestSyncedFixedPeriod();
  await Promise.resolve();
  assert.equal(reads, 6);
  assert.equal(context.state.syncedFixedPeriod.snapshot.detailsAvailable, true);
});

test('a new fallback device observation invalidates a completed synchronized range', async () => {
  const source = read('app.js');
  const context = {
    state: {
      period: 'week',
      stats: {
        snapshot: { id: 'snapshot-1', source: 1 },
        fixedRangeRevisions: { native: 'range-1' },
        deviceHistoryRevision: 'history-1',
        devices: [
          { deviceId: 'native', updatedAt: '2026-11-25T01:00:00Z' },
          { deviceId: 'legacy', updatedAt: '2026-11-25T01:00:00Z', periods: { today: { totalTokens: 0 } } }
        ]
      }
    },
    fixedPeriodRangesApi: { isDerived: () => true, deviceDayState: () => ({ currentKey: '2026-11-25' }) },
    currentCalendarLocale: () => 'en-GB',
    fixedPeriodTodayKey: () => '2026-11-25',
    statsRenderScheduler: { request() {} },
    FIXED_PERIOD_HISTORY_RETRY_MS: 4000,
    FIXED_PERIOD_HISTORY_MAX_RETRIES: 3,
    setTimeout,
    clearTimeout
  };
  const reads = [];
  context.window = { tokenMonitor: { getSyncedFixedPeriod: async id => {
    reads.push(id);
    return { detailsAvailable: true };
  } } };
  const extract = name => source.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'))[0];
  context.readSyncedFixedPeriod = () => context.window.tokenMonitor.getSyncedFixedPeriod(context.state.stats.snapshot.id);
  vm.runInNewContext(['syncedFixedPeriodKey', 'syncedFixedPeriodScope', 'requestSyncedFixedPeriod'].map(extract).join('\n'), context);

  context.requestSyncedFixedPeriod();
  await Promise.resolve();
  assert.equal(context.state.syncedFixedPeriod.retryAt, Infinity);

  context.state.stats.snapshot = { id: 'snapshot-2', source: 1 };
  context.requestSyncedFixedPeriod();
  assert.deepEqual(reads, ['snapshot-1'], 'a new snapshot ID alone leaves the cache intact');

  const legacy = context.state.stats.devices[1];
  legacy.updatedAt = '2026-11-25T02:00:00Z';
  legacy.periods.today.totalTokens = 25;
  context.requestSyncedFixedPeriod();
  await Promise.resolve();
  assert.deepEqual(reads, ['snapshot-1', 'snapshot-2']);
});

test('fixed-range refreshes keep sessions and projects visible until the replacement is ready', async () => {
  const { context, state, reads } = syncedRangeHarness();
  for (const period of ['week', 'yesterday', 'last7', 'last30']) {
    state.period = period;
    context.requestSyncedFixedPeriod();
    reads.at(-1).finish(rangeDetails(20));
    await new Promise(setImmediate);

    state.stats.devices[0].updatedAt += 1;
    context.requestSyncedFixedPeriod();
    state.fixedPeriodSnapshot = context.buildFixedPeriodSnapshot();
    assert.equal(state.fixedPeriodSnapshot.period.totalTokens, 20);
    for (const breakdown of ['session', 'project', 'model', 'device', 'trends']) {
      state.breakdown = breakdown;
      assert.equal(context.periodContentAvailability().fixedUnavailable, false, breakdown);
      assert.equal(context.periodContentAvailability().detailUnavailable, false, breakdown);
    }
    reads.at(-1).finish(rangeDetails(25));
    await new Promise(setImmediate);
    assert.equal(context.buildFixedPeriodSnapshot().period.totalTokens, 25);
  }
});

test('a visible range warms once, is reused on selection, and drops stale text across a revision change', async () => {
  const { context, state, reads } = syncedRangeHarness();
  state.period = 'today';
  context.warmSyncedFixedPeriod();
  context.warmSyncedFixedPeriod();
  assert.deepEqual(reads.map(read => read.period), ['week']);
  reads[0].finish(rangeDetails(20));
  await new Promise(setImmediate);

  state.period = 'week';
  context.requestSyncedFixedPeriod();
  assert.equal(reads.length, 1);
  assert.equal(context.buildFixedPeriodSnapshot().period.sessions.example.title, 'Synced title');
  await new Promise(setImmediate);

  state.stats.fixedRangeRevisions = { ...state.stats.fixedRangeRevisions, remote: 'revision-2' };
  context.requestSyncedFixedPeriod();
  assert.equal(context.buildFixedPeriodSnapshot().period.sessions.example.title, undefined);
  assert.equal(context.buildFixedPeriodSnapshot().period.totalTokens, 20);

  state.stats.devices[0].projectsEnabled = false;
  context.requestSyncedFixedPeriod();
  assert.equal(context.buildFixedPeriodSnapshot().status, 'loading');
  reads[1].finish(rangeDetails(25));
  reads[2].finish(rangeDetails(30));
  await new Promise(setImmediate);
  assert.equal(context.buildFixedPeriodSnapshot().period.totalTokens, 30);
});

test('a current incomplete range supersedes the retained complete snapshot', async () => {
  const { context, state, reads } = syncedRangeHarness();
  context.requestSyncedFixedPeriod();
  reads[0].finish(rangeDetails(20));
  await new Promise(setImmediate);
  state.stats.devices[0].updatedAt++;
  context.requestSyncedFixedPeriod();
  reads[1].finish({ ...rangeDetails(90), detailsAvailable: false });
  await new Promise(setImmediate);
  state.fixedPeriodSnapshot = context.buildFixedPeriodSnapshot();
  assert.equal(state.fixedPeriodSnapshot.period.totalTokens, 90);
  assert.equal(context.periodContentAvailability().detailUnavailable, true);
});

test('local and still-authorized titles remain stable through remote token updates', async () => {
  const { context, state, reads } = syncedRangeHarness();
  state.settings.deviceId = 'local';
  state.stats.localFixedRangeRevision = 'local-1';
  state.stats.fixedRangeRevisions.stable = 'unchanged';
  const titles = {
    'codex:local': { title: 'Local title', sourceDevice: { deviceId: 'local' } },
    'codex:remote': { title: 'Shared title', sourceDevice: { deviceId: 'remote' } },
    'codex:stable': { title: 'Stable title', sourceDevice: { deviceId: 'stable' } }
  };
  state.stats.periods = { month: { sessions: { 'codex:remote': titles['codex:remote'] } } };
  const result = rangeDetails(20);
  result.period.sessions = titles;
  context.requestSyncedFixedPeriod();
  reads[0].finish(result);
  await new Promise(setImmediate);

  state.stats.fixedRangeRevisions = { ...state.stats.fixedRangeRevisions, remote: 'revision-2' };
  context.requestSyncedFixedPeriod();
  assert.deepEqual(context.buildFixedPeriodSnapshot().period.sessions, titles);
  reads[1].finish(result);
  await new Promise(setImmediate);

  state.stats.periods.month.sessions = {};
  state.stats.fixedRangeRevisions = { ...state.stats.fixedRangeRevisions, remote: 'revision-3' };
  state.openSession = { kind: 'session', period: 'week', client: 'codex', sessionId: 'remote', title: 'Shared title' };
  context.requestSyncedFixedPeriod();
  const rows = context.buildFixedPeriodSnapshot().period.sessions;
  assert.equal(rows['codex:local'].title, 'Local title');
  assert.equal(rows['codex:stable'].title, 'Stable title');
  assert.equal(rows['codex:remote'].title, undefined);
  assert.equal(context.sessionDetailTitle(), '');

  state.syncedFixedPeriodCache.clear();
  state.syncedFixedPeriod = null;
  context.requestSyncedFixedPeriod();
  reads.at(-1).finish({ ...result, period: { ...result.period, sessions: rows } });
  await new Promise(setImmediate);
  assert.equal(context.sessionDetailTitle(), '', 'clearing the cache cannot revive the clicked title');
});

test('an unsuccessful warmup retries once when a new revision arrives', async () => {
  const { context, state, reads } = syncedRangeHarness();
  state.period = 'today';
  context.warmSyncedFixedPeriod();
  reads[0].finish(null);
  await new Promise(setImmediate);
  context.warmSyncedFixedPeriod();
  assert.equal(reads.length, 1);
  state.stats.fixedRangeRevisions = { ...state.stats.fixedRangeRevisions, remote: 'revision-2' };
  context.warmSyncedFixedPeriod();
  assert.equal(reads.length, 2);
  reads[1].finish(rangeDetails(25));
  await new Promise(setImmediate);
  assert.equal(reads.length, 2);
});

test('a brief publication gap keeps usage visible without unverified titles and expires', async () => {
  const { context, state, reads } = syncedRangeHarness();
  let expire;
  context.setTimeout = callback => { expire = callback; return 1; };
  context.requestSyncedFixedPeriod();
  reads[0].finish(rangeDetails(20));
  await new Promise(setImmediate);
  state.stats.fixedRangeRevisions = {};
  context.requestSyncedFixedPeriod();
  assert.equal(context.buildFixedPeriodSnapshot().period.totalTokens, 20);
  assert.equal(context.buildFixedPeriodSnapshot().period.sessions.example.title, undefined);
  expire();
  assert.equal(context.buildFixedPeriodSnapshot().status, 'loading');
  state.stats.fixedRangeRevisions = { remote: 'revision-1' };
  context.requestSyncedFixedPeriod();
  assert.equal(reads.length, 2, 'the expired revision must be fetched again');
  reads[1].finish(rangeDetails(25));
  await new Promise(setImmediate);
  assert.equal(context.buildFixedPeriodSnapshot().period.totalTokens, 25);
});

test('restoring the same revision cancels publication-gap expiry', async () => {
  const { context, state, reads } = syncedRangeHarness();
  const timers = new Set();
  context.setTimeout = callback => { timers.add(callback); return callback; };
  context.clearTimeout = callback => timers.delete(callback);
  context.requestSyncedFixedPeriod();
  reads[0].finish(rangeDetails(20));
  await new Promise(setImmediate);
  const revisions = state.stats.fixedRangeRevisions;
  state.stats.fixedRangeRevisions = {};
  assert.equal(context.buildFixedPeriodSnapshot().period.totalTokens, 20);
  assert.equal(timers.size, 1);
  state.stats.fixedRangeRevisions = revisions;
  context.requestSyncedFixedPeriod();
  assert.equal(context.buildFixedPeriodSnapshot().period.totalTokens, 20);
  assert.equal(timers.size, 0);
  assert.equal(reads.length, 1);
});

test('a warmup response for replaced display settings cannot populate the range cache', async () => {
  const { context, state, reads } = syncedRangeHarness();
  state.period = 'today';
  context.warmSyncedFixedPeriod();
  state.settings.modelAliases = { old: 'new' };
  reads[0].finish(rangeDetails(20));
  await new Promise(setImmediate);
  assert.equal(state.syncedFixedPeriodCache.get('week').snapshot, null);
  assert.equal(reads.length, 2);
  reads[1].finish(rangeDetails(25));
  await new Promise(setImmediate);
  assert.equal(state.syncedFixedPeriodCache.get('week').snapshot.period.totalTokens, 25);
});

function rangeDetails(totalTokens) {
  return { status: 'ready', detailsAvailable: true, period: {
    totalTokens, sessions: { example: { title: 'Synced title' } }, projects: { example: { totalTokens } }
  } };
}

function syncedRangeHarness() {
  const source = read('app.js');
  const reads = [];
  const state = {
    mode: 'sync', period: 'week', breakdown: 'session', settings: { hubMode: 'client' }, syncedFixedPeriodCache: new Map(),
    stats: {
      snapshot: { id: 'snapshot', source: 1 }, fixedRangeRevisions: { remote: 'revision-1' },
      devices: [{ deviceId: 'remote', updatedAt: 1 }]
    }
  };
  const context = {
    state, fixedPeriodRangesApi: require('../../src/electron/renderer/fixedPeriodRanges'),
    fixedPeriodTodayKey: () => '2026-11-25', currentCalendarLocale: () => 'en-GB',
    currentNativeRangeSnapshot: () => null, buildFixedPeriodSourcesSnapshot: () => null,
    displayedSessions: () => context.buildFixedPeriodSnapshot().period?.sessions,
    sessionRowsApi: require('../../src/electron/renderer/sessionRows'),
    fixedPeriodDevices: () => [{ deviceId: 'remote' }], shownPeriodOrder: () => ['today', 'week'],
    isRendererWindowHidden: () => false, visibleStatsSurface: () => 'main',
    statsRenderScheduler: { request() {} }, setTimeout: () => 0, clearTimeout() {},
    FIXED_PERIOD_HISTORY_RETRY_MS: 4000,
    FIXED_PERIOD_HISTORY_MAX_RETRIES: 3,
    window: {
      TokenMonitorSessionTitleDisplay: require('../../src/electron/sessionTitleDisplay'),
      tokenMonitor: { getSyncedFixedPeriod: (_id, _source, period) => new Promise(finish => reads.push({ finish, period })) }
    }
  };
  const functions = ['syncedFixedPeriodKey', 'syncedFixedPeriodScope', 'readSyncedFixedPeriod', 'retainVerifiedFixedRangeTitles', 'warmSyncedFixedPeriod',
    'requestSyncedFixedPeriod', 'buildFixedPeriodSnapshot', 'periodContentAvailability', 'sessionDetailTitle'];
  vm.runInNewContext(functions.map(name => source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0]).join('\n'), context);
  return { context, state, reads };
}

test('session detail uses a synced range only for the selected period', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const detailPeriod = source.match(/function sessionDetailPeriod\(\) \{[\s\S]*?\n\}/)[0];
  const state = {
    period: 'yesterday',
    settings: { deviceId: 'local' },
    fixedPeriodSnapshot: {
      detailsAvailable: true, selection: 'yesterday',
      devices: [{ deviceId: 'local', range: { start: '2026-11-24', end: '2026-11-24' } }]
    }
  };
  const context = { state, currentNativeRangeSnapshot: () => null };
  vm.runInNewContext(detailPeriod, context);
  assert.equal(context.sessionDetailPeriod(), 'range:2026-11-24:2026-11-24');
  state.period = 'today';
  assert.equal(context.sessionDetailPeriod(), 'today');
});

test('synced range reads stop after the retry budget until the key changes', async () => {
  const source = read('app.js');
  const request = source.match(/function requestSyncedFixedPeriod\(\) \{[\s\S]*?\n\}/)[0];
  let key = 'old';
  let now = 0;
  let reads = 0;
  const timers = [];
  const context = {
    state: { stats: { snapshot: {} } },
    syncedFixedPeriodKey: () => key,
    readSyncedFixedPeriod: () => context.window.tokenMonitor.getSyncedFixedPeriod(),
    window: { tokenMonitor: { getSyncedFixedPeriod: async () => { reads++; return null; } } },
    Date: { now: () => now },
    FIXED_PERIOD_HISTORY_RETRY_MS: 4000,
    FIXED_PERIOD_HISTORY_MAX_RETRIES: 3,
    setTimeout: callback => timers.push(callback),
    clearTimeout() {},
    statsRenderScheduler: { request() {} }
  };
  vm.runInNewContext(request, context);
  context.requestSyncedFixedPeriod();
  await Promise.resolve();
  for (let retry = 0; retry < 3; retry++) {
    now += 4000;
    timers.shift()();
    await Promise.resolve();
  }

  assert.equal(reads, 4);
  assert.equal(timers.length, 0);
  now += 4000;
  context.requestSyncedFixedPeriod();
  assert.equal(reads, 4);
  key = 'new';
  context.requestSyncedFixedPeriod();
  assert.equal(reads, 5);
});
