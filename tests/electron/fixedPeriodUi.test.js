'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const read = (name) => fs.readFileSync(path.join(rendererDir, name), 'utf8');

test('fixed periods reuse the existing three-slot control', () => {
  const html = read('index.html');
  const slots = [...html.matchAll(/data-period-slot="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(slots, ['today', 'month', 'allTime']);
  assert.match(html, /id="monthPeriodTab"[^>]*aria-haspopup="menu"[^>]*>MONTH<\/button>/);
  assert.doesNotMatch(html, /id="monthPeriodTab"[^>]*>[^<]*(?:▼|▾|⌄)/);
});

test('the middle-slot menu and Settings expose the same four fixed choices', () => {
  const html = read('index.html');
  const menu = html.slice(html.indexOf('id="monthPeriodMenu"'), html.indexOf('class="actions-hotspot"'));
  const setting = html.slice(html.indexOf('id="periodMonthModeInput"'), html.indexOf('</select>', html.indexOf('id="periodMonthModeInput"')));
  const expected = ['month', 'week', 'last7', 'last30'];
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
  assert.equal((html.match(/class="view-switcher-menu-item"/g) || []).length, 4);
  assert.match(css, /\.view-switcher-menu-item\s*\{[^}]*font-size:\s*11px;[^}]*text-align:\s*left;/s);
  assert.ok(css.lastIndexOf('.period-menu {') > css.indexOf('.view-switcher-menu {'));
  assert.match(css, /\.titlebar\.period-menu-open\s*\{\s*z-index:\s*13;/);
  assert.match(css, /\.period-menu\s*\{[^}]*-webkit-app-region:\s*no-drag;[^}]*pointer-events:\s*auto;/s);
  assert.match(app, /closest\('\.titlebar'\)\?\.classList\.toggle\('period-menu-open', state\.periodMenuOpen\)/);
  assert.match(app, /button\.classList\.toggle\('is-current', active\)/);
  assert.match(app, /handlePeriodMenuNavigation\(event/);
  assert.match(app, /setPeriodMenuOpen\(true, \{ focus: event\.key === 'ArrowUp' \? 'last' : 'first' \}\)/);
  assert.match(app, /deviceHistoriesAvailable: Array\.isArray\(state\.fixedPeriodHistory\?\.deviceHistories\)/);
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
  assert.match(boot, /\['today', 'month', 'week', 'last7', 'last30', 'allTime'\]\.includes\(period\)/);
  assert.match(app, /function fixedPeriodDevices\(\)/);
  assert.match(app, /devicesForReadySnapshot\(state\.fixedPeriodSnapshot, state\.period\)/);
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
    html.indexOf('<label class="settings-item period-default-setting">'),
    html.indexOf('</label>', html.indexOf('<label class="settings-item period-default-setting">'))
  );
  assert.ok(setting.indexOf('settings-item-title') < setting.indexOf('periodMonthModeInput'));
  assert.ok(setting.indexOf('periodMonthModeInput') < setting.indexOf('settings-item-desc'));
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
