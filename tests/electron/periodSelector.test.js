'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('period selector keeps three equal slots and opens one shared popover without a permanent arrow', () => {
  const html = read('src', 'electron', 'renderer', 'index.html');
  const css = read('src', 'electron', 'renderer', 'styles.css');
  const app = read('src', 'electron', 'renderer', 'app.js');

  assert.match(html, /<nav class="tabs"[\s\S]*data-period="today"[\s\S]*data-period="month"[\s\S]*data-period="allTime"/);
  assert.match(html, /id="periodPopover"[^>]*popover="auto"/);
  assert.doesNotMatch(html, /id="periodPopover"[^>]*view-switcher-menu/);
  assert.ok(html.indexOf('periodRanges.js') < html.indexOf('app.js'));
  assert.match(css, /\.tabs\s*\{[\s\S]*grid-template-columns:\s*repeat\(3, 1fr\)/);
  assert.match(css, /\.period-popover:not\(:popover-open\)\s*\{\s*display:\s*none/);
  assert.match(app, /function periodSlotHasOptions\(slot\)[\s\S]*slot === 'month' \|\| slot === 'allTime'/);
  assert.match(app, /periodOption\(slot, 'month', currentMode\),\s*periodOption\(slot, 'week', currentMode/);
  assert.match(app, /if \(slot === state\.period\) \{\s*if \(periodSlotHasOptions\(slot\)\) openPeriodPopover\(slot, tab\)/);
  assert.match(app, /tab\.addEventListener\('contextmenu',[\s\S]*if \(!periodSlotHasOptions\(tab\.dataset\.period\)\) return;[\s\S]*openPeriodPopover\(tab\.dataset\.period, tab\)/);
  assert.doesNotMatch(app, /periodOption\(slot, 'today'/);
  assert.match(app, /tab\.textContent = periodRangesApi\.displayLabel\(selection\)/);
  assert.doesNotMatch(html, /period-arrow|period-chevron/);
  assert.match(css, /\.period-popover\[data-slot="month"\]\s*\{\s*min-width:\s*112px/);
  assert.match(css, /\.period-popover\.has-form\s*\{\s*width:\s*176px/);
  assert.match(css, /\.period-range-form\.hidden\s*\{\s*display:\s*none/);
  assert.match(css, /\.period-range-apply\s*\{[\s\S]*border:\s*0;[\s\S]*background:\s*rgba\(var\(--accent-rgb\), 0\.1\)/);
  assert.match(css, /\.period-popover-option\.view-switcher-menu-item\s*\{[\s\S]*justify-content:\s*flex-start/);
  assert.match(css, /\.period-popover-copy\s*\{[\s\S]*text-align:\s*left/);
  assert.doesNotMatch(app, /period-popover-check/);
  assert.doesNotMatch(css, /\.period-popover-check/);
});

test('rolling and custom range modes persist as normalized settings', () => {
  const main = read('src', 'electron', 'main.js');

  assert.match(main, /periodMonthMode:\s*'month'/);
  assert.match(main, /periodTotalMode:\s*'allTime'/);
  assert.match(main, /Object\.assign\(merged, periodRanges\.normalizedSettings\(merged\)\)/);
  assert.match(main, /patch\.periodMonthMode[\s\S]*periodRanges\.normalizeMode\('month'/);
  assert.match(main, /patch\.periodTotalMode[\s\S]*periodRanges\.normalizeMode\('allTime'/);
  assert.match(main, /patch\.periodRangeStart[\s\S]*periodRanges\.normalizeDateKey/);
});

test('derived ranges drive headline and Home usage without pretending sessions or projects are available', () => {
  const app = read('src', 'electron', 'renderer', 'app.js');
  const css = read('src', 'electron', 'renderer', 'styles.css');

  assert.match(app, /function currentDerivedRangeSnapshot\(\)[\s\S]*periodRangesApi\.deriveRangeSnapshot/);
  assert.match(app, /function currentPeriodState\(\)[\s\S]*currentDerivedRangeSnapshot\(\)/);
  assert.match(app, /function renderHome\(periodState = currentPeriodState\(\)\)[\s\S]*periodState\.period/);
  assert.match(app, /function render\(\)[\s\S]*const periodState = currentPeriodState\(\)/);
  assert.match(app, /periodRangesApi\.supportsBreakdown\(selection, state\.breakdown\)/);
  assert.match(app, /detailUnavailable \|\| rangeStatus !== 'ready' \? \[\] : rowsForPeriod\(period\)/);
  assert.match(app, /renderRows\(rows, \{ incompleteHint, emptyState \}\)/);
  assert.match(app, /state\.breakdown === 'project'[\s\S]*periodRange\.projectDetailUnavailable[\s\S]*periodRange\.sessionDetailUnavailable/);
  assert.match(css, /\.breakdown-empty-state\s*\{[\s\S]*top:\s*50%;[\s\S]*left:\s*50%;[\s\S]*white-space:\s*nowrap/);
  assert.doesNotMatch(app, /periodOption\([^\n]*'last24'/);
});

test('derived device rows load per-device histories instead of falling back to today', () => {
  const app = read('src', 'electron', 'renderer', 'app.js');
  const preload = read('src', 'electron', 'preload.js');
  const main = read('src', 'electron', 'main.js');

  assert.match(app, /state\.deviceHistories\[deviceId\]/);
  assert.match(app, /window\.tokenMonitor\.getDeviceHistories\(\)/);
  assert.match(app, /loadedSignature: state\.deviceHistoriesLoadedSignature/);
  assert.match(preload, /dashboard:getDeviceHistories/);
  assert.match(main, /resolveDeviceHistories\(historyResolverOptions\(\)\)/);
});

test('Main settings expose the global Month and Total ranges outside Home customization', () => {
  const app = read('src', 'electron', 'renderer', 'app.js');
  const css = read('src', 'electron', 'renderer', 'styles.css');
  const html = read('src', 'electron', 'renderer', 'index.html');
  const { MESSAGES } = require('../../src/electron/renderer/i18n');

  assert.match(html, /id="mainSettingsDetails"[\s\S]*id="periodSettingsContainer"[\s\S]*id="viewDisplayList"/);
  assert.match(app, /function renderPeriodSettings\(\)/);
  assert.match(app, /appendSelectRow\('month', 'settings\.periodRanges\.monthTab', \['month', 'week', 'last7', 'last30'\]\)/);
  assert.match(app, /appendSelectRow\('allTime', 'settings\.periodRanges\.totalTab', \['allTime', 'range'\]\)/);
  assert.doesNotMatch(app.slice(app.indexOf('function renderPeriodSettings'), app.indexOf('function renderHomeSettingsList')), /appendSelectRow\('today'/);
  assert.match(app, /periodSettingsContainer'\)\?\.replaceChildren\(renderPeriodSettings\(\)\)/);
  assert.doesNotMatch(app, /wrap\.append\(renderPeriodSettings\(\), header\)/);
  assert.match(app, /selectPeriodMode\('allTime', 'range',[\s\S]*periodRangeStart:[\s\S]*periodRangeEnd:[\s\S]*\{ activate: false \}/);
  assert.match(app, /rows\.className = 'period-settings-rows'[\s\S]*rows\.append\(row\)/);
  assert.match(css, /\.period-settings-rows\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.settings-panel \.period-settings-select\s*\{[\s\S]*width:\s*100%/);
  assert.match(css, /\.period-settings-date-fields\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    assert.ok(messages['periodRange.week'], `${locale} should translate This week`);
    assert.ok(messages['settings.periodRanges.note'], `${locale} should explain the global selector shortcut`);
    assert.ok(messages['settings.periodRanges.monthTab'], `${locale} should label the Month tab setting`);
    assert.ok(messages['settings.periodRanges.totalTab'], `${locale} should label the Total tab setting`);
    assert.ok(messages['periodRange.deviceHistoryLoading'], `${locale} should translate device-history loading`);
    assert.ok(messages['periodRange.deviceHistoryUnavailable'], `${locale} should translate device-history failure`);
    assert.ok(messages['periodRange.historyLoading'], `${locale} should translate full-history loading`);
    assert.ok(messages['periodRange.historyUnavailable'], `${locale} should translate full-history failure`);
    assert.ok(messages['periodRange.sessionDetailUnavailable'], `${locale} should translate unavailable session detail`);
    assert.ok(messages['periodRange.projectDetailUnavailable'], `${locale} should translate unavailable project detail`);
  }
});

test('headline, breakdowns, and Trends share one derived range snapshot', () => {
  const app = read('src', 'electron', 'renderer', 'app.js');
  const trends = app.match(/function renderTrends\(periodState = currentPeriodState\(\)\) \{([\s\S]*?)\n\}\n\nfunction viewLabelById/);
  assert.ok(trends, 'renderTrends exists');
  assert.match(trends[1], /points = periodState\.daily/);
  assert.match(trends[1], /summary = periodState\.summary/);
  assert.doesNotMatch(trends[1], /localDayKey|fullHistoryForStats|dailyRowsForSelection|rangeSummary/);
  assert.match(app, /periodState\.status !== 'ready'[\s\S]*els\.totalTokens\.textContent = '—'/);
  assert.match(app, /renderHome\(periodState\)/);
  assert.match(app, /renderTrends\(periodState\)/);
});
