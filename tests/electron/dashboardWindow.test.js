'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(rootDir, ...p), 'utf8');

test('preload exposes the dashboard IPC surface', () => {
  const preload = read('src', 'electron', 'preload.js');
  assert.match(preload, /openDashboard: \(\) => ipcRenderer\.invoke\('dashboard:open'\)/);
  assert.match(preload, /getDashboardHistory: \(\) => ipcRenderer\.invoke\('dashboard:getHistory'\)/);
  assert.match(preload, /dashboard: \{/);
  assert.match(preload, /minimize: \(\) => ipcRenderer\.send\('dashboard:minimize'\)/);
  assert.match(preload, /close: \(\) => ipcRenderer\.send\('dashboard:close'\)/);
});

test('main registers dashboard handlers and a sender-scoped close', () => {
  const main = read('src', 'electron', 'main.js');
  assert.match(main, /ipcMain\.handle\('dashboard:open'/);
  assert.match(main, /ipcMain\.handle\('dashboard:getHistory'/);
  assert.match(main, /ipcMain\.on\('dashboard:close'/);
  assert.match(main, /BrowserWindow\.fromWebContents\(event\.sender\)/);
  assert.match(main, /function createDashboardWindow/);
  assert.match(main, /function getDashboardHistory/);
});

test('getDashboardHistory mirrors the local/sync split of fetchStats', () => {
  const main = read('src', 'electron', 'main.js');
  assert.match(main, /aggregateHistory\(localDevice \? \[localDevice\] : \[\], 0\)/);
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
  assert.match(main, /historyEnabled:\s*false/);
  assert.match(main, /historyEnabled:\s*parseBoolean\(patch\.historyEnabled[\s\S]*?,\s*false\)/);
  assert.match(main, /if \(settings\?\.historyEnabled === false\) return aggregateHistory\(\[\], 0\)/);
  assert.match(main, /historyEnabled:\s*settings\.historyEnabled !== false/);
});

test('agent history collection is opt-in by default', () => {
  const agent = read('src', 'agent', 'agent.js');
  const envExample = read('.env.example');
  const readme = read('README.md');
  assert.match(agent, /TOKEN_MONITOR_HISTORY_ENABLED,\s*false\)/);
  assert.match(envExample, /TOKEN_MONITOR_HISTORY_ENABLED=0/);
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
