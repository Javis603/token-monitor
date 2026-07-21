'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(rootDir, ...p), 'utf8');
const { usageConfigFromSettings } = require('../../src/electron/runtimeConfig');

test('preload exposes the dashboard IPC surface', () => {
  const preload = read('src', 'electron', 'preload.js');
  assert.match(preload, /openDashboard: \(\) => ipcRenderer\.invoke\('dashboard:open'\)/);
  assert.match(preload, /getDashboardHistory: \(\) => ipcRenderer\.invoke\('dashboard:getHistory'\)/);
  assert.match(preload, /ipcRenderer\.on\('dashboard:historyChanged', listener\)/);
  assert.match(preload, /dashboard: \{/);
  assert.match(preload, /ready: \(\) => ipcRenderer\.send\('dashboard:ready'\)/);
  assert.match(preload, /minimize: \(\) => ipcRenderer\.send\('dashboard:minimize'\)/);
  assert.match(preload, /close: \(\) => ipcRenderer\.send\('dashboard:close'\)/);
});

test('main registers dashboard handlers and a sender-scoped close', () => {
  const main = read('src', 'electron', 'main.js');
  assert.match(main, /ipcMain\.handle\('dashboard:open'/);
  assert.match(main, /ipcMain\.handle\('dashboard:getHistory'/);
  assert.match(main, /ipcMain\.on\('dashboard:close'/);
  assert.match(main, /ipcMain\.on\('dashboard:ready'/);
  assert.match(main, /BrowserWindow\.fromWebContents\(event\.sender\)/);
  assert.match(main, /function createDashboardWindow/);
  assert.match(main, /function getDashboardHistory/);
});

test('dashboard readiness waits for data and recovers only from actual failures', () => {
  const main = read('src', 'electron', 'main.js');
  assert.doesNotMatch(main, /dashboardShowFallback|armDashboardShowFallback/);
  assert.match(main, /webContents\.on\('did-fail-load'/);
  assert.match(main, /errorCode === -3/);
  assert.match(main, /webContents\.on\('render-process-gone'/);
  assert.match(main, /win\.on\('unresponsive'/);
  assert.match(main, /function discardFailedDashboardWindow\(win, reason\)[\s\S]*?win\.destroy\(\)/);
  assert.match(main, /const controller = new AbortController\(\);[\s\S]*?signal: controller\.signal[\s\S]*?clearTimeout\(timeout\)/);
});

test('getDashboardHistory mirrors the local/sync split of fetchStats', () => {
  const main = read('src', 'electron', 'main.js');
  assert.match(main, /aggregateHistory\(localDevice \? \[localDevice\] : \[\]\)/);
  assert.match(main, /\/api\/history/);
});

test('getDashboardHistory reads local history directly without a blocking collection tick', () => {
  const main = read('src', 'electron', 'main.js');
  const fn = /async function getDashboardHistory\(\)\s*\{([\s\S]*?)\n\}/.exec(main);
  assert.ok(fn, 'getDashboardHistory should be defined');
  // Awaiting a full collection tick here delayed the fetch for seconds; on a
  // quick close/reopen the response outlived the renderer and the dashboard
  // stuck on the empty state. The local branch must read localDevice directly.
  assert.doesNotMatch(fn[1], /localCollectorHandle\.tick/);
});

test('dashboard history is gated by the historyEnabled setting', () => {
  const main = read('src', 'electron', 'main.js');
  assert.match(main, /historyEnabled:\s*true/);
  assert.match(main, /historyEnabled:\s*parseBoolean\(patch\.historyEnabled[\s\S]*?,\s*false\)/);
  assert.match(main, /if \(settings\?\.historyEnabled === false\) return aggregateHistory\(\[\]\)/);
  assert.equal(usageConfigFromSettings({ historyEnabled: true }).historyEnabled, true);
  assert.equal(usageConfigFromSettings({ historyEnabled: false }).historyEnabled, false);
  assert.match(main, /usageConfigFromSettings\(settings, \{/);
});

test('agent history collection defaults to enabled, matching the widget', () => {
  const agent = read('src', 'agent', 'agent.js');
  const envExample = read('.env.example');
  const readme = read('README.md');
  assert.match(agent, /TOKEN_MONITOR_HISTORY_ENABLED,\s*true\)/);
  assert.doesNotMatch(envExample, /TOKEN_MONITOR_HISTORY_ENABLED=0/);
  assert.match(readme, /TOKEN_MONITOR_HISTORY_ENABLED=/);
});

test('dashboard.html wires the shared modules and the two panels', () => {
  const html = read('src', 'electron', 'renderer', 'dashboard.html');
  assert.match(html, /<link rel="stylesheet" href="styles\.css" \/>/);
  assert.match(html, /<link rel="stylesheet" href="dashboard\.css" \/>/);
  assert.match(html, /<script src="usageCharts\.js"><\/script>/);
  assert.match(html, /<script src="i18n\.js"><\/script>/);
  assert.match(html, /<script src="\.\.\/\.\.\/shared\/currency\.js"><\/script>/);
  assert.match(html, /<script src="dashboard\.js"><\/script>/);
  assert.match(html, /id="trendsTab"/);
  assert.match(html, /id="activityTab"/);
  assert.match(html, /id="dashChart"/);
  assert.match(html, /id="dashHeatmap"/);
  assert.match(html, /id="dashCards"/);
  assert.match(html, /data-control="mode"/);
  assert.match(html, /data-control="stack"/);
  assert.match(html, /id="rangeSelect"/);
});

test('dashboard.css declares chart classes and a flat theme override', () => {
  const css = read('src', 'electron', 'renderer', 'dashboard.css');
  assert.match(css, /\.candle-up/);
  assert.match(css, /\.candle-down/);
  assert.match(css, /\.heat\.lvl-4/);
  assert.match(css, /body\.flat/);
  // The empty-state overlay spans the whole window (inset: 0); it must let clicks
  // through so the header buttons still work when there is no history.
  assert.match(css, /\.dash-empty\s*\{[^}]*pointer-events:\s*none/);
});

test('dashboard.js fetches history over IPC and renders both tabs', () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  assert.match(js, /window\.tokenMonitor\.getDashboardHistory\(\)/);
  assert.match(js, /charts\.barsChartSvg/);
  assert.match(js, /charts\.candleChartSvg/);
  assert.match(js, /charts\.heatmapSvg/);
  assert.match(js, /updateSettings\(\{ dashboardFlat: state\.flat \}\)/);
  assert.match(js, /dashboard\.minimize\(\)/);
  assert.match(js, /dashboard\.ready\(\)/);
  assert.match(js, /onDashboardHistoryChanged\?\.\(\(\) => \{ void refresh\(\); \}\)/);
});

test('heatmap metric preserves the legacy cost default and normalizes settings', () => {
  const main = read('src', 'electron', 'main.js');
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const html = read('src', 'electron', 'renderer', 'dashboard.html');
  assert.match(main, /heatmapMetric:\s*'cost'/);
  assert.match(main, /merged\.heatmapMetric = normalizeHeatmapMetric\(merged\.heatmapMetric\)/);
  assert.match(main, /normalizedPatch\.heatmapMetric = normalizeHeatmapMetric\(patch\.heatmapMetric, settings\.heatmapMetric\)/);
  assert.match(js, /computeHeatmapIntensities\(state\.history\?\.daily \|\| \[\]\)/);
  assert.match(js, /heatmapMetric:\s*'cost'/);
  assert.match(html, /class="seg-btn active" data-val="cost" aria-pressed="true"/);
});

test('Home configures heatmap color in Settings while keeping token tooltips', () => {
  const app = read('src', 'electron', 'renderer', 'app.js');
  const css = read('src', 'electron', 'renderer', 'styles.css');
  assert.match(app, /settings\.home\.configureActivity/);
  assert.match(app, /function renderHomeActivitySettings/);
  assert.match(app, /saveSettings\(\{ heatmapMetric: metric \}\)/);
  assert.match(app, /data-home-activity-tooltip-count[^\n]*formatCompact\(Number\(cell\.dataset\.t/);
  assert.match(app, /data-home-activity-tooltip-label[^\n]*textContent = 'tokens'/);
  assert.doesNotMatch(app, /home-heatmap-metric/);
  assert.match(css, /\.home-activity-settings/);
  assert.doesNotMatch(css, /\.home-heatmap-metric/);
});

test('dashboard motion is data-scoped and respects reduced-motion preferences', () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const css = read('src', 'electron', 'renderer', 'dashboard.css');
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /function animateChartGeometry/);
  assert.match(js, /function animateCandles/);
  assert.match(js, /function animateHeatmapEntry/);
  assert.match(js, /document\.hasFocus\(\)/);
  assert.match(js, /\.bar-stack\[data-motion-key\]/);
  assert.match(js, /is-motion-pending/);
  assert.doesNotMatch(js, /function animateValue/);
  assert.match(js, /state\.motion = 'entry'/);
  assert.match(css, /\.dash-bd-bar-fill[^}]*transform:\s*scaleX\(var\(--bar-scale/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.dash-heatmap-wrap\.is-motion-pending[^}]*opacity:\s*0/);
  assert.doesNotMatch(css, /\.dash-pane[^}]*transition/);
});

test('main invalidates an open dashboard only when stats history changes', () => {
  const main = read('src', 'electron', 'main.js');
  const sendPush = /function sendPush\(payload\)\s*\{([\s\S]*?)\n\}\n\nfunction statsHistoryRevision/.exec(main);
  assert.ok(sendPush, 'sendPush should be defined before statsHistoryRevision');
  assert.match(sendPush[1], /if \(payload\?\.data\?\.stats\) \{[\s\S]*?nextHistoryRevision !== previousHistoryRevision[\s\S]*?dashboardWindow\.webContents\.send\('dashboard:historyChanged'\)/);
});

test('dashboard repains on a rate-only settings push, not just a currency-code change', () => {
  // A same-currency rate update (auto refresh or manual override) keeps the
  // currency code identical, so the render() inside the code-change branch
  // never fires. configureRates mutates module state but the already-rendered
  // costs would stay stale unless render() also runs on the rate path.
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const handler = /window\.tokenMonitor\.onSettingsPush\?\.\(\(next\)\s*=>\s*\{([\s\S]*?)\n\}\);/.exec(js);
  assert.ok(handler, 'dashboard should subscribe to onSettingsPush for rate updates');
  assert.match(handler[1], /configureRates\(next\.currencyRatesEffective\)/);
  // Both the rate path and the currency-code path must be able to trigger render.
  assert.match(handler[1], /needsRender\s*=\s*true/);
  assert.match(handler[1], /if \(needsRender\) render\(\)/);
});

test('the trends preview opens the dashboard via IPC', () => {
  const app = read('src', 'electron', 'renderer', 'app.js');
  assert.match(app, /trendsPanel\.addEventListener/);
  assert.match(app, /window\.tokenMonitor\.openDashboard\(\)/);
});

test('renderer removes Trends from available views when history is disabled', () => {
  const app = read('src', 'electron', 'renderer', 'app.js');
  assert.match(app, /state\.settings\?\.historyEnabled === false/);
  assert.match(app, /order\.filter\(\(id\) => id !== 'trends'\)/);
});
