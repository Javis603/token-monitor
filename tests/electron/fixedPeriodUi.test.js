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
    ['cycle', 'month', 'month'],
    ['last7', 'cycle', 'cycle'],
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
  const expected = ['month', 'yesterday', 'week', 'last7', 'last30', 'cycle'];
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
  assert.equal((html.match(/class="view-switcher-menu-item"/g) || []).length, 6);
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
  assert.match(boot, /\['today', 'month', 'yesterday', 'week', 'last7', 'last30', 'cycle', 'allTime'\]\.includes\(period\)/);
  assert.match(app, /function fixedPeriodDevices\(\)/);
  assert.match(app, /devicesForReadySnapshot\(state\.fixedPeriodSnapshot, state\.period, localDevice, \{[\s\S]*?cycleStartDay: state\.settings\?\.billingCycleStartDay/);
  assert.match(app, /fixedPeriodSnapshotFromDevices\(state\.period, fixedPeriodSources\(\)/);
  const snapshotBuilder = app.slice(app.indexOf('function buildFixedPeriodSnapshot()'), app.indexOf('async function loadFixedPeriodHistory'));
  assert.ok(snapshotBuilder.indexOf('historyEnabled === false') < snapshotBuilder.indexOf('fixedPeriodHistoryRequested'));
  assert.match(snapshotBuilder, /readySnapshotForSelection\([\s\S]*?state\.fixedPeriodSnapshot,[\s\S]*?state\.period,[\s\S]*?cycleStartDay: state\.settings\?\.billingCycleStartDay/);
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

test('billing cycle start day is a numeric Settings row passed to fixed ranges', () => {
  const html = read('index.html');
  const app = read('app.js');
  assert.match(html, /id="billingCycleStartDayInput" type="number" min="1" max="31" step="1"/);
  assert.match(html, /data-i18n="periodRange\.cycleStartTitle"/);
  assert.match(app, /cycleStartDay: state\.settings\?\.billingCycleStartDay/);
  assert.match(app, /saveSettings\(\{ billingCycleStartDay: day \}\)/);
});

test('the billing cycle setting references its localized help', () => {
  const html = read('index.html');
  assert.match(html, /<input id="billingCycleStartDayInput"[^>]* aria-describedby="billingCycleStartDayNote"[^>]*>/);
  assert.match(html, /<span id="billingCycleStartDayNote"[^>]* data-i18n="periodRange\.cycleStartNote"[^>]*>[^<]+<\/span>/);
  assert.equal((html.match(/\sid="billingCycleStartDayNote"/g) || []).length, 1);
});

test('main settings normalization safely defaults non-primitive billingCycleStartDay values', () => {
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');
  const start = main.indexOf('function normalizeBillingCycleStartDay(');
  const end = main.indexOf('\nfunction normalizeHomeLimitAccountCount(', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.runInNewContext(main.slice(start, end), context);
  assert.equal(context.normalizeBillingCycleStartDay(15), 15);
  assert.equal(context.normalizeBillingCycleStartDay('9'), 9);
  assert.equal(context.normalizeBillingCycleStartDay({ valueOf: null, toString: null }), 1);
  assert.equal(context.normalizeBillingCycleStartDay(Object.create(null)), 1);
  assert.equal(context.normalizeBillingCycleStartDay(Symbol('day')), 1);
  assert.equal(context.normalizeBillingCycleStartDay([15]), 1);
  assert.equal(context.normalizeBillingCycleStartDay(null), 1);
  assert.equal(context.normalizeBillingCycleStartDay(undefined), 1);
  const readStart = main.indexOf('function readSettings()');
  const readEnd = main.indexOf('\nfunction saveSettings(', readStart);
  const readLine = main.slice(readStart, readEnd).split('\n').find((line) => line.includes('merged.billingCycleStartDay'));
  assert.ok(readLine);
  context.merged = { currency: 'EUR', billingCycleStartDay: { valueOf: null, toString: null } };
  vm.runInNewContext(readLine, context);
  assert.deepEqual(context.merged, { currency: 'EUR', billingCycleStartDay: 1 });
});

test('cold-start boot restores every fixed middle-slot selection', () => {
  const boot = read('floatingBubbleBoot.js');
  for (const period of ['week', 'last7', 'last30', 'cycle']) {
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
