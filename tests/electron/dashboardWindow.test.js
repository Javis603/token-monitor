'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const rootDir = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(rootDir, ...p), 'utf8');
const { usageConfigFromSettings } = require('../../src/electron/runtimeConfig');

function dashboardFunction(name, endMarker, context) {
  const source = read('src', 'electron', 'renderer', 'dashboard.js');
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  const body = source.slice(start, source.indexOf(endMarker));
  return new vm.Script(`${body}\n${name};`).runInNewContext(context);
}

function dashboardWindowFixture(platform = 'win32', settings = {}) {
  const windows = [];
  const backdrops = new Map();
  const handlers = new Map();
  class Window extends EventEmitter {
    constructor() {
      super();
      this.calls = [];
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.reload = () => this.calls.push('reload');
      this.webContents.isDestroyed = () => this.isDestroyed();
      this.webContents.id = windows.length + 1;
      this.webContents.draft = { tab: 'activity', range: 'month' };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed === true; }
    isVisible() { return this.visible === true; }
    isMinimized() { return this.minimized === true; }
    hide() { this.visible = false; this.calls.push('hide'); }
    show() { this.visible = true; this.calls.push('show'); }
    focus() { this.calls.push('focus'); }
    setBackgroundColor(color) { this.calls.push(['background', color]); }
    restore() { this.minimized = false; this.calls.push('restore'); }
    loadFile() { this.calls.push('load'); return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
    static fromWebContents(sender) { return windows.find(win => win.webContents === sender); }
  }
  const context = vm.createContext({
    dashboardWindow: null, dashboardWindowReady: false, mainWindow: null, lastRendererStatsFingerprint: null,
    BrowserWindow: Window, process: { platform }, path, __dirname: rootDir,
    appWindowIcon: () => ({}), applyWindowsChrome() {}, suppressLinuxSystemContextMenu() {},
    syncWindowsBackdrop(win, { enabled, mode = 'acrylic' }) {
      if (platform === 'win32' && win) backdrops.set(win, enabled ? mode : 'transparent');
    },
    windowsAccentActive: win => backdrops.get(win) === 'accent',
    nativeBlurEnabled: (source = settings) => source.systemGlass !== false,
    attachNativeMaterialVisibility() {}, syncNativeMaterialVisibility() {},
    nativeMaterialOptions: () => ({}), limitsHistoryController: null, settings,
    isAllowedExternalUrl: () => false, console: { log() {} },
    ipcMain: { on: (name, handler) => handlers.set(name, handler) }
  });
  const main = read('src', 'electron', 'main.js');
  vm.runInContext(main.slice(main.indexOf('function applyNativeMaterial('), main.indexOf('function withHistoryPreview(')), context);
  vm.runInContext(main.slice(main.indexOf('function discardFailedDashboardWindow('), main.indexOf('async function getDashboardHistory(')), context);
  vm.runInContext(main.slice(main.indexOf("ipcMain.on('dashboard:ready'"), main.indexOf("ipcMain.on('dashboard:minimize'")), context);
  const app = new EventEmitter();
  const timers = [];
  Object.assign(context, { app, quitRequested: false, setTimeout: fn => timers.push(fn) });
  vm.runInContext(main.slice(main.indexOf('const rendererCrashReloadAt ='), main.indexOf('// Every quit route')), context);
  return {
    windows, backdrops, open: () => context.createDashboardWindow(),
    applyNativeMaterial: () => context.applyNativeMaterial(),
    ready: win => handlers.get('dashboard:ready')({ sender: win.webContents }),
    crash(win) {
      const details = { reason: 'crashed' };
      win.webContents.emit('render-process-gone', {}, details);
      app.emit('render-process-gone', {}, win.webContents, details);
      for (const fn of timers.splice(0)) fn();
    }
  };
}

test('Windows Dashboard uses the widget backdrop on open and when appearance changes', () => {
  const settings = { systemGlass: true, windowsBackdrop: 'mica-alt' };
  const f = dashboardWindowFixture('win32', settings);
  const win = f.open();
  assert.equal(f.backdrops.get(win), 'mica-alt');
  f.ready(win);

  settings.windowsBackdrop = 'accent';
  f.applyNativeMaterial();
  assert.equal(f.backdrops.get(win), 'accent');

  settings.systemGlass = false;
  f.applyNativeMaterial();
  assert.equal(f.backdrops.get(win), 'transparent');
  assert.equal(f.open(), win);
});

test('macOS Dashboard restores its transparent canvas before reveal and after reload', () => {
  const f = dashboardWindowFixture('darwin');
  const win = f.open();
  f.ready({ webContents: {} });
  assert.deepEqual(win.calls, ['load']);
  f.ready(win);
  assert.deepEqual(win.calls, ['load', ['background', '#00000000'], 'show', 'focus']);
  win.calls.length = 0;
  f.crash(win);
  f.ready(win);
  assert.deepEqual(win.calls, ['reload', ['background', '#00000000'], 'show', 'focus']);
});

test('a shared renderer crash reloads the existing Dashboard and a repeat crash is bounded', () => {
  const f = dashboardWindowFixture();
  const win = f.open();
  f.ready(win);
  win.calls.length = 0;
  f.crash(win);
  assert.equal(win.isDestroyed(), false);
  assert.deepEqual(win.calls, ['reload']);
  assert.equal(f.open(), win);
  win.calls.length = 0;
  f.crash(win);
  assert.equal(win.isDestroyed(), false);
  assert.deepEqual(win.calls, [], 'a repeated crash in the cooldown must not loop');
});

test('repeated Dashboard opens wait for initial data without hiding or reloading the page', () => {
  const f = dashboardWindowFixture();
  const win = f.open();
  assert.equal(f.open(), win);
  assert.equal(f.windows.length, 1);
  assert.deepEqual(win.calls, ['load']);
  f.ready({ webContents: {} });
  assert.deepEqual(win.calls, ['load'], 'unrelated senders cannot reveal an unprepared Dashboard');
  f.ready(win);
  assert.deepEqual(win.calls, ['load', 'show', 'focus']);
});

test('opening a prepared Dashboard restores the same page and closed windows start unprepared', () => {
  const f = dashboardWindowFixture();
  const win = f.open();
  f.ready(win);
  const page = win.webContents;
  const draft = page.draft;
  win.minimized = true;
  win.calls.length = 0;
  assert.equal(f.open(), win);
  assert.equal(win.webContents, page);
  assert.equal(page.draft, draft);
  assert.deepEqual(win.calls, ['restore', 'show', 'focus']);
  win.destroy();
  const next = f.open();
  assert.notEqual(next, win);
  assert.deepEqual(next.calls, ['load']);
  assert.equal(f.open(), next);
  f.ready(win);
  assert.deepEqual(next.calls, ['load'], 'a late ready event from the old page must not reveal its replacement');
  f.ready(next);
  assert.deepEqual(next.calls, ['load', 'show', 'focus']);
});

test('preload exposes the dashboard IPC surface', () => {
  const preload = read('src', 'electron', 'preload.js');
  assert.match(preload, /openDashboard: \(\) => ipcRenderer\.invoke\('dashboard:open'\)/);
  assert.match(preload, /getDashboardHistory: \(options\) => ipcRenderer\.invoke\('dashboard:getHistory', options\)/);
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
  const historySource = read('src', 'electron', 'historySource.js');
  assert.doesNotMatch(main, /dashboardShowFallback|armDashboardShowFallback/);
  assert.match(main, /webContents\.on\('did-fail-load'/);
  assert.match(main, /errorCode === -3/);
  assert.match(main, /app\.on\('render-process-gone'/);
  assert.match(main, /win\.on\('unresponsive'/);
  assert.match(main, /function discardFailedDashboardWindow\(win, reason\)[\s\S]*?win\.destroy\(\)/);
  assert.match(historySource, /const controller = new AbortController\(\);[\s\S]*?signal: controller\.signal[\s\S]*?clearTimeout\(timeout\)/);
});

test('Dashboard and Widget share the complete local/host/client history resolver', () => {
  const main = read('src', 'electron', 'main.js');
  const historySource = read('src', 'electron', 'historySource.js');
  assert.match(main, /return resolveCompleteHistory\(historyResolverOptions\(\)\)/);
  assert.match(historySource, /mode === 'local'/);
  assert.match(historySource, /hubMode === 'host' && embeddedHub/);
  assert.match(historySource, /\/api\/history/);
});

test('getDashboardHistory reads local history directly without a blocking collection tick', () => {
  const main = read('src', 'electron', 'main.js');
  const fn = /async function getDashboardHistory\(options = \{\}\)\s*\{([\s\S]*?)\n\}/.exec(main);
  assert.ok(fn, 'getDashboardHistory should be defined');
  // Awaiting a full collection tick here delayed the fetch for seconds; on a
  // quick close/reopen the response outlived the renderer and the dashboard
  // stuck on the empty state. The local branch must read localDevice directly.
  assert.doesNotMatch(fn[1], /localCollectorHandle\.tick/);
});

test('fixed ranges request existing per-device History without changing ingest', () => {
  const main = read('src', 'electron', 'main.js');
  const historySource = read('src', 'electron', 'historySource.js');
  assert.match(main, /includeDevices[\s\S]*?resolveCompleteHistoryWithDevices/);
  assert.match(main, /ipcMain\.handle\('dashboard:getHistory', \(_event, options\) => getDashboardHistory\(options\)\)/);
  assert.match(historySource, /\/api\/devices/);
  assert.match(historySource, /deviceHistories: parseDeviceHistories\(devices\)/);
});

test('dashboard history is gated by the historyEnabled setting', () => {
  const main = read('src', 'electron', 'main.js');
  assert.match(main, /historyEnabled:\s*true/);
  assert.match(main, /historyEnabled:\s*parseBoolean\(patch\.historyEnabled[\s\S]*?,\s*false\)/);
  assert.match(read('src', 'electron', 'historySource.js'), /historyEnabled === false/);
  assert.equal(usageConfigFromSettings({ historyEnabled: true }).historyEnabled, true);
  assert.equal(usageConfigFromSettings({ historyEnabled: false }).historyEnabled, false);
  assert.match(main, /usageConfigFromSettings\(settings, \{/);
});

test('agent history collection defaults to enabled, matching the widget', () => {
  const agent = read('src', 'agent', 'agent.js');
  const envExample = read('.env.example');
  const configDoc = read('docs', 'configuration.md');
  assert.match(agent, /TOKEN_MONITOR_HISTORY_ENABLED,\s*true\)/);
  assert.doesNotMatch(envExample, /TOKEN_MONITOR_HISTORY_ENABLED=0/);
  assert.match(configDoc, /TOKEN_MONITOR_HISTORY_ENABLED=/);
});

test('headless agent leaves Claude Web credentials to the widget transport', () => {
  const agent = read('src', 'agent', 'agent.js');
  assert.match(agent, /claudeWebCookie: ''/);
  assert.doesNotMatch(agent, /CLAUDE_WEB_COOKIE|claudeWebCookieRuntime/);
});

test('dashboard.html wires the shared modules and the two panels', () => {
  const html = read('src', 'electron', 'renderer', 'dashboard.html');
  assert.match(html, /<link rel="stylesheet" href="styles\.css" \/>/);
  assert.match(html, /<link rel="stylesheet" href="dashboard\.css" \/>/);
  assert.match(html, /<script src="usageCharts\.js"><\/script>/);
  assert.match(html, /<script src="i18n\.js"><\/script>/);
  assert.match(html, /<script src="\.\.\/\.\.\/shared\/currency\.js"><\/script>/);
  assert.match(html, /<script src="\.\.\/\.\.\/shared\/compactMoney\.js"><\/script>/);
  assert.match(html, /<script src="dashboard\.js"><\/script>/);
  const scriptOrder = [
    '<script src="../../shared/compactTokens.js"></script>',
    '<script src="../../shared/currency.js"></script>',
    '<script src="../../shared/compactMoney.js"></script>',
    '<script src="dashboard.js"></script>'
  ].map((script) => html.indexOf(script));
  assert.ok(scriptOrder.every((index) => index >= 0), 'dashboard should include every compact money dependency');
  assert.ok(
    scriptOrder.every((index, position) => position === 0 || scriptOrder[position - 1] < index),
    'compact money should load after its token and currency dependencies'
  );
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
  const html = read('src', 'electron', 'renderer', 'dashboard.html');
  const css = read('src', 'electron', 'renderer', 'dashboard.css');
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const modelJs = read('src', 'electron', 'renderer', 'dashboardModel.js');
  const contentBlurJs = read('src', 'electron', 'renderer', 'contentBlur.js');
  assert.match(js, /window\.tokenMonitor\.getDashboardHistory\(\{\s*includeDevices:\s*true\s*\}\)/);
  assert.match(js, /charts\.barsChartSvg/);
  assert.match(js, /charts\.candleChartSvg/);
  assert.match(js, /charts\.heatmapSvg/);
  assert.match(js, /modelApi\.isometricHeatmapSvg/);
  assert.match(js, /updateSettings\(\{ dashboardFlat: state\.flat \}\)/);
  assert.match(js, /dashboard\.minimize\(\)/);
  assert.match(js, /dashboard\.ready\(\)/);
  assert.match(js, /onDashboardHistoryChanged\?\.\(handleDashboardHistoryChanged\)/);
  assert.match(js, /onStatsPush\?\.\(/);
  assert.match(html, /<script src="rowIconMasks\.js"><\/script>/);
  assert.match(html, /<script src="limits\/homeMotion\.js"><\/script>/);
  assert.match(html, /<script src="\.\.\/tokenNumberAnimation\.js"><\/script>/);
  assert.match(html, /<script src="contentBlur\.js"><\/script>/);
  assert.match(html, /<script src="accountIdentity\.js"><\/script>/);
  assert.match(html, /<script src="dashboardModel\.js"><\/script>/);
  assert.match(html, /<script src="activitySkyline3d\.js"><\/script>/);
  assert.match(js, /TokenMonitorContentBlur/);
  const skylineJs = read('src', 'electron', 'renderer', 'activitySkyline3d.js');
  assert.match(html, /id="dashDeviceMenu"[^>]*popover="manual"/);
  assert.match(html, /id="dashDrawer"[^>]*popover="manual"/);
  assert.match(html, /id="dashTooltip"[^>]*popover="manual"/);
  assert.match(html, /id="dashTopology"/);
  assert.match(html, /data-control="stageView"/);
  assert.match(html, /dash-glass-card/);
  assert.match(html, /id="dashQuotasCard"[^>]*home-module-limits/);
  assert.match(html, /id="dashQuotas"[^>]*home-module-body/);
  assert.doesNotMatch(html, /class="dash-title"/);
  assert.match(html, /class="dash-quotas-viewport"/);
  assert.match(html, /id="dashHeatLegend"/);
  assert.match(css, /--dash-card-shadow:\s*none/);
  assert.match(css, /\.dash-topo-wrap\s*\{[^}]*border:\s*none/);
  assert.doesNotMatch(css, /\.topo-port\s*\{[^}]*background:\s*rgb\(var\(--glass-rgb\)\)/);
  assert.match(css, /\.dash-quotas-viewport\s*\{/);
  assert.doesNotMatch(css, /\.dash-quotas-col\s+\.home-limit-window/);
  assert.match(css, /\.dash-heat-legend\s*\{/);
  assert.doesNotMatch(css, /\.dash-activity-col\s*\{[^}]*justify-content:\s*space-between/);
  assert.doesNotMatch(css, /\.dash-quotas-list\s*\{[^}]*max-height:\s*248px/);
  assert.match(js, /home-limit-account-head/);
  assert.match(js, /home-limit-windows/);
  assert.match(js, /home-limit-resets/);
  assert.match(js, /const vendorColors = true/);
  assert.match(js, /const highlightLow = true/);
  assert.match(js, /data-c="\$\{accColor\}"/);
  assert.match(js, /data-limit-color="\$\{accColor\}"/);
  assert.match(js, /maskLimitAccountEmails/);
  assert.match(js, /function animateMetricText/);
  assert.match(js, /data-dom-island aria-hidden="true"/);
  assert.match(js, /function syncTopologyScrollFades/);
  assert.match(js, /dash-topo-col-scroll/);
  assert.match(js, /--edge-vis/);
  assert.match(js, /is-offscreen/);
  assert.doesNotMatch(js, /topologyExpanded|topo-more-btn|topo-collapse-btn/);
  assert.match(js, /topo-beam-tail/);
  assert.match(js, /topo-beam-body/);
  assert.match(js, /topo-beam-head/);
  assert.match(js, /topo-edge--hop/);
  assert.match(js, /topo-node--device/);
  assert.match(js, /topo-node--hub/);
  assert.match(js, /topo-node--endpoint/);
  assert.match(js, /pathLength="100"/);
  assert.doesNotMatch(js, /topo-packet-core/);
  assert.doesNotMatch(js, /<animateMotion/);
  assert.match(css, /\.dash-topo-col-scroll\b/);
  assert.match(css, /\.has-bottom-fade/);
  assert.match(css, /\.topo-edge\.is-offscreen/);
  assert.match(css, /\.topo-beam-head/);
  assert.match(css, /mask-composite:\s*exclude/);
  assert.match(css, /topoBorderPass/);
  assert.match(css, /topoSheenPass/);
  assert.match(css, /topoPortEmit/);
  assert.match(css, /topoPortHubIn/);
  assert.match(css, /topoPortHubOut/);
  assert.match(css, /topoPortArrive/);
  assert.doesNotMatch(css, /topo-more-btn|topo-collapse-btn|dash-topo-wrap\.is-expanded/);
  assert.doesNotMatch(js, /pendingVisualBandFromHeight|pendingRevealSelector/);
  assert.match(js, /function activateSegButton/);
  assert.match(js, /function renderHeatLegend/);
  assert.match(js, /function updateHeroTokens[\s\S]*?!document\.hidden/);
  assert.match(js, /function renderTopology/);
  assert.match(js, /function layoutTopologyLinks/);
  assert.match(js, /createLiveTokenRateGroupTracker\(\{\s*now:\s*Date\.now/);
  assert.match(contentBlurJs, /\.dash-tooltip/);
  assert.match(contentBlurJs, /\.dash-device-menu/);
  assert.match(contentBlurJs, /\.dash-drawer/);
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'CSP forbids inline style attributes in dashboard.html');
  assert.doesNotMatch(js, /<[a-z][^>]*\sstyle\s*=/i, 'CSP forbids inline style attributes in dashboard.js');
  assert.doesNotMatch(modelJs, /<[a-z][^>]*\sstyle\s*=/i, 'CSP forbids inline style attributes in dashboardModel.js');
  assert.doesNotMatch(skylineJs, /<[a-z][^>]*\sstyle\s*=/i, 'CSP forbids inline style attributes in activitySkyline3d.js');
});

test('Dashboard Trends renders the selected calendar range and labels unrecorded days', () => {
  // History omits zero-usage days, so slicing it to the last N rows shortened
  // the range and removed those days from the chart. The Trends tab must build
  // the calendar window instead, keep the slots hoverable, and say "no record"
  // rather than claiming a measured zero.
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const trends = /function renderTrends\(\) \{([\s\S]*?)\n\}\n\nfunction renderBreakdown/.exec(js);
  assert.ok(trends, 'renderTrends exists');
  assert.match(trends[1], /charts\.dailyWindow\(state\.history\?\.daily \|\| \[\],\s*\{\s*days: state\.range === 'all' \? 0 : Number\(state\.range\)\s*\}\)/);
  assert.doesNotMatch(js, /charts\.clampDaily/);
  assert.match(js, /t\('dashboard\.noRecord'\)/);
});

test('Dashboard tooltips distinguish unrecorded days and buckets from recorded zeros', () => {
  const tooltip = { innerHTML: '' };
  const context = {
    els: { tooltip },
    t: (key) => (key === 'dashboard.noRecord' ? 'No usage recorded' : key),
    shortDate: () => '10/24',
    longDate: () => '10/24',
    formatCompact: (value) => String(value),
    colorFor: () => '#fff',
    applySwatchColors: () => {},
    positionTooltip: () => {}
  };
  const showBarTooltip = dashboardFunction('showBarTooltip', '\nfunction showCandleTooltip', context);

  showBarTooltip({ label: '2026-10-24', total: 0, segments: [], hasRecord: false }, {});
  assert.match(tooltip.innerHTML, /No usage recorded/);
  assert.doesNotMatch(tooltip.innerHTML, /· 0/);

  showBarTooltip({ label: '2026-10-24', total: 0, segments: [], hasRecord: true }, {});
  assert.doesNotMatch(tooltip.innerHTML, /No usage recorded/);
  assert.match(tooltip.innerHTML, /· 0/);

  showBarTooltip({ label: '2026-10-24', total: 4300, segments: [{ key: 'claude', value: 4300 }] }, {});
  assert.match(tooltip.innerHTML, /claude/);
  assert.match(tooltip.innerHTML, /4300/);

  const showCandleTooltip = dashboardFunction('showCandleTooltip', '\nfunction showHeatTooltip', context);
  const zero = { key: '2026-10-24', open: 0, high: 0, low: 0, close: 0 };
  showCandleTooltip({ ...zero, hasRecord: false }, {});
  assert.match(tooltip.innerHTML, /No usage recorded/);
  showCandleTooltip({ ...zero, hasRecord: true }, {});
  assert.doesNotMatch(tooltip.innerHTML, /No usage recorded/);
  assert.match(tooltip.innerHTML, />L<.*>0</);
});

test('dashboard reuses the shared scheduler to defer hidden render work', () => {
  const html = read('src', 'electron', 'renderer', 'dashboard.html');
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const schedulerScript = html.indexOf('<script src="statsRenderScheduler.js"></script>');
  const dashboardScript = html.indexOf('<script src="dashboard.js"></script>');

  assert.ok(schedulerScript >= 0 && schedulerScript < dashboardScript);
  assert.match(js, /createStatsRenderScheduler\(\{[\s\S]*isHidden: \(\) => dashboardReady && document\.hidden,[\s\S]*render: renderNow/);
  assert.match(js, /function render\(\) \{\s*dashboardRenderScheduler\.request\(\);\s*\}/);
  assert.match(js, /function handleDashboardVisibilityChange\(\)[\s\S]*visibilityChanged\(\)[\s\S]*scheduleDashboardRefresh\(\)/);
  assert.match(js, /document\.addEventListener\('visibilitychange', handleDashboardVisibilityChange\)/);
});

test('dashboard restore coalesces either native event order into one refresh', () => {
  let hidden = true;
  let focused = true;
  let refreshRunning = false;
  let refreshQueued = false;
  let refreshes = 0;
  let frame = null;
  const context = {
    document: {
      get hidden() { return hidden; },
      hasFocus: () => focused
    },
    requestAnimationFrame(callback) { frame = callback; return 1; },
    cancelAnimationFrame() { frame = null; },
    dashboardRenderScheduler: {
      visibilityChanged: () => true,
      flush() {}
    },
    refresh: () => { refreshes += 1; },
    get refreshRunning() { return refreshRunning; },
    get refreshQueued() { return refreshQueued; },
    set refreshQueued(value) { refreshQueued = value; },
    get dashboardRefreshFrame() { return frame ? 1 : 0; },
    set dashboardRefreshFrame(value) { if (!value) frame = null; }
  };
  const scheduleRefresh = dashboardFunction(
    'scheduleDashboardRefresh',
    '\nfunction handleDashboardVisibilityChange',
    context
  );
  context.scheduleDashboardRefresh = scheduleRefresh;
  const visibilityChanged = dashboardFunction(
    'handleDashboardVisibilityChange',
    "\ndocument.addEventListener('visibilitychange'",
    context
  );
  const focus = dashboardFunction(
    'handleDashboardFocus',
    "\nwindow.addEventListener('focus'",
    context
  );
  const runFrame = () => { const callback = frame; frame = null; callback(); };

  focus();
  assert.equal(frame, null, 'macOS focuses the window while its document is still hidden');

  hidden = false;
  visibilityChanged();
  focus();
  runFrame();
  assert.equal(refreshes, 1, 'focus then visibility shares one animation-frame refresh');

  hidden = true;
  visibilityChanged();
  focused = false;
  hidden = false;
  visibilityChanged();
  focused = true;
  focus();
  runFrame();
  assert.equal(refreshes, 2, 'visibility then focus also shares one animation-frame refresh');

  refreshRunning = true;
  visibilityChanged();
  runFrame();
  assert.equal(refreshes, 2, 'an in-flight history refresh will render the latest state itself');
});

test('dashboard history invalidation defers IPC while hidden', () => {
  let hidden = true;
  let refreshQueued = false;
  let refreshes = 0;
  const context = {
    document: { get hidden() { return hidden; } },
    refresh: () => { refreshes += 1; },
    get refreshQueued() { return refreshQueued; },
    set refreshQueued(value) { refreshQueued = value; }
  };
  const historyChanged = dashboardFunction(
    'handleDashboardHistoryChanged',
    '\nwindow.tokenMonitor.onDashboardHistoryChanged',
    context
  );

  historyChanged();
  historyChanged();
  assert.equal(refreshes, 0);
  assert.equal(refreshQueued, true);

  hidden = false;
  historyChanged();
  assert.equal(refreshes, 1);
});

test('an in-flight Dashboard refresh preserves a hidden invalidation for restore', async () => {
  let refreshRunning = false;
  let refreshQueued = true;
  let requests = 0;
  const context = {
    document: { hidden: true },
    state: { history: null, motion: 'none' },
    window: { tokenMonitor: { getDashboardHistory: async () => { requests += 1; return {}; } } },
    render() {},
    console: { log() {} },
    get refreshRunning() { return refreshRunning; },
    set refreshRunning(value) { refreshRunning = value; },
    get refreshQueued() { return refreshQueued; },
    set refreshQueued(value) { refreshQueued = value; }
  };
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  vm.runInNewContext(js.slice(js.indexOf('let historyRequestSeq'), js.indexOf('async function manualRefresh(')), context);
  const refresh = dashboardFunction('refresh', '\nasync function boot(', context);

  await refresh();
  await Promise.resolve();

  assert.equal(requests, 1);
  assert.equal(refreshQueued, true);
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
  assert.match(app, /: id === 'trends' \? renderHomeActivitySettings\(\)/);
  assert.match(app, /function renderHomeActivitySettings/);
  assert.match(app, /saveSettings\(\{ heatmapMetric: metric \}\)/);
  // Activity reuses the nested list and settings rows the other Home modules use.
  const activity = app.slice(app.indexOf('function renderHomeActivitySettings('), app.indexOf('function renderLimitsViewSettingsList('));
  assert.match(app, /data-home-activity-tooltip-count[^\n]*formatCompact\(Number\(cell\.dataset\.t/);
  assert.match(app, /data-home-activity-tooltip-label[^\n]*textContent = 'tokens'/);
  assert.doesNotMatch(app, /home-heatmap-metric/);
  assert.match(activity, /wrap\.className = 'settings-nested-list'/);
  assert.match(activity, /label\.className = 'settings-item'/);
  assert.doesNotMatch(app + css, /home-activity-settings/);
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
  const sendPush = /function sendPush\(payload[^)]*\)\s*\{([\s\S]*?)\n\}\n\nfunction statsHistoryRevision/.exec(main);
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

test('dashboard shares localized token units and repaints when the setting or language changes', () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const html = read('src', 'electron', 'renderer', 'dashboard.html');
  const handler = /window\.tokenMonitor\.onSettingsPush\?\.\(\(next\)\s*=>\s*\{([\s\S]*?)\n\}\);/.exec(js);
  assert.ok(handler, 'dashboard should subscribe to settings pushes');
  assert.match(html, /<script src="\.\.\/\.\.\/shared\/compactTokens\.js"><\/script>/);
  assert.match(js, /const compactMoneyApi = window\.TokenMonitorCompactMoney/);
  assert.match(js, /const compactTokenApi = window\.TokenMonitorCompactTokens/);
  assert.match(js, /compactTokenApi\.formatCompactTokens\(value, effectiveCompactTokenUnits\(\), state\.locale\)/);
  assert.match(js, /compactMoneyApi\.formatCompactCurrencyFromUsd\(\s*usd,\s*state\.currency,\s*effectiveCompactTokenUnits\(\),\s*state\.locale/s);
  assert.match(js, /state\.locale = i18n\.resolveLocale\(settings\.locale \|\| settings\.language, navigator\.languages\)/);
  assert.match(handler[1], /nextLocale = i18n\.resolveLocale\(state\.settings\.locale \|\| state\.settings\.language, navigator\.languages\)/);
  assert.match(handler[1], /nextCompactTokenUnits = compactTokenApi\.normalizeCompactTokenUnits\(state\.settings\.compactTokenUnits\)/);
  assert.match(handler[1], /needsRender = true/);
});

test('dashboard repaints when a settings push changes the motion preference', () => {
  // applyAppearance applies reduceMotion itself, so the change check must
  // compare against the value captured before it runs or it never fires.
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const handler = /window\.tokenMonitor\.onSettingsPush\?\.\(\(next\)\s*=>\s*\{([\s\S]*?)\n\}\);/.exec(js);
  assert.ok(handler, 'dashboard should subscribe to settings pushes');
  assert.match(handler[1], /const previousReduceMotion = state\.reduceMotion;\s*(?:\/\/[^\n]*\n\s*)*applyAppearance\(state\.settings\)/);
  assert.match(handler[1], /if \(state\.reduceMotion !== previousReduceMotion\) needsRender = true/);
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

test('main forwards live stats:push snapshots to a ready visible dashboard window', () => {
  const main = read('src', 'electron', 'main.js');
  const sentDashboard = [];
  const sentMain = [];
  const context = {
    latestStats: null,
    latestStatsSource: null,
    hubModeGeneration: 1,
    statsPushRevision: 0,
    statsPushSource: null,
    mode: 'local',
    settings: {},
    edgeDockManualStats: null,
    lastRendererStatsFingerprint: null,
    mainWindowStatsPushWanted: () => true,
    mainWindow: {
      isDestroyed: () => false,
      webContents: { send: (ch, payload) => sentMain.push([ch, payload]) }
    },
    dashboardWindowReady: true,
    dashboardWindow: {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { send: (ch, payload) => sentDashboard.push([ch, payload]) }
    },
    statsHistoryRevision: () => 'rev-1',
    injectLocalDeviceStatus: (s) => s,
    currentHubStatsIdentity: () => 'local',
    getSyncContentRuntime: () => ({ notifyStats() {} }),
    getAccountPresentationSync: () => ({ notifyStats() {} }),
    electronPresentationStats: (s) => s,
    getLimitsHistoryStore: () => ({ record() {} }),
    limitsHistoryController: null,
    migrateCodexAdditionalLimits() {},
    rendererSnapshots: { stamp: (_orig, copy) => ({ ...copy, snapshot: { id: 1, source: 1 } }) },
    rendererStats: (s) => s,
    buildStatsDelta: () => ({ delta: { patched: true }, fingerprint: 'fp-1' }),
    fingerprintStats: () => 'fp-1',
    scheduleMacWidgetSnapshot() {},
    pluginRuntime: null,
    updateEdgeDockCells() {},
    syncCodexPresentationActiveAccount() {},
    updateTrayDisplay() {},
    maybeAdoptSharedSubscriptionRevision() {},
    sendMainWindowEvent() {}
  };
  vm.runInNewContext(main.slice(main.indexOf('function sendPush('), main.indexOf('function statsHistoryRevision(')), context);
  context.sendPush({ event: 'stats', data: { stats: { periods: { today: { totalTokens: 42 } }, historyRevision: 'rev-1' } } });

  assert.equal(sentMain.length, 1);
  assert.ok(sentMain[0][1].data.statsDelta, 'main window receives statsDelta');
  assert.equal(sentDashboard.length, 1);
  assert.equal(sentDashboard[0][0], 'stats:push');
  assert.equal(sentDashboard[0][1].data.stats.periods.today.totalTokens, 42, 'dashboard receives full stats payload, never main-relative statsDelta');

  context.dashboardWindow.isVisible = () => false;
  context.sendPush({ event: 'stats', data: { stats: { periods: { today: { totalTokens: 99 } }, historyRevision: 'rev-1' } } });
  assert.equal(sentDashboard.length, 1, 'hidden dashboard window does not receive stats pushes');
  context.dashboardWindow.isVisible = () => true;
  context.dashboardWindow.isMinimized = () => true;
  context.sendPush({ event: 'stats', data: { stats: { historyRevision: 'rev-1' } } });
  assert.equal(sentDashboard.length, 1, 'minimized dashboard window recovers on restore without background IPC');
});

test('dashboard tooltips stay anchored above pointer and survive live renderNow refreshes', () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const css = read('src', 'electron', 'renderer', 'dashboard.css');
  const renderNowBody = /function renderNow\(\)\s*\{([\s\S]*?)\n\}\n\nconst dashboardRenderScheduler/.exec(js);
  assert.ok(renderNowBody, 'renderNow exists');
  assert.doesNotMatch(renderNowBody[1], /\bhideTooltip\(\)/, 'live refreshes must not unconditionally dismiss active hover tooltips');
  assert.match(css, /\.dash-tooltip\s*\{[^}]*backdrop-filter:\s*blur\(28px\)/);
  assert.match(css, /\.seg-indicator\s*\{/);
  assert.match(js, /function syncSegIndicator/);

  const style = { transform: '' };
  const dataset = {};
  const tooltip = {
    style,
    dataset,
    classList: { remove() {}, add() {}, contains: () => false },
    setAttribute() {},
    getBoundingClientRect: () => ({ width: 120, height: 50 })
  };
  const context = {
    els: { tooltip },
    window: { innerWidth: 1000, innerHeight: 700 }
  };
  const positionTooltip = dashboardFunction('positionTooltip', '\nfunction showBarTooltip', context);
  positionTooltip({ left: 300, top: 200, bottom: 212, width: 12, height: 12 });
  // Above anchor: top (200) - gap (11) - tip height (50) = 139px; horizontal center: 306 - 60 = 246px.
  assert.equal(style.transform, 'translate3d(246px, 139px, 0)');
  assert.equal(dataset.visible, 'true');
});

test('widget bottom-left viewSwitcherMenu offers Usage Dashboard launcher', () => {
  const app = read('src', 'electron', 'renderer', 'app.js');
  const css = read('src', 'electron', 'renderer', 'styles.css');
  assert.match(app, /dataset\.action\s*=\s*'open-dashboard'/);
  assert.match(app, /window\.tokenMonitor\.openDashboard\(\)/);
  assert.match(css, /\.view-switcher-menu-separator/);
  assert.match(css, /\.view-switcher-menu-action/);
});

test('dashboard refresh button reuses native stationary spinner markup and invokes full manual rescan', async () => {
  const html = read('src', 'electron', 'renderer', 'dashboard.html');
  const css = read('src', 'electron', 'renderer', 'dashboard.css');
  const js = read('src', 'electron', 'renderer', 'dashboard.js');

  assert.match(html, /id="refreshBtn"[^>]*class="icon-button refresh-button"[^>]*><span class="refresh-button-icon"[^>]*><\/span><span class="refresh-button-spinner"/);
  assert.doesNotMatch(css, /dashRefreshSpin|\.icon-button\.is-refreshing/);
  assert.match(css, /\.icon-button\.refresh-button\s*\{/);

  const silentRefreshBody = /async function refresh\(\)\s*\{([\s\S]*?)\n\}\n\nasync function boot/.exec(js);
  assert.ok(silentRefreshBody, 'silent refresh function exists');
  assert.doesNotMatch(silentRefreshBody[1], /is-refreshing/, 'silent background refreshes must not spin the manual refresh button');

  const classes = new Set();
  const attrs = new Map();
  const refreshBtn = {
    disabled: false,
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      }
    },
    setAttribute(k, v) { attrs.set(k, v); },
    removeAttribute(k) { attrs.delete(k); }
  };
  const calls = [];
  let timerFn = null;
  const context = {
    els: { refreshBtn },
    state: { history: null, stats: null, motion: 'none' },
    t: (k) => k,
    observeStatsRates: (s) => calls.push(['rates', s]),
    render: () => calls.push(['render']),
    console: { log() {} },
    setTimeout: (fn) => { timerFn = fn; return 1; },
    clearTimeout() {},
    window: {
      tokenMonitor: {
        getStats: async (opts) => {
          calls.push(['getStats', opts]);
          return { periods: { today: { totalTokens: 12 } } };
        },
        getDashboardHistory: async (opts) => {
          calls.push(['getDashboardHistory', opts]);
          return { daily: [{ date: '2026-11-26', tokens: 12 }] };
        }
      }
    }
  };
  vm.runInNewContext(
    `${js.slice(js.indexOf('const REFRESH_BUTTON_FEEDBACK_MS'), js.indexOf('\nlet refreshRunning = false;'))}`,
    context
  );

  await context.manualRefresh();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['getStats', { force: true, forceHistory: true, forceSelfSync: true, feedback: true }],
    ['rates', { periods: { today: { totalTokens: 12 } } }],
    ['render'],
    ['getDashboardHistory', { includeDevices: true }],
    ['render']
  ]);
  assert.equal(refreshBtn.disabled, false);
  assert.equal(classes.has('is-refreshed'), true);
  assert.equal(classes.has('is-refreshing'), false);
  assert.ok(typeof timerFn === 'function');
  timerFn();
  assert.equal(classes.has('is-refreshed'), false);
  assert.equal(attrs.get('aria-label'), 'refreshButton.label');
});

test('dashboard hero removes redundant streak, aligns borderless active status, and stabilizes switching controls', () => {
  const html = read('src', 'electron', 'renderer', 'dashboard.html');
  const css = read('src', 'electron', 'renderer', 'dashboard.css');
  const js = read('src', 'electron', 'renderer', 'dashboard.js');

  assert.doesNotMatch(html, /dashHeroStreak|dashboard\.hero\.streak/);
  assert.doesNotMatch(js, /heroStreak|hero\.streak/);
  assert.match(css, /\.dash-hero-eyebrow\s*\{[^}]*justify-content:\s*space-between/);
  assert.doesNotMatch(css, /\.dash-hero-active\s*\{[^}]*border:\s*1px/);

  // Non-shifting controls: secondary/conditionally hidden groups precede stable primary switches.
  const activityCtrls = /class="dash-activity-controls">([\s\S]*?)<\/div>\s*<\/div>\s*<div id="dashTopology"/.exec(html);
  assert.ok(activityCtrls);
  assert.ok(
    activityCtrls[1].indexOf('id="dashHeatmapMetricControl"') < activityCtrls[1].indexOf('data-control="stageView"'),
    'Live Flow / 3D / 2D stays anchored on the right edge when Tokens / Cost toggles visibility'
  );
  const trendCtrls = /class="dash-control-row">([\s\S]*?)<div id="rangeSelect"/.exec(html);
  assert.ok(trendCtrls);
  assert.ok(
    trendCtrls[1].indexOf('data-control="mode"') < trendCtrls[1].indexOf('data-control="stack"')
    && trendCtrls[1].indexOf('data-control="trendMetric"') < trendCtrls[1].indexOf('data-control="stack"'),
    'Bars / K-line and Tokens / Cost precede By tool / By model so toggling K-line never shifts them sideways'
  );

  // Switch transitions avoid vertical bounce offsets that cause panels to jump.
  const revealBody = /function animateSectionReveal\([\s\S]*?\n\}/.exec(js);
  assert.ok(revealBody);
  assert.doesNotMatch(revealBody[0], /translateY/);
  const listAnimBody = /function animateListSnapshot\([\s\S]*?\n\}\n\nlet statCardMeasureCanvas/.exec(js);
  assert.ok(listAnimBody);
  assert.doesNotMatch(listAnimBody[0], /translateY\(5px\)/);

  // Provider icons stay monochrome while progress bars / limit meters keep brand colors.
  assert.match(css, /\.dash-shell \.row-icon:not\(\.dash-brand-mark\)/);
  assert.doesNotMatch(js, /class="[^"]*\brow-icon\b[^"]*"\s+data-c="/);
  assert.doesNotMatch(js, /class="\$\{escapeHtml\(acc\.iconClass\)\}"\s+data-c="/);
  assert.doesNotMatch(js, /els\.drawerIcon\.style\.color\s*=\s*displayColor/);

  // Minimalist 2D compact heatmap + Orbital 3D skyline wiring stay intact with zero native tooltips.
  assert.match(html, /id="dashHeatFooter"/);
  assert.doesNotMatch(html, /id="dashHeat2dInsights"/);
  assert.match(html, /id="dashSkylineStage"/);
  assert.match(html, /data-control="skylineColor"/);
  assert.match(html, /id="skylineReset"/);
  assert.match(css, /\.dash-activity-col\[data-stage="2d"\]\s*\{[^}]*min-height:\s*0/);
  assert.match(css, /\.dash-activity-col\[data-stage="2d"\] \.dash-heatmap-wrap/);
  assert.doesNotMatch(css, /\.dash-heat2d-frame|\.dash-rhythm-track/);
  assert.match(css, /\.dash-skyline-stage/);
  assert.match(css, /\.dash-skyline-canvas-host\.is-panning/);
  assert.doesNotMatch(html, /\stitle=/i);
});

test('dashboard quota motion keys contain no NUL bytes and stay stable across updates', () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const context = {};
  vm.runInNewContext(js.slice(js.indexOf('function quotaMotionKey'), js.indexOf('\nfunction renderQuotas')), context);
  const key = context.quotaMotionKey({ key: 'codex:a', name: 'Personal' }, 'Session');
  assert.equal(key.includes('\0'), false);
  assert.equal(key.includes('\uFFFD'), false);
  assert.equal(key, context.quotaMotionKey({ key: 'codex:a', name: 'Personal' }, 'Session'));
});

test('showHeatTooltip renders DOM-derived dates and labels as plain text', () => {
  const makeNode = () => ({
    textContent: '',
    children: [],
    style: {},
    set innerHTML(_value) { assert.fail('tooltip must use text nodes'); },
    replaceChildren(...nodes) { this.children = nodes; },
    append(...nodes) { this.children.push(...nodes); }
  });
  const tooltip = makeNode();
  const show = dashboardFunction('showHeatTooltip', '\nfunction showRibbonTooltip', {
    els: { tooltip },
    document: { createElement: makeNode },
    longDate: value => value,
    formatCompact: String,
    formatCost: String,
    displayColor: color => color,
    t: key => key,
    positionTooltip() {}
  });

  show('<img src=x>', { tokens: 10, cost: 1, topClient: { label: '<svg>', color: '#fff' } }, {});
  assert.equal(tooltip.children[0].textContent, '<img src=x>');
  assert.equal(tooltip.children.at(-1).children.at(-1).textContent, '<svg>');
});

test('dashboard handles session-activity pushes, rejects stale snapshots, and includes required scripts and focus accessibility', async () => {
  const html = read('src', 'electron', 'renderer', 'dashboard.html');
  const css = read('src', 'electron', 'renderer', 'dashboard.css');
  const js = read('src', 'electron', 'renderer', 'dashboard.js');

  for (const script of [
    'limits/windowLabels.js',
    'limits/usageItems.js',
    'limits/providerOrder.js',
    'sessionActivityProjection.js',
    'sessionTitleDisplay.js',
    'allTimeSessions.js',
    'providers/reasonix/sessionGuard.js',
    'sessionRows.js'
  ]) {
    assert.ok(html.includes(script), `dashboard.html must load ${script}`);
  }

  assert.match(css, /:focus-visible\s*\{/);
  assert.match(js, /function handleKeyboardClick/);
  assert.match(js, /class="dash-session-row[^"]*"[^>]*tabindex="0"\s+role="button"/);
  assert.match(js, /class="dash-bd-row"[^>]*tabindex="0"\s+role="button"/);

  const sessionActivityProjection = require('../../src/shared/sessionActivityProjection');
  let renders = 0;
  let rateCalls = 0;
  let rateResets = 0;
  let allTimeAttached = null;
  let ensured = 0;
  let invalidated = 0;
  let syncedFetchArgs = [];
  let pushHandler = null;

  const baseStats = {
    snapshot: { id: 10, source: 1 },
    periods: {
      today: {
        totalTokens: 100,
        sessions: {
          'codex:s1': { client: 'codex', sessionId: 's1', totalTokens: 100, lastUsedAt: '2026-11-26T10:00:00.000Z' }
        }
      },
      month: { totalTokens: 100, sessions: {} },
      allTime: { totalTokens: 100 }
    }
  };
  const newerPushStats = {
    snapshot: { id: 12, source: 1 },
    periods: baseStats.periods
  };
  const stalePullStats = {
    snapshot: { id: 11, source: 1 },
    periods: { today: { totalTokens: 50, sessions: {} } }
  };

  const context = {
    state: { periodKey: 'allTime', streamConnected: false, motion: 'none', stats: null, settings: {} },
    sessionActivityProjectionApi: sessionActivityProjection,
    sessionTitleDisplayApi: null,
    allTimeSessionsApi: {
      createAllTimeSessionsLoader: () => ({
        invalidate() { invalidated += 1; },
        attach(s) { allTimeAttached = s; return s; },
        ensure() { ensured += 1; }
      })
    },
    deviceRateTracker: { reset() { rateResets += 1; } },
    rateHistory: { reset() { rateResets += 1; } },
    deviceRateTrackers: new Map(),
    rateExpiryTimer: null,
    document: { hidden: false },
    refreshQueued: false,
    dashboardReady: false,
    scheduleDashboardRefresh() {},
    observeStatsRates() { rateCalls += 1; },
    render() { renders += 1; },
    reducedMotionMedia: null,
    window: {
      tokenMonitor: {
        getSyncedFixedPeriod(id, source, period) {
          syncedFetchArgs.push([id, source, period]);
          return Promise.resolve({
            detailsAvailable: true,
            period: {
              sessions: {
                'codex:omitted': { client: 'codex', sessionId: 'omitted', title: 'Paged Session', totalTokens: 200 }
              }
            }
          });
        },
        onStatsPush(fn) { pushHandler = fn; }
      }
    }
  };
  const slice = js.slice(js.indexOf('let localSessionActivity = null;'), js.indexOf('\nfunction renderNow('))
    + '\n'
    + js.slice(js.indexOf('window.tokenMonitor.onStatsPush?.'), js.indexOf('\nreducedMotionMedia?.addEventListener'));
  vm.runInNewContext(slice, context);

  // Initial stamped push is accepted
  pushHandler({ event: 'stats', data: { stats: baseStats, reason: 'local' } });
  assert.equal(context.state.stats.snapshot.id, 10);
  assert.equal(invalidated, 1);
  assert.equal(ensured, 1);
  assert.equal(rateCalls, 1);
  assert.equal(allTimeAttached?.snapshot?.id, 10);

  // session-activity patch updates stats without re-running observeStatsRates
  const ratesBeforePatch = rateCalls;
  const rendersBeforePatch = renders;
  pushHandler({
    event: 'session-activity',
    data: {
      snapshot: { id: 10, source: 1 },
      patch: {
        observations: [{
          client: 'codex',
          sessionId: 's1',
          liveActivity: { state: 'running', observedAt: '2026-11-26T10:00:05.000Z' }
        }],
        nativeSessions: {}
      }
    }
  });
  assert.equal(rateCalls, ratesBeforePatch);
  assert.equal(renders, rendersBeforePatch + 1);
  assert.equal(context.state.stats.periods.today.sessionActivity['codex:s1']?.state, 'running');

  // Newer push advances accepted snapshot id to 12; a stale pull (id 11) must be rejected
  pushHandler({ event: 'stats', data: { stats: newerPushStats, reason: 'hub' } });
  assert.equal(context.applyIncomingStats(stalePullStats, { expectedPushSeq: 1 }), false);
  assert.equal(context.state.stats.snapshot.id, 12);
  assert.equal(context.state.streamConnected, true);

  // Omitted Hub sessions trigger snapshot-bound getSyncedFixedPeriod read and merge into period sessions
  context.state.periodKey = 'today';
  context.applyIncomingStats({
    snapshot: { id: 13, source: 1 },
    sessionDetailsOmitted: { today: 3 },
    fixedRangeRevisions: { 'dev-1': 'rev-1' },
    periods: { today: { totalTokens: 500, sessions: {} } }
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(syncedFetchArgs, [[13, 1, 'today']]);
  assert.ok(context.state.stats.periods.today.sessions['codex:omitted']);

  // Switching to a newer hub source resets rate trackers and clears stale Hub pages
  assert.equal(context.applyIncomingStats({ snapshot: { id: 1, source: 2 }, periods: baseStats.periods }), true);
  assert.equal(context.state.stats.snapshot.source, 2);
  assert.ok(rateResets >= 2);
});

test('remote sessions never read local transcripts, delayed Hub A history is fenced, and open drawer title redacts immediately', async () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const sessionTitleDisplay = require('../../src/electron/sessionTitleDisplay');

  // 1. Remote session guard + openDrawer + title redaction on settings push + Hub A/B history race
  const detailCalls = [];
  const drawerBody = { innerHTML: '' };
  const drawerTitle = { textContent: '' };
  const drawerSubtitle = { textContent: '' };
  let settingsHandler = null;

  const context = {
    state: {
      periodKey: 'today',
      selectedDeviceId: 'all',
      history: { daily: [{ date: '2026-11-26', tokens: 10 }] },
      stats: { localDeviceId: 'mac-local', snapshot: { id: 1, source: 1 }, periods: { today: { totalTokens: 10, sessions: { 'codex:s1': { client: 'codex', sessionId: 's1', title: 'Secret Title', totalTokens: 10 } } } } },
      settings: { deviceId: 'mac-local', sessionTitlesEnabled: true, hubMode: 'client', hubUrl: 'https://hub-a' },
      motion: 'none',
      drawer: null,
      locale: 'en'
    },
    els: {
      drawer: { showPopover() {}, matches() { return false; } },
      drawerScrim: { classList: { remove() {}, add() {} } },
      drawerIcon: { className: '', style: {} },
      drawerTitle,
      drawerSubtitle,
      drawerBody,
      tooltip: { classList: { contains() { return true; } } },
      refreshBtn: { classList: { toggle() {} }, setAttribute() {}, removeAttribute() {}, disabled: false },
      body: { classList: { toggle() {} } }
    },
    fixedPeriodRangesApi: require('../../src/electron/renderer/fixedPeriodRanges'),
    modelApi: { computeSessionDetailAnatomy: () => ({ segments: [] }) },
    sessionTitleDisplayApi: sessionTitleDisplay,
    sessionActivityProjectionApi: null,
    allTimeSessionsApi: null,
    tokenRateApi: null,
    charts: { clientColors: {} },
    deviceRateTracker: { getSample() { return null; }, reset() {}, observe() {} },
    rateHistory: { getSamples() { return []; }, reset() {}, observe() {} },
    deviceRateTrackers: new Map(),
    rateExpiryTimer: null,
    dashboardReady: true,
    document: { hidden: false },
    escapeHtml: (s) => String(s ?? ''),
    formatCompact: String,
    formatCost: String,
    applySwatchColors() {},
    applyAppearance() {},
    handleKeyboardClick() {},
    drawerStatGrid: () => '<div></div>',
    drawerRequestToken: 0,
    applyReduceMotionPreference() {},
    render() {},
    scheduleDashboardRefresh() {},
    i18n: { resolveLocale: () => 'en' },
    compactTokenApi: { normalizeCompactTokenUnits: (v) => v },
    navigator: { languages: ['en'] },
    reducedMotionMedia: null,
    console: { log() {} },
    setTimeout,
    clearTimeout,
    t: (k) => k,
    window: {
      tokenMonitor: {
        getSessionDetail(args) {
          detailCalls.push(args);
          return Promise.resolve({ found: false });
        },
        onSettingsPush(fn) { settingsHandler = fn; },
        getDashboardHistory: async () => ({ daily: [{ date: '2026-11-26', tokens: 999 }] }),
        getStats: async () => ({ snapshot: { id: 1, source: 1 }, periods: {} })
      }
    }
  };
  const openDrawerSlice = js.slice(js.indexOf('function closeDrawer('), js.indexOf('\nfunction renderNow('))
    + '\n'
    + js.slice(js.indexOf('function observeStatsRates('), js.indexOf('\nasync function boot('))
    + '\n'
    + js.slice(js.indexOf('window.tokenMonitor.onSettingsPush?.'), js.indexOf('\nwindow.tokenMonitor.onStatsPush?.'));
  vm.runInNewContext(openDrawerSlice, context);

  // Remote session (matching local ID s1!) must NOT invoke getSessionDetail
  context.openDrawer({
    kind: 'session',
    session: { client: 'codex', sessionId: 's1', title: 'Remote Title', projectLabel: 'Repo', clientLabel: 'Codex', sourceDevice: { deviceId: 'linux-remote', name: 'Linux' } }
  });
  assert.equal(detailCalls.length, 0);

  // Local session invokes getSessionDetail and holds a Secret Title
  context.openDrawer({
    kind: 'session',
    session: { client: 'codex', sessionId: 's1', title: 'Secret Title', projectLabel: 'Repo', clientLabel: 'Codex', sourceDevice: { deviceId: 'mac-local', name: 'Mac' } }
  });
  assert.equal(detailCalls.length, 1);
  assert.equal(drawerTitle.textContent, 'Secret Title');

  // Disabling session titles via settings push immediately redacts open drawer title & stats
  settingsHandler({ sessionTitlesEnabled: false });
  assert.equal(drawerTitle.textContent, 'Repo');
  assert.equal(context.state.stats.periods.today.sessions['codex:s1'].title, undefined);

  // Delayed Hub A history + stats response is rejected after Hub B stats push lands mid-flight
  let resolveHubAHistory;
  context.window.tokenMonitor.getDashboardHistory = () => new Promise((r) => { resolveHubAHistory = r; });
  context.window.tokenMonitor.getStats = async () => ({ snapshot: { id: 2, source: 1 }, periods: { today: { totalTokens: 11 } } });
  const pendingRefresh = context.refresh();
  await new Promise((r) => setTimeout(r, 0));
  // Hub B (source: 2) arrives while Hub A's history promise is still pending
  assert.equal(context.applyIncomingStats({ snapshot: { id: 1, source: 2 }, periods: { today: { totalTokens: 222 } } }), true);
  context.state.history = { daily: [{ date: '2026-11-26', tokens: 222 }] };
  resolveHubAHistory({ daily: [{ date: '2026-11-25', tokens: 11 }] });
  await pendingRefresh;
  assert.equal(context.state.drawer, null, 'source change dismisses the previous session drawer');
  assert.equal(context.state.history.daily[0].tokens, 222, 'Hub A delayed history must not overwrite Hub B history');
  assert.equal(context.state.stats.snapshot.source, 2);
});

test('renderQuotas renders expired plan status without meter, hover refresh handles quotes, rate expiry clears idle topology rates, and ledger matches chart range and focus', async () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const charts = require('../../src/electron/renderer/usageCharts');
  const tokenRate = require('../../src/electron/renderer/tokenRatePresentation');

  // 1. Expired MiMo plan renders localized Expired text with no meter track
  const quotasEl = { innerHTML: '', scrollTop: 0, querySelectorAll: () => [] };
  const qCountEl = { textContent: '' };
  const quotaContext = {
    els: { quotas: quotasEl, quotasCount: qCountEl },
    state: { settings: {}, locale: 'en', motion: 'none' },
    charts,
    homeLimitMotion: null,
    lastQuotasStructureSig: '',
    escapeHtml: (s) => String(s ?? ''),
    applySwatchColors() {},
    displayColor: (c) => c,
    formatResetShort: () => '',
    quotaWindowFlags: () => ({ isExhausted: false, isCritical: false, isLow: false, isValueLow: false, isUntouched: false }),
    formatQuotaWindowLabel: (w) => w.label || w.kind,
    t: (k) => (k === 'limits.mimo.planExpired' ? 'Expired' : k)
  };
  vm.runInNewContext(js.slice(js.indexOf('function quotaMotionKey'), js.indexOf('\nfunction sessionStateIconHtml')), quotaContext);
  quotaContext.renderQuotas({
    quotas: [{
      key: 'mimo:1',
      providerId: 'mimo',
      name: 'MiMo',
      windows: [{ kind: 'billing', label: 'Token Plan', planStatus: 'expired', showMeter: false, remainingPercent: null, fillPercent: 0 }]
    }]
  });
  assert.match(quotasEl.innerHTML, />Expired</);
  assert.doesNotMatch(quotasEl.innerHTML, /home-limit-track/);
  assert.doesNotMatch(quotasEl.innerHTML, /0%/);

  // 2. Quoted workspace ID in refreshActiveHover uses dataset lookup and does not throw
  let focusedNode = null;
  let tooltipHead = null;
  const quotedNode = { dataset: { topoKind: 'hub', topoId: 'ws:client "a"' } };
  const hoverContext = {
    activeHover: { kind: 'topo', nodeKind: 'hub', nodeId: 'ws:client "a"' },
    state: { stageView: 'flow', overview: {} },
    els: {
      tooltip: { matches: () => true, classList: { contains: () => false } },
      topology: { querySelectorAll: () => [quotedNode] }
    },
    findByDataset: (root, _sel, pred) => root.querySelectorAll().find(pred) || null,
    applyTopologyFocus: (k, id) => { focusedNode = `${k}:${id}`; },
    showTopologyTooltip: (_k, id) => { tooltipHead = id; }
  };
  vm.runInNewContext(js.slice(js.indexOf('function refreshActiveHover'), js.indexOf('\nlet localSessionActivity')), hoverContext);
  hoverContext.refreshActiveHover();
  assert.equal(focusedNode, 'hub:ws:client "a"');
  assert.equal(tooltipHead, 'ws:client "a"');

  // 3. Per-device measured velocity excludes idle samples from currentLiveRatesByDevice and schedules expiry repaint
  let scheduledTimer = null;
  const timers = [];
  let nowVal = 1_760_000_000_000;
  const realDateNow = Date.now;
  Date.now = () => nowVal;
  try {
    const rateContext = {
      Date: { now: () => nowVal },
      tokenRateApi: tokenRate,
      deviceRateTracker: tokenRate.createLiveTokenRateGroupTracker({ now: () => nowVal, activeMs: 12_000 }),
      rateHistory: tokenRate.createLiveTokenRateHistory({ now: () => nowVal }),
      deviceRateTrackers: new Map(),
      rateExpiryTimer: null,
      state: { stats: { localDeviceId: 'dev-1' }, motion: 'update' },
      document: { hidden: false },
      render() {},
      setTimeout(fn, ms) { const h = { fn, ms }; scheduledTimer = h; timers.push(h); return h; },
      clearTimeout() {}
    };
    // Patch createLiveTokenRateGroupTracker now option inside observeStatsRates context via Date.now mock
    vm.runInNewContext(js.slice(js.indexOf('function scheduleRateExpiry'), js.indexOf('\nconst REFRESH_BUTTON_FEEDBACK_MS')), rateContext);
    rateContext.observeStatsRates({
      devices: [
        {
          deviceId: 'dev-1',
          periods: {
            today: {
              timedOutputTokens: 0, timedTokens: 0, timedDurationMs: 0,
              modelThroughput: { m1: { timedOutputTokens: 0, timedTokens: 0, timedDurationMs: 0 }, m2: { timedOutputTokens: 0, timedTokens: 0, timedDurationMs: 0 } }
            }
          }
        },
        { deviceId: 'dev-2', periods: { today: { timedOutputTokens: 0, timedTokens: 0, timedDurationMs: 0 } } }
      ]
    });
    nowVal += 1000;
    rateContext.observeStatsRates({
      devices: [
        {
          deviceId: 'dev-1',
          periods: {
            today: {
              timedOutputTokens: 150, timedTokens: 600, timedDurationMs: 1000,
              modelThroughput: { m1: { timedOutputTokens: 150, timedTokens: 600, timedDurationMs: 1000 }, m2: { timedOutputTokens: 150, timedTokens: 600, timedDurationMs: 1000 } }
            }
          }
        },
        { deviceId: 'dev-2', periods: { today: { timedOutputTokens: 100, timedTokens: 400, timedDurationMs: 1000 } } }
      ]
    });
    assert.deepEqual(JSON.parse(JSON.stringify(rateContext.currentLiveRatesByDevice())), { 'dev-1': 150, 'dev-2': 100 });
    assert.ok(scheduledTimer && scheduledTimer.ms >= 11_000, 'expiry repaint timer should be armed');
    nowVal += 12_500;
    assert.deepEqual(JSON.parse(JSON.stringify(rateContext.currentLiveRatesByDevice())), {}, 'idle retained sample must not appear in live topology rates');
  } finally {
    Date.now = realDateNow;
  }

  // 4. Ledger calendar range excludes old November 10 from 7-day range on November 26 + focus preserved across rebuilds
  let focusCalls = 0;
  const focusTarget = { dataset: { day: '2026-11-26' }, closest: () => focusTarget };
  const rebuiltFocusTarget = { dataset: { day: '2026-11-26' }, addEventListener() {}, focus() { focusCalls += 1; } };
  const ledgerEl = {
    innerHTML: '',
    contains: (el) => el === focusTarget,
    querySelectorAll: (sel) => (sel.includes('data-day') ? [rebuiltFocusTarget] : [])
  };
  const legendRow = { dataset: { legendKey: 'codex' }, closest: () => legendRow };
  const rebuiltLegendRow = { dataset: { legendKey: 'codex' }, focus() { focusCalls += 1; }, addEventListener() {} };
  const legendEl = {
    innerHTML: '',
    contains: (el) => el === legendRow,
    querySelectorAll: () => [rebuiltLegendRow]
  };
  const uiContext = {
    els: { dailyLedger: ledgerEl, ledgerMeta: { textContent: '' }, legend: legendEl },
    state: { range: '7', soloKey: null, trendMetric: 'tokens' },
    charts,
    document: { activeElement: focusTarget },
    todayKey: () => '2026-11-26',
    shortDate: (d) => d,
    escapeHtml: (s) => String(s ?? ''),
    formatCompact: String,
    formatCost: String,
    displayColor: (c) => c,
    colorFor: () => '#fff',
    applySwatchColors() {},
    openDrawer() {},
    renderTrends() {},
    t: (k) => k
  };
  vm.runInNewContext(js.slice(js.indexOf('function findByDataset'), js.indexOf('\nfunction renderTrends')), uiContext);
  uiContext.renderDailyLedger({
    dailyLedger: [
      { date: '2026-11-26', tokens: 300, cost: 1, deltaPercent: null },
      { date: '2026-11-10', tokens: 100, cost: 0.5, deltaPercent: null }
    ]
  });
  assert.match(ledgerEl.innerHTML, /2026-11-26/);
  assert.doesNotMatch(ledgerEl.innerHTML, /2026-11-10/);
  assert.equal(focusCalls, 1, 'keyboard focus should restore onto matching rebuilt ledger row');

  uiContext.document.activeElement = legendRow;
  uiContext.renderLegend({ keys: ['codex'], bars: [{ segments: [{ key: 'codex', value: 10 }] }] });
  assert.equal(focusCalls, 2, 'keyboard focus should restore onto matching rebuilt legend row');
});

test('dashboard guards synced ambiguous transcripts, native activity redaction, source-switch refresh, and aggregate rate fallback', async () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const dashboardModel = require('../../src/electron/renderer/dashboardModel');
  const { projectSessionDeviceStats } = require('../../src/electron/sessionDeviceSources');
  const sessionTitleDisplay = require('../../src/electron/sessionTitleDisplay');
  const sessionActivityProjection = require('../../src/shared/sessionActivityProjection');
  const tokenRate = require('../../src/electron/renderer/tokenRatePresentation');

  const detailCalls = [];
  const drawerBody = { innerHTML: '' };
  const drawerTitle = { textContent: '' };
  const drawerSubtitle = { textContent: '' };
  let resolvePage = null;
  let settingsHandler = null;
  let statsHandler = null;
  let scheduledFrames = [];
  let resolveHubAHistory = null;
  let historyFetchCount = 0;

  const rawTwoDeviceStats = {
    localDeviceId: 'mac-local',
    snapshot: { id: 20, source: 1 },
    sessionDetailsOmitted: { today: 1 },
    fixedRangeRevisions: { 'linux-remote': 'rev-1' },
    devices: [
      {
        deviceId: 'mac-local',
        displayName: 'MacBook',
        platform: 'darwin',
        periods: {
          today: {
            totalTokens: 200,
            sessions: {
              'codex:shared': { client: 'codex', sessionId: 'shared', totalTokens: 50 },
              'codex:local-only': { client: 'codex', sessionId: 'local-only', totalTokens: 150 }
            }
          }
        }
      },
      {
        deviceId: 'linux-remote',
        displayName: 'Linux',
        platform: 'linux',
        periods: {
          today: {
            totalTokens: 50,
            sessions: {
              'codex:shared': { client: 'codex', sessionId: 'shared', totalTokens: 50 }
            }
          }
        }
      }
    ],
    periods: {
      today: {
        totalTokens: 250,
        sessions: {
          'codex:shared': { client: 'codex', sessionId: 'shared', title: 'Shared Session', totalTokens: 100 },
          'codex:local-only': { client: 'codex', sessionId: 'local-only', title: 'Local Only Session', totalTokens: 150 },
          'codex:paged-shared': {
            client: 'codex',
            sessionId: 'paged-shared',
            title: 'Inline Local Stamp',
            totalTokens: 60,
            sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
          }
        }
      }
    }
  };
  const projected = projectSessionDeviceStats(rawTwoDeviceStats, 'mac-local');

  const context = {
    state: {
      periodKey: 'today',
      selectedDeviceId: 'all',
      history: { daily: [{ date: '2026-11-25', tokens: 11 }] },
      stats: projected,
      settings: { deviceId: 'mac-local', sessionTitlesEnabled: true, hubMode: 'client', hubUrl: 'https://hub-a' },
      statsMode: 'sync',
      motion: 'none',
      drawer: null,
      locale: 'en'
    },
    els: {
      drawer: { showPopover() {}, matches() { return false; } },
      drawerScrim: { classList: { remove() {}, add() {} } },
      drawerIcon: { className: '', style: {} },
      drawerTitle,
      drawerSubtitle,
      drawerBody,
      tooltip: { classList: { contains() { return true; } } },
      refreshBtn: { classList: { toggle() {} }, setAttribute() {}, removeAttribute() {}, disabled: false },
      body: { classList: { toggle() {} } }
    },
    fixedPeriodRangesApi: require('../../src/electron/renderer/fixedPeriodRanges'),
    modelApi: dashboardModel,
    sessionTitleDisplayApi: sessionTitleDisplay,
    sessionActivityProjectionApi: sessionActivityProjection,
    allTimeSessionsApi: null,
    tokenRateApi: null,
    charts: { clientColors: {} },
    deviceRateTracker: { getSample() { return null; }, reset() {}, observe() {} },
    rateHistory: { getSamples() { return []; }, reset() {}, observe() {} },
    deviceRateTrackers: new Map(),
    rateExpiryTimer: null,
    dashboardReady: true,
    dashboardRefreshFrame: 0,
    document: { hidden: false },
    requestAnimationFrame(cb) {
      scheduledFrames.push(cb);
      return scheduledFrames.length;
    },
    cancelAnimationFrame() {
      scheduledFrames = [];
    },
    escapeHtml: (s) => String(s ?? ''),
    formatCompact: String,
    formatCost: String,
    applySwatchColors() {},
    applyAppearance() {},
    handleKeyboardClick() {},
    drawerStatGrid: () => '<div></div>',
    drawerRequestToken: 0,
    applyReduceMotionPreference() {},
    render() {},
    i18n: { resolveLocale: () => 'en' },
    compactTokenApi: { normalizeCompactTokenUnits: (v) => v },
    navigator: { languages: ['en'] },
    reducedMotionMedia: null,
    console: { log() {} },
    setTimeout,
    clearTimeout,
    t: (k) => k,
    window: {
      tokenMonitor: {
        getSessionDetail(args) {
          detailCalls.push(args);
          return Promise.resolve({ found: false });
        },
        getSyncedFixedPeriod: () => new Promise((r) => { resolvePage = r; }),
        onSettingsPush(fn) { settingsHandler = fn; },
        onStatsPush(fn) { statsHandler = fn; },
        getDashboardHistory: () => {
          historyFetchCount += 1;
          if (historyFetchCount === 1) {
            return new Promise((r) => { resolveHubAHistory = r; });
          }
          return Promise.resolve({ daily: [{ date: '2026-11-26', tokens: 222 }] });
        },
        getStats: async () => ({ snapshot: { id: 1, source: 3 }, periods: { today: { totalTokens: 222 } } })
      }
    }
  };

  const slice = js.slice(js.indexOf('function closeDrawer('), js.indexOf('\nfunction renderNow('))
    + '\n'
    + js.slice(js.indexOf('function scheduleDashboardRefresh('), js.indexOf('\nfunction handleDashboardVisibilityChange('))
    + '\n'
    + js.slice(js.indexOf('function observeStatsRates('), js.indexOf('\nasync function boot('))
    + '\n'
    + js.slice(js.indexOf('window.tokenMonitor.onSettingsPush?.'), js.indexOf('\nreducedMotionMedia?.addEventListener'));
  vm.runInNewContext(slice, context);

  // 1A. Held-pending paged ownership check: inline local stamp defers transcript IPC until paging resolves
  context.openDrawer({
    kind: 'session',
    session: context.state.stats.periods.today.sessions['codex:paged-shared']
  });
  await Promise.resolve();
  assert.equal(drawerTitle.textContent, 'Inline Local Stamp', 'summary drawer renders while ownership is pending');
  assert.equal(detailCalls.length, 0, 'transcript IPC must defer while synced ownership page is pending');
  assert.equal(typeof resolvePage, 'function');
  const finishPage1 = resolvePage;
  resolvePage = null;
  finishPage1({
    detailsAvailable: true,
    period: {
      sessions: {
        'codex:paged-shared': {
          client: 'codex',
          sessionId: 'paged-shared',
          title: 'Paged Ambiguous',
          totalTokens: 60,
          sourceDevice: { ambiguous: true }
        },
        'codex:local-only': {
          client: 'codex',
          sessionId: 'local-only',
          title: 'Local Only Session',
          totalTokens: 150,
          sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
        }
      }
    }
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(context.state.stats.periods.today.sessions['codex:paged-shared'].sourceDevice?.ambiguous, true, 'paged ambiguity must survive inline merge');
  assert.equal(detailCalls.length, 0, 'resolved ambiguous paged session must never read local transcript');

  // 1B. Held-pending drawer opens transcript IPC once paging confirms positive local ownership for current snapshot
  context.applyIncomingStats({
    ...projected,
    snapshot: { id: 21, source: 1 },
    sessionDetailsOmitted: { today: 1 },
    fixedRangeRevisions: { 'linux-remote': 'rev-2' }
  });
  context.openDrawer({
    kind: 'session',
    session: {
      ...projected.periods.today.sessions['codex:local-only'],
      key: 'codex:local-only',
      title: 'Local Only Session'
    }
  });
  await Promise.resolve();
  assert.equal(detailCalls.length, 0, 'local-only session also waits until snapshot ownership paging completes');
  assert.equal(typeof resolvePage, 'function');
  const finishPage2 = resolvePage;
  finishPage2({
    detailsAvailable: true,
    period: {
      sessions: {
        'codex:local-only': {
          client: 'codex',
          sessionId: 'local-only',
          title: 'Local Only Session',
          totalTokens: 150,
          sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
        }
      }
    }
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(detailCalls.length, 1);
  assert.equal(detailCalls[0].sessionId, 'local-only');

  // 1C. Complete snapshot (no omitted details): shared projected session never reads local transcript, local-only does
  context.applyIncomingStats({
    ...projected,
    snapshot: { id: 22, source: 1 },
    sessionDetailsOmitted: undefined
  });
  const sessionList = dashboardModel.buildSessionList({
    stats: projected,
    periodKey: 'today',
    settings: context.state.settings,
    statsMode: context.state.statsMode
  });
  const sharedEntry = sessionList.find((s) => s.key === 'codex:shared');
  const localOnlyEntry = sessionList.find((s) => s.key === 'codex:local-only');
  assert.equal(sharedEntry.sourceDevice, null);
  context.openDrawer({ kind: 'session', session: sharedEntry });
  assert.equal(detailCalls.length, 1, 'ambiguous shared synced session must not read local transcript');
  context.openDrawer({ kind: 'session', session: localOnlyEntry });
  assert.equal(detailCalls.length, 2, 'positively owned local synced session can read local transcript');

  // 2. Cached native activity patch stays redacted after disabling sessionTitlesEnabled
  const liveIso = new Date().toISOString();
  statsHandler({
    event: 'stats',
    data: {
      stats: {
        localDeviceId: 'mac-local',
        snapshot: { id: 30, source: 2 },
        periods: { today: { totalTokens: 10, sessions: {} } }
      },
      reason: 'hub'
    }
  });
  statsHandler({
    event: 'session-activity',
    data: {
      snapshot: { id: 30, source: 2 },
      patch: {
        observations: [],
        nativeSessions: {
          today: {
            'claude:n1': {
              client: 'claude',
              sessionId: 'n1',
              title: 'Secret Native Title',
              projectLabel: 'NativeRepo',
              lastUsedAt: liveIso
            }
          }
        }
      }
    }
  });
  assert.equal(context.state.stats.nativeSessions.today['claude:n1'].title, 'Secret Native Title');
  context.openDrawer({
    kind: 'session',
    session: { client: 'claude', sessionId: 'n1', title: 'Secret Native Title', projectLabel: 'NativeRepo', isNativeLocal: true }
  });
  assert.equal(drawerTitle.textContent, 'Secret Native Title');

  settingsHandler({ sessionTitlesEnabled: false });
  assert.equal(context.state.stats.nativeSessions.today['claude:n1'].title, undefined, 'native session title must stay redacted after activity patch');
  assert.equal(drawerTitle.textContent, 'NativeRepo', 'open drawer title must redact immediately');
  statsHandler({
    event: 'session-activity',
    data: {
      snapshot: { id: 30, source: 2 },
      patch: {
        observations: [],
        nativeSessions: {
          today: {
            'claude:n1': {
              client: 'claude',
              sessionId: 'n1',
              title: 'Second Native Title',
              projectLabel: 'NativeRepo',
              lastUsedAt: liveIso
            }
          }
        }
      }
    }
  });
  assert.equal(context.state.stats.nativeSessions.today['claude:n1'].title, undefined);

  // 3. Switching sources during an in-flight Hub A refresh clears Hub A history and completes Hub B refresh without historyChanged
  context.state.history = { daily: [{ date: '2026-11-25', tokens: 11 }] };
  const hubARefresh = context.refresh();
  await new Promise((r) => setTimeout(r, 0));
  statsHandler({
    event: 'stats',
    data: {
      stats: { snapshot: { id: 1, source: 3 }, periods: { today: { totalTokens: 222 } } },
      reason: 'hub'
    }
  });
  assert.equal(context.state.history, null, 'source switch must clear prior Hub history immediately');
  // Simulate pre-existing animation frame firing while Hub A refresh is still running
  context.scheduleDashboardRefresh();
  for (const cb of scheduledFrames.splice(0)) cb();
  resolveHubAHistory({ daily: [{ date: '2026-11-25', tokens: 11 }] });
  await hubARefresh;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(historyFetchCount, 2, 'queued replacement refresh must run automatically on source switch');
  assert.equal(context.state.history?.daily?.[0]?.tokens, 222, 'Hub B history must replace cleared Hub A history');

  // 4. Synced snapshot with no usable device rows must never attribute aggregate rate to local device
  let nowVal = 1_760_000_000_000;
  const realDateNow = Date.now;
  Date.now = () => nowVal;
  try {
    const rateContext = {
      Date: { now: () => nowVal },
      tokenRateApi: tokenRate,
      deviceRateTracker: tokenRate.createLiveTokenRateGroupTracker({ now: () => nowVal, activeMs: 12_000 }),
      rateHistory: tokenRate.createLiveTokenRateHistory({ now: () => nowVal }),
      deviceRateTrackers: new Map(),
      rateExpiryTimer: null,
      state: {
        stats: { localDeviceId: 'mac-local', devices: [] },
        settings: { hubMode: 'client', hubUrl: 'https://hub.example', deviceId: 'mac-local' },
        motion: 'update'
      },
      document: { hidden: false },
      render() {},
      setTimeout,
      clearTimeout
    };
    vm.runInNewContext(
      js.slice(js.indexOf('function isRemoteSession('), js.indexOf('\nfunction openDrawer('))
      + '\n'
      + js.slice(js.indexOf('function scheduleRateExpiry('), js.indexOf('\nconst REFRESH_BUTTON_FEEDBACK_MS')),
      rateContext
    );
    const baselinePeriod = {
      timedOutputTokens: 0, timedTokens: 0, timedDurationMs: 0,
      modelThroughput: { 'gpt-6.2-sol': { timedOutputTokens: 0, timedTokens: 0, timedDurationMs: 0 } }
    };
    const nextPeriod = {
      timedOutputTokens: 100, timedTokens: 400, timedDurationMs: 1000,
      modelThroughput: { 'gpt-6.2-sol': { timedOutputTokens: 100, timedTokens: 400, timedDurationMs: 1000 } }
    };
    rateContext.observeStatsRates({ localDeviceId: 'mac-local', devices: [], periods: { today: baselinePeriod } });
    nowVal += 1000;
    rateContext.observeStatsRates({ localDeviceId: 'mac-local', devices: [], periods: { today: nextPeriod } });
    assert.deepEqual(JSON.parse(JSON.stringify(rateContext.currentLiveRatesByDevice())), {}, 'synced aggregate period without devices must not synthesize local rate');
    assert.equal(rateContext.deviceRateTrackers.size, 0);

    // Pure local mode (non-synced) continues to observe stats.periods.today for localDeviceId
    rateContext.state.settings = { hubMode: 'local', hubUrl: 'https://hub.example', deviceId: 'mac-local' };
    rateContext.observeStatsRates({ localDeviceId: 'mac-local', devices: [], periods: { today: baselinePeriod } });
    nowVal += 1000;
    rateContext.observeStatsRates({ localDeviceId: 'mac-local', devices: [], periods: { today: nextPeriod } });
    assert.deepEqual(JSON.parse(JSON.stringify(rateContext.currentLiveRatesByDevice())), { 'mac-local': 100 });
  } finally {
    Date.now = realDateNow;
  }

  // 5. Switching to Local Only while preserving saved hubUrl still reads local Last 7 Days session details
  settingsHandler({ hubMode: 'local' });
  assert.equal(context.state.settings.hubUrl, 'https://hub-a');
  statsHandler({
    event: 'stats',
    data: {
      mode: 'local',
      reason: 'local',
      stats: {
        localDeviceId: 'mac-local',
        snapshot: { id: 1, source: 4 },
        devices: [{ deviceId: 'mac-local', displayName: 'MacBook', periods: { last7: { totalTokens: 120 } } }],
        periods: {
          last7: {
            totalTokens: 120,
            sessions: {
              'codex:l7': { client: 'codex', sessionId: 'l7', title: 'Local 7d', totalTokens: 120 }
            }
          }
        }
      }
    }
  });
  context.state.periodKey = 'last7';
  const callsBeforeLocalOnly = detailCalls.length;
  const localLast7List = dashboardModel.buildSessionList({
    stats: context.state.stats,
    periodKey: 'last7',
    settings: context.state.settings,
    statsMode: context.state.statsMode
  });
  context.openDrawer({ kind: 'session', session: localLast7List[0] });
  assert.equal(detailCalls.length, callsBeforeLocalOnly + 1, 'local-only session with retained hubUrl must invoke getSessionDetail');
  assert.equal(detailCalls.at(-1)?.sessionId, 'l7');
});

test('dashboard binds deferred drawer ownership to supplying period and invalidates pending drawer across source changes', async () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const dashboardModel = require('../../src/electron/renderer/dashboardModel');
  const { resolveSyncedSessionPeriod } = require('../../src/electron/syncedFixedPeriod');

  const detailCalls = [];
  const drawerTitle = { textContent: '' };
  const drawerSubtitle = { textContent: '' };
  const drawerBody = { innerHTML: '' };
  const pendingPages = new Map();
  let statsHandler = null;
  const nowIso = new Date().toISOString();
  const todayKey = nowIso.slice(0, 10);

  const devicesWithCollision = [
    {
      deviceId: 'mac-local',
      displayName: 'MacBook',
      platform: 'darwin',
      periodWindows: { today: { key: todayKey } },
      sessionDetailsOmitted: { today: 1, month: 1 },
      periods: {
        today: { totalTokens: 100, sessions: {} },
        month: {
          totalTokens: 500,
          sessions: {
            'codex:carried': {
              client: 'codex',
              sessionId: 'carried',
              title: 'Carried Session',
              totalTokens: 500,
              status: 'running',
              lastUsedAt: nowIso
            }
          }
        }
      }
    },
    {
      deviceId: 'linux-remote',
      displayName: 'Linux',
      platform: 'linux',
      periodWindows: { today: { key: todayKey } },
      sessionDetailsOmitted: { today: 1, month: 1 },
      periods: {
        today: { totalTokens: 100, sessions: {} },
        month: { totalTokens: 500, sessions: {} }
      }
    }
  ];

  const statsBothOmitted = {
    localDeviceId: 'mac-local',
    snapshot: { id: 1, source: 1 },
    devices: devicesWithCollision,
    sessionDetailsOmitted: { today: 1, month: 1 },
    fixedRangeRevisions: { 'mac-local': 'r-mac', 'linux-remote': 'r-linux' },
    periods: {
      today: { totalTokens: 200, sessions: {} },
      month: {
        totalTokens: 1000,
        sessions: {
          'codex:carried': {
            client: 'codex',
            sessionId: 'carried',
            title: 'Carried Session',
            totalTokens: 500,
            status: 'running',
            lastUsedAt: nowIso,
            sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
          }
        }
      }
    }
  };

  const context = {
    state: {
      periodKey: 'today',
      selectedDeviceId: 'all',
      history: null,
      stats: statsBothOmitted,
      settings: { deviceId: 'mac-local', sessionTitlesEnabled: true, hubMode: 'client', hubUrl: 'https://hub-a' },
      statsMode: 'sync',
      motion: 'none',
      drawer: null,
      locale: 'en'
    },
    els: {
      drawer: { showPopover() {}, matches() { return false; } },
      drawerScrim: { classList: { remove() {}, add() {} } },
      drawerIcon: { className: '', style: {} },
      drawerTitle,
      drawerSubtitle,
      drawerBody,
      tooltip: { classList: { contains() { return true; } } },
      refreshBtn: { classList: { toggle() {} }, setAttribute() {}, removeAttribute() {}, disabled: false },
      body: { classList: { toggle() {} } }
    },
    fixedPeriodRangesApi: require('../../src/electron/renderer/fixedPeriodRanges'),
    modelApi: dashboardModel,
    sessionTitleDisplayApi: require('../../src/electron/sessionTitleDisplay'),
    sessionActivityProjectionApi: null,
    allTimeSessionsApi: require('../../src/electron/renderer/allTimeSessions'),
    tokenRateApi: null,
    charts: { clientColors: {} },
    deviceRateTracker: { getSample() { return null; }, reset() {}, observe() {} },
    rateHistory: { getSamples() { return []; }, reset() {}, observe() {} },
    deviceRateTrackers: new Map(),
    rateExpiryTimer: null,
    dashboardReady: true,
    dashboardRefreshFrame: 0,
    document: { hidden: false },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    scheduleDashboardRefresh() {},
    escapeHtml: (s) => String(s ?? ''),
    formatCompact: String,
    formatCost: String,
    applySwatchColors() {},
    applyAppearance() {},
    handleKeyboardClick() {},
    drawerStatGrid: () => '<div></div>',
    drawerRequestToken: 0,
    applyReduceMotionPreference() {},
    render() {},
    i18n: { resolveLocale: () => 'en' },
    compactTokenApi: { normalizeCompactTokenUnits: (v) => v },
    navigator: { languages: ['en'] },
    reducedMotionMedia: null,
    console: { log() {} },
    setTimeout,
    clearTimeout,
    t: (k) => k,
    window: {
      tokenMonitor: {
        getSessionDetail(args) {
          detailCalls.push(args);
          return Promise.resolve({ found: false });
        },
        getSyncedFixedPeriod(id, source, period) {
          return new Promise((resolve) => {
            pendingPages.set(`${source}:${id}:${period}`, resolve);
          });
        },
        onStatsPush(fn) { statsHandler = fn; }
      }
    }
  };

  const slice = js.slice(js.indexOf('function closeDrawer('), js.indexOf('\nfunction renderNow('))
    + '\n'
    + js.slice(js.indexOf('function observeStatsRates('), js.indexOf('\nasync function boot('))
    + '\n'
    + js.slice(js.indexOf('window.tokenMonitor.onStatsPush?.'), js.indexOf('\nreducedMotionMedia?.addEventListener'));
  vm.runInNewContext(slice, context);

  // 1. Both today and month omitted: Month-carried session waits on Month, ignores Today completion, stays blocked on ambiguous Month page
  context.ensureSyncedSessionPages('today');
  const todayCarriedList = dashboardModel.buildSessionList({
    stats: statsBothOmitted,
    periodKey: 'today',
    settings: context.state.settings,
    statsMode: context.state.statsMode,
    nowMs: Date.parse(nowIso)
  });
  const carriedEntry = todayCarriedList.find((s) => s.key === 'codex:carried');
  assert.equal(carriedEntry.resumedFromPriorPeriod, true);
  assert.equal(carriedEntry.sourcePeriodKey, 'month');

  context.openDrawer({ kind: 'session', session: carriedEntry });
  await Promise.resolve();
  assert.ok(pendingPages.has('1:1:today'));
  assert.ok(pendingPages.has('1:1:month'), 'drawer for Month-carried session must fetch month period');
  assert.equal(detailCalls.length, 0);

  pendingPages.get('1:1:today')({ detailsAvailable: true, period: { sessions: {} } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(detailCalls.length, 0, 'completing Today page must not release Month-carried local transcript IPC');

  const resolvedMonthWithCollision = await resolveSyncedSessionPeriod(
    'month',
    devicesWithCollision,
    statsBothOmitted.fixedRangeRevisions,
    {
      read: async (deviceId) => (deviceId === 'linux-remote'
        ? { sessions: { 'codex:carried': { client: 'codex', sessionId: 'carried', title: 'Carried Session', totalTokens: 500, status: 'running', lastUsedAt: nowIso } } }
        : { sessions: {} })
    }
  );
  assert.equal(resolvedMonthWithCollision.period.sessions['codex:carried'].sourceDevice?.ambiguous, true);
  pendingPages.get('1:1:month')(resolvedMonthWithCollision);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(detailCalls.length, 0, 'ambiguous Month resolution must keep local transcript IPC blocked');
  pendingPages.clear();

  // 2. Only month has omissions: Today drawer fetches Month and opens transcript once Month confirms local ownership
  statsHandler({
    event: 'stats',
    data: {
      mode: 'sync',
      stats: {
        ...statsBothOmitted,
        snapshot: { id: 2, source: 1 },
        sessionDetailsOmitted: { today: 0, month: 1 },
        fixedRangeRevisions: { 'mac-local': 'r-mac', 'linux-remote': 'r-linux-2' }
      }
    }
  });
  context.openDrawer({ kind: 'session', session: carriedEntry });
  await Promise.resolve();
  assert.ok(pendingPages.has('1:2:month'), 'month-only omission must still trigger month page fetch from Today drawer');
  assert.equal(detailCalls.length, 0);
  pendingPages.get('1:2:month')({
    detailsAvailable: true,
    period: {
      sessions: {
        'codex:carried': {
          client: 'codex',
          sessionId: 'carried',
          title: 'Carried Session',
          totalTokens: 500,
          sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
        }
      }
    }
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(detailCalls.length, 1);
  assert.equal(detailCalls[0].sessionId, 'carried');
  pendingPages.clear();

  // 3. Hub A deferred drawer must not be resolved by Hub B's page for the same session key
  statsHandler({
    event: 'stats',
    data: {
      mode: 'sync',
      stats: {
        localDeviceId: 'mac-local',
        snapshot: { id: 3, source: 1 },
        sessionDetailsOmitted: { today: 1 },
        fixedRangeRevisions: { 'linux-remote': 'rev-a' },
        periods: {
          today: {
            totalTokens: 100,
            sessions: {
              'codex:same-key': {
                client: 'codex',
                sessionId: 'same-key',
                title: 'Hub A Title',
                totalTokens: 100,
                sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
              }
            }
          }
        }
      }
    }
  });
  context.openDrawer({
    kind: 'session',
    session: {
      client: 'codex',
      sessionId: 'same-key',
      key: 'codex:same-key',
      title: 'Hub A Title',
      totalTokens: 100,
      sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
    }
  });
  await Promise.resolve();
  assert.ok(pendingPages.has('1:3:today'));
  assert.equal(drawerTitle.textContent, 'Hub A Title');

  statsHandler({
    event: 'stats',
    data: {
      mode: 'sync',
      stats: {
        localDeviceId: 'mac-local',
        snapshot: { id: 1, source: 2 },
        sessionDetailsOmitted: { today: 1 },
        fixedRangeRevisions: { 'linux-remote': 'rev-b' },
        periods: {
          today: {
            totalTokens: 200,
            sessions: {
              'codex:same-key': {
                client: 'codex',
                sessionId: 'same-key',
                title: 'Hub B Title',
                totalTokens: 200,
                sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
              }
            }
          }
        }
      }
    }
  });
  await Promise.resolve();
  assert.ok(pendingPages.has('2:1:today'));
  pendingPages.get('2:1:today')({
    detailsAvailable: true,
    period: {
      sessions: {
        'codex:same-key': {
          client: 'codex',
          sessionId: 'same-key',
          title: 'Hub B Title',
          totalTokens: 200,
          sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
        }
      }
    }
  });
  pendingPages.get('1:3:today')({
    detailsAvailable: true,
    period: {
      sessions: {
        'codex:same-key': {
          client: 'codex',
          sessionId: 'same-key',
          title: 'Hub A Title',
          totalTokens: 100,
          sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
        }
      }
    }
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(detailCalls.length, 1, 'Hub B page completion must never trigger local transcript IPC for stale Hub A drawer');
  pendingPages.clear();

  // 4. Month rollover drops expired device from resolved page (session absent -> stays blocked on completion AND cached reopen)
  const callsBeforeRollover = detailCalls.length;
  const rolloverMonthKey = '2026-10-01';
  const expiredMonthDevices = [
    {
      deviceId: 'mac-local',
      displayName: 'MacBook',
      platform: 'darwin',
      periodWindows: { month: { key: '2026-10', endsAt: '2026-11-01T00:00:00.000Z' }, today: { key: rolloverMonthKey } },
      sessionDetailsOmitted: { month: 1 },
      periods: {
        month: {
          totalTokens: 500,
          sessions: {
            'codex:rolled': {
              client: 'codex',
              sessionId: 'rolled',
              title: 'Rolled Month Session',
              totalTokens: 500,
              status: 'running',
              lastUsedAt: nowIso,
              sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
            }
          }
        }
      }
    }
  ];
  statsHandler({
    event: 'stats',
    data: {
      mode: 'sync',
      stats: {
        localDeviceId: 'mac-local',
        snapshot: { id: 10, source: 3 },
        devices: expiredMonthDevices,
        sessionDetailsOmitted: { today: 0, month: 1 },
        fixedRangeRevisions: { 'mac-local': 'rev-roll' },
        periods: {
          today: { totalTokens: 0, sessions: {} },
          month: expiredMonthDevices[0].periods.month
        }
      }
    }
  });
  const rolledEntry = {
    client: 'codex',
    sessionId: 'rolled',
    key: 'codex:rolled',
    title: 'Rolled Month Session',
    totalTokens: 500,
    resumedFromPriorPeriod: true,
    sourcePeriodKey: 'month',
    sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
  };
  context.openDrawer({ kind: 'session', session: rolledEntry });
  await Promise.resolve();
  assert.ok(pendingPages.has('3:10:month'));
  const resolvedRolloverMonth = await resolveSyncedSessionPeriod(
    'month',
    expiredMonthDevices,
    { 'mac-local': 'rev-roll' },
    { now: Date.parse('2026-11-02T12:00:00.000Z'), read: async () => ({ sessions: {} }) }
  );
  assert.equal(resolvedRolloverMonth.detailsAvailable, true);
  assert.equal(resolvedRolloverMonth.period.sessions['codex:rolled'], undefined);
  pendingPages.get('3:10:month')(resolvedRolloverMonth);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(detailCalls.length, callsBeforeRollover, 'rollover page lacking session must not read local transcript via stale inline owner');
  // Reopen the same stale entry while Month page is cached: must still deny local transcript IPC and clear stale device name
  context.openDrawer({ kind: 'session', session: rolledEntry });
  await Promise.resolve();
  assert.equal(detailCalls.length, callsBeforeRollover, 'reopening stale entry with cached page lacking session must not read local transcript');
  assert.doesNotMatch(drawerSubtitle.textContent, /MacBook/, 'reopening stale entry with cached page lacking session must clear stale device name');
  pendingPages.clear();

  // 5. Same-Hub newer snapshot push refreshes pending Month drawer without reopening
  statsHandler({
    event: 'stats',
    data: {
      mode: 'sync',
      stats: {
        ...statsBothOmitted,
        snapshot: { id: 20, source: 3 },
        sessionDetailsOmitted: { today: 1, month: 1 },
        fixedRangeRevisions: { 'mac-local': 'r-mac-20', 'linux-remote': 'r-linux-20' }
      }
    }
  });
  context.openDrawer({ kind: 'session', session: carriedEntry });
  await Promise.resolve();
  assert.ok(pendingPages.has('3:20:today'));
  assert.ok(pendingPages.has('3:20:month'));

  statsHandler({
    event: 'stats',
    data: {
      mode: 'sync',
      stats: {
        ...statsBothOmitted,
        snapshot: { id: 21, source: 3 },
        sessionDetailsOmitted: { today: 1, month: 1 },
        fixedRangeRevisions: { 'mac-local': 'r-mac-21', 'linux-remote': 'r-linux-21' }
      }
    }
  });
  await Promise.resolve();
  assert.ok(pendingPages.has('3:21:today'));
  assert.ok(pendingPages.has('3:21:month'), 'same-Hub push must re-request supplying Month page for open pending drawer');

  pendingPages.get('3:20:month')({ detailsAvailable: true, period: { sessions: {} } });
  pendingPages.get('3:21:month')({
    detailsAvailable: true,
    period: {
      sessions: {
        'codex:carried': {
          client: 'codex',
          sessionId: 'carried',
          title: 'Carried Session',
          totalTokens: 500,
          sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
        }
      }
    }
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(detailCalls.length, callsBeforeRollover + 1);
  assert.equal(detailCalls.at(-1)?.sessionId, 'carried');
  pendingPages.clear();

  // 6. Newer same-Hub snapshot clears Month omissions and confirms local owner directly
  const callsBeforeCompleteSnapshot = detailCalls.length;
  statsHandler({
    event: 'stats',
    data: {
      mode: 'sync',
      stats: {
        ...statsBothOmitted,
        snapshot: { id: 30, source: 3 },
        sessionDetailsOmitted: { today: 0, month: 1 },
        fixedRangeRevisions: { 'mac-local': 'r-mac-30', 'linux-remote': 'r-linux-30' }
      }
    }
  });
  context.openDrawer({ kind: 'session', session: carriedEntry });
  await Promise.resolve();
  assert.ok(pendingPages.has('3:30:month'));
  assert.equal(context.state.drawer.pendingOwnershipDetail, true);
  assert.equal(detailCalls.length, callsBeforeCompleteSnapshot);

  statsHandler({
    event: 'stats',
    data: {
      mode: 'sync',
      stats: {
        ...statsBothOmitted,
        snapshot: { id: 31, source: 3 },
        sessionDetailsOmitted: { today: 0, month: 0 },
        fixedRangeRevisions: { 'mac-local': 'r-mac-31', 'linux-remote': 'r-linux-31' },
        periods: {
          today: { totalTokens: 0, sessions: {} },
          month: {
            totalTokens: 500,
            sessions: {
              'codex:carried': {
                client: 'codex',
                sessionId: 'carried',
                title: 'Carried Session',
                totalTokens: 500,
                sourceDevice: { deviceId: 'mac-local', name: 'MacBook' }
              }
            }
          }
        }
      }
    }
  });
  await Promise.resolve();
  assert.equal(pendingPages.has('3:31:month'), false, 'complete Month snapshot should not request omitted page');
  assert.equal(context.state.drawer.pendingOwnershipDetail, false);
  assert.equal(detailCalls.length, callsBeforeCompleteSnapshot + 1, 'complete Month snapshot confirming local owner must resolve pending drawer');
  assert.equal(detailCalls.at(-1)?.sessionId, 'carried');
  pendingPages.get('3:30:month')({ detailsAvailable: true, period: { sessions: {} } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(detailCalls.length, callsBeforeCompleteSnapshot + 1);
  pendingPages.clear();

  // 7. Newer same-Hub snapshot clears Month omissions, but session is absent or ambiguous -> clears pending without local transcript IPC
  statsHandler({
    event: 'stats',
    data: {
      mode: 'sync',
      stats: {
        ...statsBothOmitted,
        snapshot: { id: 32, source: 3 },
        sessionDetailsOmitted: { today: 0, month: 1 },
        fixedRangeRevisions: { 'mac-local': 'r-mac-32', 'linux-remote': 'r-linux-32' }
      }
    }
  });
  context.openDrawer({ kind: 'session', session: carriedEntry });
  await Promise.resolve();
  assert.equal(context.state.drawer.pendingOwnershipDetail, true);

  statsHandler({
    event: 'stats',
    data: {
      mode: 'sync',
      stats: {
        ...statsBothOmitted,
        snapshot: { id: 33, source: 3 },
        sessionDetailsOmitted: { today: 0, month: 0 },
        fixedRangeRevisions: { 'mac-local': 'r-mac-33', 'linux-remote': 'r-linux-33' },
        periods: {
          today: { totalTokens: 0, sessions: {} },
          month: { totalTokens: 0, sessions: {} }
        }
      }
    }
  });
  await Promise.resolve();
  assert.equal(context.state.drawer.pendingOwnershipDetail, false);
  assert.equal(detailCalls.length, callsBeforeCompleteSnapshot + 1, 'complete Month snapshot without explicit local owner must clear pending without reading local transcript');
  assert.doesNotMatch(drawerSubtitle.textContent, /MacBook/, 'complete Month snapshot dropping session must clear stale device name');

  // Case 7B: Complete Month snapshot projected via projectSessionDeviceStats on multi-device collision leaves sourceDevice unset and must clear stale device name
  const { projectSessionDeviceStats } = require('../../src/electron/sessionDeviceSources');
  statsHandler({
    event: 'stats',
    data: {
      mode: 'sync',
      stats: {
        ...statsBothOmitted,
        snapshot: { id: 34, source: 3 },
        fixedRangeRevisions: { 'mac-local': 'r-mac-34', 'linux-remote': 'r-linux-34' }
      }
    }
  });
  await Promise.resolve();
  context.openDrawer({ kind: 'session', session: carriedEntry });
  await Promise.resolve();
  assert.equal(context.state.drawer.pendingOwnershipDetail, true);
  assert.match(drawerSubtitle.textContent, /MacBook/, 'pending drawer initially retains row device name before complete snapshot clears ownership');

  const collidedDevices = [
    {
      deviceId: 'mac-local',
      displayName: 'MacBook',
      platform: 'darwin',
      periods: {
        today: { totalTokens: 0, sessions: {} },
        month: {
          totalTokens: 1200,
          sessions: {
            'codex:carried': { client: 'codex', sessionId: 'carried', title: 'Carried Session', totalTokens: 1200, lastUsedAt: nowIso }
          }
        }
      }
    },
    {
      deviceId: 'linux-remote',
      displayName: 'Linux Box',
      platform: 'linux',
      periods: {
        today: { totalTokens: 0, sessions: {} },
        month: {
          totalTokens: 900,
          sessions: {
            'codex:carried': { client: 'codex', sessionId: 'carried', title: 'Carried Session', totalTokens: 900, lastUsedAt: nowIso }
          }
        }
      }
    }
  ];
  const projectedCollisionStats = projectSessionDeviceStats({
    ...statsBothOmitted,
    snapshot: { id: 35, source: 3 },
    sessionDetailsOmitted: { today: 0, month: 0 },
    fixedRangeRevisions: { 'mac-local': 'r-mac-35', 'linux-remote': 'r-linux-35' },
    devices: collidedDevices,
    periods: {
      today: { totalTokens: 0, sessions: {} },
      month: {
        totalTokens: 2100,
        sessions: {
          'codex:carried': { client: 'codex', sessionId: 'carried', title: 'Carried Session', totalTokens: 2100, lastUsedAt: nowIso }
        }
      }
    }
  }, 'mac-local');
  const collidedRow = projectedCollisionStats.periods.month.sessions['codex:carried'];
  assert.ok(collidedRow, 'projected collision snapshot must retain the codex:carried row');
  assert.equal(collidedRow.sourceDevice, undefined, 'collision projection leaves sourceDevice unset');
  statsHandler({
    event: 'stats',
    data: {
      mode: 'sync',
      stats: projectedCollisionStats
    }
  });
  await Promise.resolve();
  assert.equal(context.state.drawer.pendingOwnershipDetail, false);
  assert.equal(detailCalls.length, callsBeforeCompleteSnapshot + 1, 'complete Month collision snapshot must clear pending without reading local transcript');
  assert.doesNotMatch(drawerSubtitle.textContent, /MacBook/, 'complete Month collision snapshot without confirmed owner must clear stale device name');

  // Case 8: Same-Hub collision while a confirmed-local Month drawer is open cancels delayed anatomy and clears already-rendered anatomy
  let resolveDelayedDetail = null;
  context.window.tokenMonitor.getSessionDetail = (args) => {
    detailCalls.push(args);
    if (resolveDelayedDetail === 'defer') {
      return new Promise((resolve) => { resolveDelayedDetail = resolve; });
    }
    return Promise.resolve({
      found: true,
      totals: { totalTokens: 100, costUsd: 0.1 },
      exchanges: [{ tokens: { input: 20, cacheRead: 60, cacheWrite: 0, output: 20, total: 100 } }]
    });
  };
  const singleLocalMonthStats = projectSessionDeviceStats({
    localDeviceId: 'mac-local',
    snapshot: { id: 40, source: 3 },
    sessionDetailsOmitted: { today: 0, month: 0 },
    devices: [
      {
        deviceId: 'mac-local',
        displayName: 'MacBook',
        platform: 'darwin',
        periods: {
          today: { totalTokens: 0, sessions: {} },
          month: {
            totalTokens: 1200,
            sessions: {
              'codex:local-month': { client: 'codex', sessionId: 'local-month', title: 'Local Month', totalTokens: 1200, lastUsedAt: nowIso }
            }
          }
        }
      },
      {
        deviceId: 'linux-remote',
        displayName: 'Linux Box',
        platform: 'linux',
        periods: { today: { totalTokens: 0, sessions: {} }, month: { totalTokens: 0, sessions: {} } }
      }
    ],
    periods: {
      today: { totalTokens: 0, sessions: {} },
      month: {
        totalTokens: 1200,
        sessions: {
          'codex:local-month': { client: 'codex', sessionId: 'local-month', title: 'Local Month', totalTokens: 1200, lastUsedAt: nowIso }
        }
      }
    }
  }, 'mac-local');
  assert.equal(singleLocalMonthStats.periods.month.sessions['codex:local-month']?.sourceDevice?.deviceId, 'mac-local');
  statsHandler({ event: 'stats', data: { mode: 'sync', stats: singleLocalMonthStats } });
  context.state.periodKey = 'month';
  const monthSessionList = dashboardModel.buildSessionList({
    stats: context.state.stats,
    periodKey: 'month',
    settings: context.state.settings,
    statsMode: context.state.statsMode,
    nowMs: Date.parse(nowIso)
  });
  const localMonthEntry = monthSessionList.find((s) => s.key === 'codex:local-month');
  assert.ok(localMonthEntry);

  resolveDelayedDetail = 'defer';
  context.openDrawer({ kind: 'session', session: localMonthEntry });
  await Promise.resolve();
  assert.match(drawerSubtitle.textContent, /MacBook/);
  assert.equal(typeof resolveDelayedDetail, 'function');

  const collidedMonthStats = projectSessionDeviceStats({
    ...singleLocalMonthStats,
    snapshot: { id: 41, source: 3 },
    devices: [
      singleLocalMonthStats.devices[0],
      {
        deviceId: 'linux-remote',
        displayName: 'Linux Box',
        platform: 'linux',
        periods: {
          today: { totalTokens: 0, sessions: {} },
          month: {
            totalTokens: 900,
            sessions: {
              'codex:local-month': { client: 'codex', sessionId: 'local-month', title: 'Local Month', totalTokens: 900, lastUsedAt: nowIso }
            }
          }
        }
      }
    ],
    periods: {
      today: { totalTokens: 0, sessions: {} },
      month: {
        totalTokens: 2100,
        sessions: {
          'codex:local-month': { client: 'codex', sessionId: 'local-month', title: 'Local Month', totalTokens: 2100, lastUsedAt: nowIso }
        }
      }
    }
  }, 'mac-local');
  assert.ok(collidedMonthStats.periods.month.sessions['codex:local-month']);
  assert.equal(collidedMonthStats.periods.month.sessions['codex:local-month'].sourceDevice, undefined);
  statsHandler({ event: 'stats', data: { mode: 'sync', stats: collidedMonthStats } });
  await Promise.resolve();
  assert.doesNotMatch(drawerSubtitle.textContent, /MacBook/, 'same-Hub collision must clear subtitle on an open confirmed-local drawer');

  resolveDelayedDetail({
    found: true,
    totals: { totalTokens: 100, costUsd: 0.1 },
    exchanges: [{ tokens: { input: 20, cacheRead: 60, cacheWrite: 0, output: 20, total: 100 } }]
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.doesNotMatch(drawerBody.innerHTML, /dash-drawer-section-title/, 'delayed local transcript response must be discarded after collision');

  // Reopen with immediate anatomy rendering, then confirm collision clears already-rendered anatomy too
  statsHandler({ event: 'stats', data: { mode: 'sync', stats: { ...singleLocalMonthStats, snapshot: { id: 42, source: 3 } } } });
  context.openDrawer({ kind: 'session', session: localMonthEntry });
  await new Promise((r) => setTimeout(r, 0));
  assert.match(drawerSubtitle.textContent, /MacBook/);
  assert.match(drawerBody.innerHTML, /dash-drawer-section-title/, 'local anatomy renders while confirmed local');

  statsHandler({ event: 'stats', data: { mode: 'sync', stats: { ...collidedMonthStats, snapshot: { id: 43, source: 3 } } } });
  await Promise.resolve();
  assert.doesNotMatch(drawerSubtitle.textContent, /MacBook/);
  assert.doesNotMatch(drawerBody.innerHTML, /dash-drawer-section-title/, 'same-Hub collision must strip already-rendered local anatomy');
  // All Time still renders its retained summaries, but a new snapshot fences detail until
  // its own ownership arrives. An ambiguous result must never release the read.
  context.state.periodKey = 'allTime';
  const local = { client: 'codex', sessionId: 'total', title: 'Shared', totalTokens: 10, lastUsedAt: new Date().toISOString(),
    sourceDevice: { deviceId: 'mac-local', name: 'Mac' } };
  const pendingTotals = new Map();
  context.window.tokenMonitor.getAllTimeSessions = id => new Promise(resolve => pendingTotals.set(id, resolve));
  const totalStats = id => ({
    localDeviceId: 'mac-local', snapshot: { id, source: 100 }, mode: 'sync',
    periods: { allTime: { totalTokens: 10 } }
  });
  const callsBeforeAllTime = detailCalls.length;
  context.applyIncomingStats(totalStats(100));
  await Promise.resolve();
  pendingTotals.get(100)({ 'codex:total': local });
  await new Promise(setImmediate);
  context.openDrawer({ kind: 'session', session: { ...local, key: 'codex:total', sourcePeriodKey: 'allTime' } });
  assert.equal(detailCalls.length, callsBeforeAllTime + 1, 'current ownership can authorize a local read');
  context.applyIncomingStats(totalStats(101));
  assert.equal(context.state.drawer.detailRequested, false, 'new stats revoke the previous transcript read');
  assert.equal(context.state.stats.periods.allTime.sessions['codex:total'].sourceDevice.deviceId, 'mac-local');
  context.openDrawer({ kind: 'session', session: { ...local, key: 'codex:total', sourcePeriodKey: 'allTime' } });
  assert.equal(detailCalls.length, callsBeforeAllTime + 1);
  await Promise.resolve();
  pendingTotals.get(101)({ 'codex:total': { ...local, sourceDevice: { ambiguous: true } } });
  await new Promise(setImmediate);
  assert.equal(detailCalls.length, callsBeforeAllTime + 1);
  assert.equal(context.state.drawer.session.sourceDevice, null);

});

test('dashboard groups subagent hierarchies and review groups in Work Panel, Topology, and interactive group drawer', () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const dashboardModel = require('../../src/electron/renderer/dashboardModel');
  const charts = require('../../src/electron/renderer/usageCharts');
  const nowIso = new Date().toISOString();

  const detailCalls = [];
  const drawerTitle = { textContent: '' };
  const drawerSubtitle = { textContent: '' };
  const drawerBody = {
    innerHTML: '',
    listeners: new Map(),
    addEventListener(type, fn) { this.listeners.set(type, fn); },
    querySelectorAll: () => []
  };
  const workPanel = { innerHTML: '', querySelectorAll: () => [], contains: () => false };
  const topology = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null, contains: () => false };

  const context = {
    state: {
      periodKey: 'today',
      selectedDeviceId: 'all',
      workMode: 'sessions',
      stageView: 'flow',
      locale: 'en',
      motion: 'none',
      settings: { deviceId: 'mac-1', sessionTitlesEnabled: true },
      stats: {
        localDeviceId: 'mac-1',
        devices: [{ deviceId: 'mac-1', displayName: 'MacBook', periods: { today: { totalTokens: 5000 } } }],
        periods: {
          today: {
            totalTokens: 5000,
            costUsd: 2.5,
            sessions: {
              'claude:parent-s': {
                client: 'claude',
                sessionId: 'parent-s',
                title: 'Main Task',
                projectLabel: 'Repo',
                latestModel: 'claude-sonnet-4-5',
                models: { 'claude-sonnet-4-5': 3000 },
                totalTokens: 3000,
                costUsd: 1.5,
                lastUsedAt: nowIso,
                sourceDevice: { deviceId: 'mac-1', name: 'MacBook' }
              },
              'claude:child-s': {
                client: 'claude',
                sessionId: 'child-s',
                title: 'Child Helper',
                projectLabel: 'Repo',
                parentClient: 'claude',
                parentSessionId: 'parent-s',
                latestModel: 'claude-haiku-4-5',
                models: { 'claude-haiku-4-5': 1200 },
                totalTokens: 1200,
                costUsd: 0.6,
                lastUsedAt: nowIso,
                sourceDevice: { deviceId: 'mac-1', name: 'MacBook' }
              },
              'codex:bg-1': {
                client: 'codex',
                sessionId: 'bg-1',
                sessionKind: 'background-review',
                latestModel: 'gpt-6.2-sol',
                totalTokens: 800,
                costUsd: 0.4,
                lastUsedAt: nowIso,
                sourceDevice: { deviceId: 'mac-1', name: 'MacBook' }
              }
            }
          }
        }
      },
      drawer: null
    },
    els: {
      drawer: { showPopover() {}, matches() { return false; } },
      drawerScrim: { classList: { remove() {}, add() {} } },
      drawerIcon: { className: '', style: {} },
      drawerTitle,
      drawerSubtitle,
      drawerBody,
      workTitle: { textContent: '' },
      workSummary: { textContent: '' },
      workPanel,
      topology,
      heatmap: { classList: { add() {}, remove() {} } },
      skylineStage: { classList: { add() {}, remove() {} } },
      heatFooter: { classList: { add() {}, remove() {} } },
      heatmapMeta: { textContent: '' },
      tooltip: { matches: () => false, classList: { contains: () => true } },
      body: { classList: { toggle() {} } }
    },
    modelApi: dashboardModel,
    charts,
    sessionLiveApi: require('../../src/shared/sessionLive'),
    fixedPeriodRangesApi: require('../../src/electron/renderer/fixedPeriodRanges'),
    sessionTitleDisplayApi: require('../../src/electron/sessionTitleDisplay'),
    sessionActivityProjectionApi: null,
    allTimeSessionsApi: null,
    tokenRateApi: null,
    deviceRateTracker: { getSample() { return null; }, reset() {}, observe() {} },
    rateHistory: { getSamples() { return []; }, reset() {}, observe() {} },
    deviceRateTrackers: new Map(),
    rateExpiryTimer: null,
    dashboardReady: true,
    lastWorkStructureSig: '',
    patchDashboardMarkup(element, html) { element.innerHTML = html; return true; },
    topologyResizeObserver: null,
    topologyLayoutFrame: 0,
    heatmapMotionGeneration: 0,
    drawerRequestToken: 0,
    document: { hidden: false },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    escapeHtml: (s) => String(s ?? ''),
    displayColor: (c) => String(c || ''),
    formatCompact: (v) => String(v),
    formatCost: (v) => `$${v}`,
    applySwatchColors() {},
    applyAppearance() {},
    applyTranslations() {},
    populatePeriodSelect() {},
    populateRangeSelect() {},
    activateSegButton() {},
    hideTooltip() {},
    clearTopologyFocus() {},
    renderHeatLegend() {},
    captureListSnapshot: () => null,
    animateListSnapshot() {},
    withPreservedFocus(_el, _sel, _key, fn) { fn(); },
    prefersReducedMotion: () => true,
    handleKeyboardClick() {},
    closeDrawer() {},
    render() {},
    i18n: { resolveLocale: () => 'en' },
    compactTokenApi: { normalizeCompactTokenUnits: (v) => v },
    navigator: { languages: ['en'] },
    reducedMotionMedia: null,
    console: { log() {} },
    setTimeout,
    clearTimeout,
    drawerStatGrid: () => '<div class="grid"></div>',
    t: (k, vars = {}) => {
      if (k === 'sessions.subagentCount') return `${vars.count} subagents`;
      if (k === 'sessions.backgroundReviewCount') return `${vars.count} background runs`;
      if (k === 'sessions.backgroundReviews') return 'Codex Auto Review';
      if (k === 'sessions.subagent') return 'Subagent';
      return k;
    },
    window: {
      tokenMonitor: {
        getSessionDetail(args) { detailCalls.push(args); return Promise.resolve({ found: false }); },
        onSettingsPush(fn) { context.__settingsHandler = fn; }
      }
    }
  };

  const slice = js.slice(js.indexOf('function sessionGroupBadgeLabel('), js.indexOf('\nfunction dismissSkylineHint('))
    + '\n'
    + js.slice(js.indexOf('function closeDrawer('), js.indexOf('\nfunction renderNow('))
    + '\n'
    + js.slice(js.indexOf('window.tokenMonitor.onSettingsPush?.'), js.indexOf('\nreducedMotionMedia?.addEventListener'))
    + '\n'
    + js.slice(js.indexOf('els.drawerBody?.addEventListener?.'), js.indexOf("\nwindow.addEventListener('keydown'"));
  vm.runInNewContext(slice, context);

  const overview = dashboardModel.buildScopedOverview({
    stats: context.state.stats,
    periodKey: 'today',
    settings: context.state.settings,
    sessionLabels: {
      subagent: 'Subagent',
      subagentCount: (c) => `${c} subagents`,
      backgroundReviews: 'Codex Auto Review',
      backgroundReviewCount: (c) => `${c} background runs`,
      grokBot: 'Grok Bot',
      grokBotCount: (c) => `${c} activity records`
    }
  });
  context.state.overview = overview;
  context.renderWorkPanel(overview);
  assert.match(workPanel.innerHTML, /1 subagents/);
  assert.match(workPanel.innerHTML, /1 background runs/);
  assert.match(workPanel.innerHTML, /Main Task/);
  assert.doesNotMatch(workPanel.innerHTML, /Child Helper/, 'child session stays folded under parent row');

  context.renderTopology(overview);
  assert.match(topology.innerHTML, /1 subagents/);
  assert.match(topology.innerHTML, /1 background runs/);

  const groupedParent = overview.sessions.find((s) => s.subagentGroup);
  context.openDrawer({ kind: 'session', session: groupedParent });
  assert.equal(detailCalls.length, 0, 'opening group drawer must not invoke local transcript IPC on wrapper');
  assert.match(drawerSubtitle.textContent, /1 subagents/);
  assert.match(drawerBody.innerHTML, /Child Helper/);

  // Redacting titles immediately scrubs group & member titles in the open drawer
  context.__settingsHandler({ sessionTitlesEnabled: false });
  assert.doesNotMatch(drawerBody.innerHTML, /Child Helper/);
  context.__settingsHandler({ sessionTitlesEnabled: true });
  assert.match(drawerBody.innerHTML, /Child Helper/);

  // Clicking member 1 opens individual child session with Back button; clicking Back returns to group
  const drawerClick = drawerBody.listeners.get('click');
  const childIdx = groupedParent.groupRows.findIndex((r) => r.sessionId === 'child-s');
  drawerClick({ target: { closest: (sel) => (sel.includes('data-drawer-member-idx') ? { dataset: { drawerMemberIdx: String(childIdx) } } : null) } });
  assert.equal(detailCalls.length, 1);
  assert.equal(detailCalls[0].sessionId, 'child-s');
  assert.match(drawerBody.innerHTML, /data-drawer-back="true"/);

  // Toggling sessionTitlesEnabled: false while viewing drilled-in member redacts both returnToGroup Back button and returned group drawer
  context.__settingsHandler({ sessionTitlesEnabled: false });
  assert.doesNotMatch(drawerTitle.textContent, /Child Helper/);
  assert.doesNotMatch(drawerBody.innerHTML, /Main Task/);
  drawerClick({ target: { closest: (sel) => (sel.includes('dash-drawer-back') ? {} : null) } });
  assert.doesNotMatch(drawerBody.innerHTML, /Child Helper/);
  assert.doesNotMatch(drawerTitle.textContent, /Main Task/);

  context.__settingsHandler({ sessionTitlesEnabled: true });
  assert.match(drawerBody.innerHTML, /Child Helper/);
  assert.equal(detailCalls.length, 1);
});

test('dashboard Trends and device selector recover to All Devices when selected device disappears from fleet', () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const dashboardModel = require('../../src/electron/renderer/dashboardModel');
  const charts = require('../../src/electron/renderer/usageCharts');

  const today = new Date().toISOString().slice(0, 10);
  const mkStats = (ids) => ({
    localDeviceId: ids[0],
    devices: ids.map((id, i) => ({
      deviceId: id,
      displayName: `Machine ${id}`,
      platform: i === 0 ? 'darwin' : 'linux',
      periods: { today: { totalTokens: 500 + i * 100, costUsd: 0.25 } }
    })),
    periods: { today: { totalTokens: 1100, costUsd: 0.5, sessions: {} } }
  });
  const mkHistory = (ids) => ({
    daily: [{ date: today, tokens: 900, cost: 0.45, perClient: { codex: { tokens: 900 } } }],
    deviceHistories: ids.map((id, i) => ({
      deviceId: id,
      history: { daily: [{ date: today, tokens: 300 + i * 100, cost: 0.15, perClient: { codex: { tokens: 300 + i * 100 } } }] }
    }))
  });

  const makeEl = () => ({
    cloneNode: () => ({ set innerHTML(value) { this.childNodes = [value]; } }),
    innerHTML: '',
    textContent: '',
    classList: { toggle() {}, add() {}, remove() {} },
    style: { setProperty() {} },
    setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false
  });
  const deviceMenu = makeEl();
  const deviceTrigger = makeEl();
  const chartEl = makeEl();
  const dailyLedgerEl = makeEl();

  const context = {
    state: {
      tab: 'trends',
      periodKey: 'today',
      selectedDeviceId: 'dev-a',
      deviceMenuOpen: true,
      range: '7',
      stackBy: 'client',
      mode: 'bars',
      trendMetric: 'tokens',
      stageView: 'flow',
      heatmapView: '3d',
      heatmapMetric: 'cost',
      skylineColorMode: 'heat',
      rateMode: 'speed',
      breakdownMode: 'both',
      workMode: 'sessions',
      soloKey: null,
      locale: 'en',
      currency: 'USD',
      settings: {},
      stats: mkStats(['dev-a', 'dev-b']),
      history: mkHistory(['dev-a', 'dev-b']),
      chartModel: null,
      chartKind: 'bars',
      motion: 'none',
      statsMode: 'sync',
      overview: null,
      drawer: null
    },
    els: {
      deviceScope: makeEl(),
      deviceTrigger,
      deviceMenu,
      empty: makeEl(),
      trendsPane: makeEl(),
      activityPane: makeEl(),
      heatmap: makeEl(),
      chart: chartEl,
      legend: makeEl(),
      dailyLedger: dailyLedgerEl,
      ledgerMeta: makeEl(),
      modeBtns: [],
      stackBtns: [],
      trendMetricBtns: [],
      stageViewBtns: [],
      heatmapMetricBtns: [],
      skylineColorBtns: [],
      breakdownModeBtns: [],
      workModeBtns: [],
      tooltip: { matches: () => false, classList: { contains: () => true } }
    },
    modelApi: dashboardModel,
    charts,
    deviceRateTracker: { getSample: () => null },
    rateHistory: { getSamples: () => [] },
    deviceRateTrackers: new Map(),
    activeHover: null,
    heatmapMotionGeneration: 0,
    lastRenderedTab: 'trends',
    currentLiveRatesByDevice: () => ({}),
    isSyncedSessionPagesLoaded: () => false,
    render: () => context.renderNow(),
    todayKey: () => today,
    shortDate: (d) => d,
    escapeHtml: (s) => String(s ?? ''),
    displayColor: (c) => String(c || '#6ab4f0'),
    colorFor: () => '#6ab4f0',
    formatCompact: String,
    formatCost: (v) => `$${v}`,
    formatCostCompact: (v) => `$${v}`,
    applySwatchColors() {},
    setDeviceMenuOpen() {},
    hideTooltip() {},
    openDrawer() {},
    axisEvery: () => 1,
    chartSize: () => ({ w: 600, h: 240 }),
    captureGeometry: () => null,
    animateChartGeometry() {},
    withPreservedFocus(_el, _sel, _key, fn) { fn(); },
    rendererDom: { reconcileChildren(el, children) { el.innerHTML = children[0]; } },
    syncAllSegIndicators() {},
    prefersReducedMotion: () => true,
    refreshActiveHover() {},
    scheduleRateExpiry() {},
    t: (k, vars = {}) => {
      if (k === 'dashboard.fleet.all') return 'All Devices';
      if (k === 'dashboard.fleet.machineCount') return `${vars.count} devices`;
      return k;
    },
    document: { hidden: false, querySelector: () => null }
  };

  const snippet = js.slice(js.indexOf('function renderLegend('), js.indexOf('\nfunction renderBreakdown('))
    + '\n'
    + js.slice(js.indexOf('function renderDeviceSelector('), js.indexOf('\nfunction animateMetricText('))
    + '\n'
    + js.slice(js.indexOf('function renderNow('), js.indexOf('\nconst dashboardRenderScheduler'));
  vm.runInNewContext(snippet, context);

  context.renderNow();
  assert.match(deviceTrigger.innerHTML, /Machine dev-a/);
  assert.match(chartEl.innerHTML, /<svg/);

  // Replace fleet with two entirely different machines so dev-a disappears
  context.state.stats = mkStats(['dev-c', 'dev-d']);
  context.state.history = mkHistory(['dev-c', 'dev-d']);
  context.renderNow();

  assert.equal(context.state.selectedDeviceId, 'all', 'disappeared selected device must reset to All Devices');
  assert.match(deviceTrigger.innerHTML, /All Devices · 2\/2/);
  assert.match(deviceMenu.innerHTML, /is-selected" data-device="all" data-key="all" role="menuitemradio" aria-checked="true"/);
  assert.match(chartEl.innerHTML, /<svg/, 'Trends chart must not go blank when selected device leaves fleet');
  assert.ok(context.state.chartModel && context.state.chartModel.bars.length > 0);
  assert.match(dailyLedgerEl.innerHTML, /900/, 'daily ledger renders aggregate usage');

  // Shrink two-device fleet down to a single surviving selected device (dev-a):
  // Trends chart AND Daily Breakdown must both report the aggregate 900 (not 300 device-only).
  context.state.selectedDeviceId = 'dev-a';
  context.state.stats = mkStats(['dev-a', 'dev-b']);
  context.state.history = mkHistory(['dev-a', 'dev-b']);
  context.renderNow();
  assert.equal(context.state.overview?.dailyLedger?.[0]?.tokens, 300);
  const scopedBar = context.state.chartModel?.bars?.find((b) => b.label === today);
  assert.equal(scopedBar?.total, 300);

  context.state.stats = mkStats(['dev-a']);
  context.state.history = mkHistory(['dev-a']);
  context.renderNow();
  assert.equal(context.state.selectedDeviceId, 'all', 'single-device fleet resets selectedDeviceId to All Devices');
  assert.equal(context.state.overview?.activeMachine, null);
  assert.equal(context.state.overview?.dailyLedger?.[0]?.tokens, 900);
  assert.match(dailyLedgerEl.innerHTML, /900/);
  assert.doesNotMatch(dailyLedgerEl.innerHTML, />300</);
  const aggregateBar = context.state.chartModel?.bars?.find((b) => b.label === today);
  assert.equal(aggregateBar?.total, 900);
});

test('dashboard open group drawer revalidates member ownership on click and preserves redacted Back title across delayed detail responses', async () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const dashboardModel = require('../../src/electron/renderer/dashboardModel');
  const { projectSessionDeviceStats } = require('../../src/electron/sessionDeviceSources');
  const nowIso = new Date().toISOString();

  const detailCalls = [];
  let resolveDelayedDetail = null;
  let settingsHandler = null;
  let statsHandler = null;
  const drawerTitle = { textContent: '' };
  const drawerSubtitle = { textContent: '' };
  const drawerBody = {
    innerHTML: '',
    listeners: new Map(),
    addEventListener(type, fn) { this.listeners.set(type, fn); },
    querySelectorAll: () => []
  };

  const singleLocalGroupStats = projectSessionDeviceStats({
    localDeviceId: 'mac-local',
    snapshot: { id: 50, source: 4 },
    devices: [
      {
        deviceId: 'mac-local',
        displayName: 'MacBook',
        platform: 'darwin',
        periods: {
          today: {
            totalTokens: 2000,
            sessions: {
              'codex:p1': { client: 'codex', sessionId: 'p1', title: 'Main Task', projectLabel: 'Repo', totalTokens: 1200, lastUsedAt: nowIso },
              'codex:c1': { client: 'codex', sessionId: 'c1', title: 'Child Task', projectLabel: 'Repo', parentClient: 'codex', parentSessionId: 'p1', totalTokens: 800, lastUsedAt: nowIso }
            }
          }
        }
      }
    ],
    periods: {
      today: {
        totalTokens: 2000,
        sessions: {
          'codex:p1': { client: 'codex', sessionId: 'p1', title: 'Main Task', projectLabel: 'Repo', totalTokens: 1200, lastUsedAt: nowIso },
          'codex:c1': { client: 'codex', sessionId: 'c1', title: 'Child Task', projectLabel: 'Repo', parentClient: 'codex', parentSessionId: 'p1', totalTokens: 800, lastUsedAt: nowIso }
        }
      }
    }
  }, 'mac-local');

  const context = {
    state: {
      periodKey: 'today',
      selectedDeviceId: 'all',
      history: null,
      stats: singleLocalGroupStats,
      settings: { deviceId: 'mac-local', sessionTitlesEnabled: true, hubMode: 'client', hubUrl: 'https://hub-a' },
      motion: 'none',
      drawer: null,
      locale: 'en',
      statsMode: 'sync'
    },
    els: {
      drawer: { showPopover() {}, matches() { return false; } },
      drawerScrim: { classList: { remove() {}, add() {} } },
      drawerIcon: { className: '', style: {} },
      drawerTitle,
      drawerSubtitle,
      drawerBody,
      tooltip: { classList: { contains() { return true; } } },
      refreshBtn: { classList: { toggle() {} }, setAttribute() {}, removeAttribute() {}, disabled: false },
      body: { classList: { toggle() {} } }
    },
    fixedPeriodRangesApi: require('../../src/electron/renderer/fixedPeriodRanges'),
    modelApi: dashboardModel,
    sessionTitleDisplayApi: require('../../src/electron/sessionTitleDisplay'),
    sessionActivityProjectionApi: null,
    allTimeSessionsApi: null,
    tokenRateApi: null,
    charts: { clientColors: {} },
    deviceRateTracker: { getSample() { return null; }, reset() {}, observe() {} },
    rateHistory: { getSamples() { return []; }, reset() {}, observe() {} },
    deviceRateTrackers: new Map(),
    rateExpiryTimer: null,
    dashboardReady: true,
    document: { hidden: false },
    escapeHtml: (s) => String(s ?? ''),
    displayColor: (c) => String(c || ''),
    formatCompact: String,
    formatCost: String,
    applySwatchColors() {},
    applyAppearance() {},
    handleKeyboardClick() {},
    drawerStatGrid: () => '<div></div>',
    drawerRequestToken: 0,
    applyReduceMotionPreference() {},
    render() {},
    scheduleDashboardRefresh() {},
    i18n: { resolveLocale: () => 'en' },
    compactTokenApi: { normalizeCompactTokenUnits: (v) => v },
    navigator: { languages: ['en'] },
    reducedMotionMedia: null,
    console: { log() {} },
    setTimeout,
    clearTimeout,
    t: (k, vars = {}) => (k === 'sessions.subagentCount' ? `${vars.count} subagents` : k),
    window: {
      tokenMonitor: {
        getSessionDetail(args) {
          detailCalls.push(args);
          return new Promise((r) => { resolveDelayedDetail = r; });
        },
        onSettingsPush(fn) { settingsHandler = fn; },
        onStatsPush(fn) { statsHandler = fn; },
        getDashboardHistory: async () => ({ daily: [] }),
        getStats: async () => context.state.stats
      }
    }
  };

  const slice = js.slice(js.indexOf('function sessionGroupBadgeLabel('), js.indexOf('\nfunction dismissSkylineHint('))
    + '\n'
    + js.slice(js.indexOf('function closeDrawer('), js.indexOf('\nfunction renderNow('))
    + '\n'
    + js.slice(js.indexOf('function observeStatsRates('), js.indexOf('\nasync function boot('))
    + '\n'
    + js.slice(js.indexOf('window.tokenMonitor.onSettingsPush?.'), js.indexOf('\nreducedMotionMedia?.addEventListener'))
    + '\n'
    + js.slice(js.indexOf('els.drawerBody?.addEventListener?.'), js.indexOf("\nwindow.addEventListener('keydown'"));
  vm.runInNewContext(slice, context);

  // Case A: open group drawer with confirmed local child, then push same-Hub collision snapshot;
  // clicking child inside the still-open drawer must NOT read local detail or show MacBook.
  const initialSessions = dashboardModel.buildSessionList({
    stats: context.state.stats,
    periodKey: 'today',
    settings: context.state.settings,
    statsMode: 'sync',
    nowMs: Date.parse(nowIso)
  });
  const groupRow = initialSessions.find((s) => s.subagentGroup);
  assert.ok(groupRow);
  context.openDrawer({ kind: 'session', session: groupRow });

  const collidedGroupStats = projectSessionDeviceStats({
    ...singleLocalGroupStats,
    snapshot: { id: 51, source: 4 },
    devices: [
      singleLocalGroupStats.devices[0],
      {
        deviceId: 'linux-remote',
        displayName: 'Linux Box',
        platform: 'linux',
        periods: {
          today: {
            totalTokens: 800,
            sessions: {
              'codex:c1': { client: 'codex', sessionId: 'c1', title: 'Child Task', projectLabel: 'Repo', totalTokens: 800, lastUsedAt: nowIso }
            }
          }
        }
      }
    ],
    periods: {
      today: {
        totalTokens: 2800,
        sessions: {
          'codex:p1': { client: 'codex', sessionId: 'p1', title: 'Main Task', projectLabel: 'Repo', totalTokens: 1200, lastUsedAt: nowIso },
          'codex:c1': { client: 'codex', sessionId: 'c1', title: 'Child Task', projectLabel: 'Repo', parentClient: 'codex', parentSessionId: 'p1', totalTokens: 1600, lastUsedAt: nowIso }
        }
      }
    }
  }, 'mac-local');
  assert.ok(collidedGroupStats.periods.today.sessions['codex:c1']);
  assert.equal(collidedGroupStats.periods.today.sessions['codex:c1'].sourceDevice, undefined);
  statsHandler({ event: 'stats', data: { mode: 'sync', stats: collidedGroupStats } });

  const drawerClick = drawerBody.listeners.get('click');
  const childIdx = groupRow.groupRows.findIndex((r) => r.sessionId === 'c1');
  drawerClick({ target: { closest: (sel) => (sel.includes('data-drawer-member-idx') ? { dataset: { drawerMemberIdx: String(childIdx) } } : null) } });
  assert.equal(detailCalls.length, 0, 'member click in still-open group drawer must revalidate against collided snapshot');
  assert.doesNotMatch(drawerSubtitle.textContent, /MacBook/);

  // Case B: confirm local child detail load held in flight; hiding session titles must stay redacted
  // on the Back button even after the delayed detail response resolves and renders anatomy.
  statsHandler({ event: 'stats', data: { mode: 'sync', stats: { ...singleLocalGroupStats, snapshot: { id: 52, source: 4 } } } });
  const freshSessions = dashboardModel.buildSessionList({
    stats: context.state.stats,
    periodKey: 'today',
    settings: context.state.settings,
    statsMode: 'sync',
    nowMs: Date.parse(nowIso)
  });
  const freshGroup = freshSessions.find((s) => s.subagentGroup);
  context.openDrawer({ kind: 'session', session: freshGroup });
  drawerClick({ target: { closest: (sel) => (sel.includes('data-drawer-member-idx') ? { dataset: { drawerMemberIdx: String(freshGroup.groupRows.findIndex((r) => r.sessionId === 'c1')) } } : null) } });
  assert.equal(detailCalls.length, 1);
  assert.match(drawerBody.innerHTML, /Main Task/);

  settingsHandler({ sessionTitlesEnabled: false });
  assert.doesNotMatch(drawerBody.innerHTML, /Main Task/, 'Back button must redact parent title immediately');
  assert.match(drawerBody.innerHTML, /← Repo/);

  resolveDelayedDetail({
    found: true,
    totals: { totalTokens: 800, costUsd: 0.4 },
    exchanges: [{ tokens: { input: 100, cacheRead: 600, cacheWrite: 0, output: 100, total: 800 } }]
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.match(drawerBody.innerHTML, /dashboard\.anatomy\.title/, 'delayed detail response still renders anatomy');
  assert.doesNotMatch(drawerBody.innerHTML, /Main Task/, 'delayed detail response must not restore redacted Back button title');
  assert.match(drawerBody.innerHTML, /← Repo/);

  // Case C: stale remote member replaced by local session in a newer snapshot from the same Hub
  // must NOT relabel the stale remote row as local or read local transcript detail
  const initialCallCount = detailCalls.length;
  const remoteChildGroupStats = projectSessionDeviceStats({
    localDeviceId: 'mac-local',
    snapshot: { id: 53, source: 4 },
    devices: [
      {
        deviceId: 'mac-local',
        displayName: 'MacBook',
        platform: 'darwin',
        periods: {
          today: {
            totalTokens: 1200,
            sessions: {
              'codex:p2': { client: 'codex', sessionId: 'p2', title: 'Group Two', projectLabel: 'Repo', totalTokens: 1200, lastUsedAt: nowIso }
            }
          }
        }
      },
      {
        deviceId: 'linux-remote',
        displayName: 'Linux Box',
        platform: 'linux',
        periods: {
          today: {
            totalTokens: 500,
            sessions: {
              'codex:r-swap': { client: 'codex', sessionId: 'r-swap', title: 'Remote Secret', projectLabel: 'Repo', parentClient: 'codex', parentSessionId: 'p2', totalTokens: 500, lastUsedAt: nowIso }
            }
          }
        }
      }
    ],
    periods: {
      today: {
        totalTokens: 1700,
        sessions: {
          'codex:p2': { client: 'codex', sessionId: 'p2', title: 'Group Two', projectLabel: 'Repo', totalTokens: 1200, lastUsedAt: nowIso },
          'codex:r-swap': { client: 'codex', sessionId: 'r-swap', title: 'Remote Secret', projectLabel: 'Repo', parentClient: 'codex', parentSessionId: 'p2', totalTokens: 500, lastUsedAt: nowIso }
        }
      }
    }
  }, 'mac-local');
  settingsHandler({ sessionTitlesEnabled: true });
  statsHandler({ event: 'stats', data: { mode: 'sync', stats: remoteChildGroupStats } });
  const swapGroup = dashboardModel.buildSessionList({
    stats: context.state.stats,
    periodKey: 'today',
    settings: context.state.settings,
    statsMode: 'sync',
    nowMs: Date.parse(nowIso)
  }).find((s) => s.sessionId === 'p2');
  assert.ok(swapGroup);
  context.openDrawer({ kind: 'session', session: swapGroup });

  const localReplacedStats = projectSessionDeviceStats({
    localDeviceId: 'mac-local',
    snapshot: { id: 54, source: 4 },
    devices: [
      {
        deviceId: 'mac-local',
        displayName: 'MacBook',
        platform: 'darwin',
        periods: {
          today: {
            totalTokens: 2100,
            sessions: {
              'codex:p2': { client: 'codex', sessionId: 'p2', title: 'Group Two', projectLabel: 'Repo', totalTokens: 1200, lastUsedAt: nowIso },
              'codex:r-swap': { client: 'codex', sessionId: 'r-swap', title: 'Local Task', projectLabel: 'Repo', parentClient: 'codex', parentSessionId: 'p2', totalTokens: 900, lastUsedAt: nowIso }
            }
          }
        }
      },
      {
        deviceId: 'linux-remote',
        displayName: 'Linux Box',
        platform: 'linux',
        periods: { today: { totalTokens: 0, sessions: {} } }
      }
    ],
    periods: {
      today: {
        totalTokens: 2100,
        sessions: {
          'codex:p2': { client: 'codex', sessionId: 'p2', title: 'Group Two', projectLabel: 'Repo', totalTokens: 1200, lastUsedAt: nowIso },
          'codex:r-swap': { client: 'codex', sessionId: 'r-swap', title: 'Local Task', projectLabel: 'Repo', parentClient: 'codex', parentSessionId: 'p2', totalTokens: 900, lastUsedAt: nowIso }
        }
      }
    }
  }, 'mac-local');
  statsHandler({ event: 'stats', data: { mode: 'sync', stats: localReplacedStats } });

  const swapIdx = swapGroup.groupRows.findIndex((r) => r.sessionId === 'r-swap');
  drawerClick({ target: { closest: (sel) => (sel.includes('data-drawer-member-idx') ? { dataset: { drawerMemberIdx: String(swapIdx) } } : null) } });
  assert.equal(detailCalls.length, initialCallCount, 'stale remote member replaced by local owner must NOT read local transcript');
  assert.doesNotMatch(drawerSubtitle.textContent, /MacBook/);
  assert.match(drawerSubtitle.textContent, /Linux Box/);
});

test('dashboard resolves synced fixed periods (yesterday, week, last7, last30) with sessions, workspaces, and Live Flow in aggregate and device scope', async () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const dashboardModel = require('../../src/electron/renderer/dashboardModel');
  const { resolveSyncedFixedPeriod } = require('../../src/electron/syncedFixedPeriod');
  const { normalizePeriod } = require('../../src/shared/usage');
  const now = new Date();
  const nowIso = now.toISOString();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const yestDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yestKey = `${yestDate.getFullYear()}-${String(yestDate.getMonth() + 1).padStart(2, '0')}-${String(yestDate.getDate()).padStart(2, '0')}`;
  const yestIso = new Date(yestDate.getFullYear(), yestDate.getMonth(), yestDate.getDate(), 12).toISOString();

  const remotePeriods = {
    'mac-1:yesterday': normalizePeriod({
      totalTokens: 40,
      costUsd: 0.04,
      clients: { codex: 40 },
      clientCosts: { codex: 0.04 },
      models: { 'gpt-6.2-sol': 40 },
      modelCosts: { 'gpt-6.2-sol': 0.04 },
      projects: { RepoA: { totalTokens: 40, costUsd: 0.04, clients: { codex: 40 } } },
      sessions: {
        'codex:y1': { client: 'codex', sessionId: 'y1', title: 'Mac Yest', projectLabel: 'RepoA', totalTokens: 40, costUsd: 0.04, lastUsedAt: yestIso }
      }
    }),
    'linux-2:yesterday': normalizePeriod({
      totalTokens: 30,
      costUsd: 0.03,
      clients: { claude: 30 },
      clientCosts: { claude: 0.03 },
      models: { 'claude-sonnet-4-5': 30 },
      modelCosts: { 'claude-sonnet-4-5': 0.03 },
      projects: { RepoA: { totalTokens: 30, costUsd: 0.03, clients: { claude: 30 } } },
      sessions: {
        'claude:y2': { client: 'claude', sessionId: 'y2', title: 'Linux Yest', projectLabel: 'RepoA', totalTokens: 30, costUsd: 0.03, lastUsedAt: yestIso }
      }
    })
  };

  const endsAtIso = new Date(now.getTime() + 3_600_000).toISOString();
  const baseStats = {
    localDeviceId: 'mac-1',
    mode: 'sync',
    snapshot: { id: 60, source: 5 },
    fixedRangeRevisions: { 'mac-1': 'rev-m1', 'linux-2': 'rev-l2' },
    devices: [
      { deviceId: 'mac-1', displayName: 'MacBook', platform: 'darwin', updatedAt: nowIso, periodWindows: { today: { key: todayKey, endsAt: endsAtIso } }, periods: { today: { totalTokens: 0, sessions: {} } } },
      { deviceId: 'linux-2', displayName: 'Linux', platform: 'linux', updatedAt: nowIso, periodWindows: { today: { key: todayKey, endsAt: endsAtIso } }, periods: { today: { totalTokens: 0, sessions: {} } } }
    ],
    periods: {
      today: { totalTokens: 0, sessions: {} },
      month: { totalTokens: 70, sessions: {} }
    }
  };

  let requestedSelection = null;
  let missingDevice = 'linux-2';
  let delayedRead;
  const detailCalls = [];
  const context = {
    state: {
      periodKey: 'yesterday',
      selectedDeviceId: 'all',
      settings: { deviceId: 'mac-1', sessionTitlesEnabled: true, hubMode: 'client', hubUrl: 'https://hub-a' },
      stats: baseStats,
      history: { daily: [{ date: yestKey, tokens: 70, cost: 0.07 }], deviceHistories: [] },
      statsMode: 'sync',
      locale: 'en',
      motion: 'none',
      drawer: null
    },
    els: {
      drawer: { showPopover() {}, matches() { return false; } },
      drawerScrim: { classList: { remove() {}, add() {} } },
      drawerIcon: { className: '', style: {} },
      drawerTitle: { textContent: '' },
      drawerSubtitle: { textContent: '' },
      drawerBody: { innerHTML: '', addEventListener() {} },
      tooltip: { classList: { contains() { return true; } } },
      refreshBtn: { classList: { toggle() {} }, setAttribute() {}, removeAttribute() {}, disabled: false },
      body: { classList: { toggle() {} } }
    },
    fixedPeriodRangesApi: require('../../src/electron/renderer/fixedPeriodRanges'),
    modelApi: dashboardModel,
    sessionTitleDisplayApi: require('../../src/electron/sessionTitleDisplay'),
    sessionActivityProjectionApi: null,
    allTimeSessionsApi: null,
    tokenRateApi: null,
    charts: { clientColors: {} },
    deviceRateTracker: { getSample() { return null; }, reset() {}, observe() {} },
    rateHistory: { getSamples() { return []; }, reset() {}, observe() {} },
    deviceRateTrackers: new Map(),
    rateExpiryTimer: null,
    dashboardReady: true,
    document: { hidden: false },
    escapeHtml: (s) => String(s ?? ''),
    formatCompact: String,
    formatCost: String,
    applySwatchColors() {},
    applyAppearance() {},
    drawerStatGrid: () => '<div></div>',
    drawerRequestToken: 0,
    applyReduceMotionPreference() {},
    render() {},
    scheduleDashboardRefresh() {},
    observeStatsRates() {},
    i18n: { resolveLocale: () => 'en' },
    compactTokenApi: { normalizeCompactTokenUnits: (v) => v },
    navigator: { languages: ['en'] },
    reducedMotionMedia: null,
    console: { log() {} },
    setTimeout,
    clearTimeout,
    t: (k) => k,
    window: {
      tokenMonitor: {
        async getSyncedFixedPeriod(_id, _source, selection) {
          requestedSelection = selection;
          if (delayedRead) await delayedRead;
          return resolveSyncedFixedPeriod(selection, baseStats.devices, baseStats.fixedRangeRevisions, {
            now: now.getTime(),
            read: devId => devId === missingDevice ? null : remotePeriods[`${devId}:yesterday`],
            history: async devices => devices.map(device => ({
              deviceId: device.deviceId,
              range: { start: yestKey, end: yestKey },
              period: { totalTokens: 30, costUsd: 0.03 }
            }))
          });
        },
        getSessionDetail(args) { detailCalls.push(args); return Promise.resolve(null); }
      }
    }
  };

  const slice = js.slice(js.indexOf('let localSessionActivity = null;'), js.indexOf('\nfunction renderNow('));
  vm.runInNewContext(slice, context);

  for (const periodName of ['yesterday', 'week', 'last7', 'last30']) {
    assert.ok(context.syncedSessionPagesKeyFor(context.state.stats, periodName), `${periodName} must produce a synced fetch key`);
  }

  context.ensureSyncedSessionPages('yesterday');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requestedSelection, 'yesterday');

  const partial = dashboardModel.buildScopedOverview({
    stats: context.state.stats, periodKey: 'yesterday', statsMode: 'sync'
  });
  assert.equal(partial.hero.tokens, 70, 'keep History totals for the device without detail');
  assert.equal(partial.sessionsIncomplete, true);
  assert.equal(partial.sessions.length, 0);
  assert.equal(partial.workspaces.length, 0);

  missingDevice = '';
  context.ensureSyncedSessionPages('yesterday');
  await new Promise((r) => setTimeout(r, 0));

  const aggOverview = dashboardModel.buildScopedOverview({
    stats: context.state.stats,
    history: context.state.history,
    periodKey: 'yesterday',
    selectedDeviceId: 'all',
    settings: context.state.settings,
    statsMode: 'sync',
    nowMs: now.getTime()
  });
  assert.equal(aggOverview.hero.tokens, 70);
  assert.equal(aggOverview.sessions.length, 2);
  assert.equal(aggOverview.workspaces.length, 1);
  assert.equal(aggOverview.workspaces[0].tokens, 70);
  assert.equal(aggOverview.topology.mode, 'sessions');

  const devOverview = dashboardModel.buildScopedOverview({
    stats: context.state.stats,
    history: context.state.history,
    periodKey: 'yesterday',
    selectedDeviceId: 'mac-1',
    settings: context.state.settings,
    statsMode: 'sync',
    nowMs: now.getTime()
  });
  assert.equal(devOverview.hero.tokens, 40);
  assert.equal(devOverview.sessions.length, 1);
  assert.equal(devOverview.sessions[0].sessionId, 'y1');
  assert.equal(devOverview.workspaces.length, 1);
  assert.equal(devOverview.workspaces[0].tokens, 40);
  assert.equal(devOverview.topology.mode, 'sessions');
  assert.deepEqual(context.state.stats.syncedFixedPeriodDeviceWindows.yesterday['mac-1'], { start: yestKey, end: yestKey });
  // Exercise a fleet-wide range extending past the local owner's day.
  context.state.stats.nativeRangeWindows.yesterday = { start: '2000-01-01', end: yestKey };
  const loadDetail = dashboardFunction('loadSessionDrawerDetail', '\nfunction openDrawer(', context);
  loadDetail(devOverview.sessions[0], 0, '');
  assert.equal(detailCalls[0].period, `range:${yestKey}:${yestKey}`);
  assert.equal(detailCalls[0].snapshotSource, 5);

  // A new revision arriving before its pages must retain the previous complete view.
  let release;
  delayedRead = new Promise(resolve => { release = resolve; });
  context.applyIncomingStats({
    ...baseStats,
    snapshot: { id: 61, source: 5 },
    fixedRangeRevisions: { ...baseStats.fixedRangeRevisions, 'linux-2': 'rev-l3' }
  });
  assert.equal(context.isSyncedSessionPagesLoaded(), false, 'ownership is pending for the new revision');
  assert.equal(dashboardModel.buildScopedOverview({
    stats: context.state.stats, periodKey: 'yesterday', statsMode: 'sync'
  }).topology.mode, 'sessions', 'refresh keeps the previous complete view visible');
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(context.isSyncedSessionPagesLoaded(), true);

  for (const periodName of ['week', 'last7', 'last30']) {
    context.ensureSyncedSessionPages(periodName);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(requestedSelection, periodName);
    assert.equal(context.isSyncedSessionPagesLoaded(context.state.stats, periodName), true);
  }
});

test('renderWorkPanel updates running group subagent badge in place and rebuilds on 0-to-1 transition', () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');

  const makeBadgeRow = ({ withInitialBadge = true } = {}) => {
    const badgeEl = withInitialBadge ? { textContent: '1 subagents' } : null;
    const ctxWrap = { setAttribute() {}, removeAttribute() {} };
    const ctxFill = { setAttribute() {}, style: { setProperty() {} } };
    const ctxVal = { textContent: '40%' };
    const metaText = { innerHTML: '' };
    const subEl = {
      innerHTML: '',
      querySelector(sel) {
        if (sel === '.home-session-context-fill') return ctxFill;
        if (sel.includes('dash-session-badge')) return badgeEl;
        if (sel === '.dash-session-meta-text') return metaText;
        if (sel === '.home-session-context') return ctxWrap;
        if (sel === '.home-session-context-value') return ctxVal;
        return null;
      }
    };
    const titleEl = { textContent: 'Parent Group' };
    const tokEl = { textContent: '100' };
    const costEl = { textContent: '$0.10' };
    const stateNode = { dataset: { state: 'running' }, replaceWith() {} };
    const row = {
      dataset: { sessionKey: 'codex:p1' },
      className: 'dash-session-row state-running',
      querySelector(sel) {
        if (sel === '.dash-session-lead') return { querySelector: () => stateNode };
        if (sel === '.dash-session-title-text') return titleEl;
        if (sel === '.dash-session-sub') return subEl;
        if (sel === '.dash-row-tokens') return tokEl;
        if (sel === '.dash-row-cost') return costEl;
        return null;
      }
    };
    return { row, subEl, badgeEl };
  };

  let mockRows = [];
  const workPanel = {
    innerHTML: '',
    querySelectorAll(sel) { return sel === '.dash-session-row' ? mockRows : []; },
    contains: () => false
  };

  const context = {
    state: { workMode: 'sessions', selectedDeviceId: 'all', locale: 'en' },
    els: { workPanel, workTitle: { textContent: '' }, workSummary: { textContent: '' } },
    sessionLiveApi: require('../../src/shared/sessionLive'),
    lastWorkStructureSig: '',
    displayColor: (c) => String(c || '#6ab4f0'),
    escapeHtml: (s) => String(s ?? ''),
    formatCompact: String,
    formatCost: String,
    applySwatchColors() {},
    captureListSnapshot: () => null,
    animateListSnapshot() {},
    withPreservedFocus(_el, _sel, _key, fn) { fn(); },
    t: (k, vars = {}) => (k === 'sessions.subagentCount' ? `${vars.count} subagents` : k)
  };

  vm.runInNewContext(js.slice(js.indexOf('function sessionGroupBadgeLabel('), js.indexOf('\nfunction renderTopology(')), context);

  const mkOverview = (groupCount) => ({
    sessions: [{
      key: 'codex:p1',
      title: 'Parent Group',
      projectLabel: 'Repo',
      modelLabel: 'gpt-6.2-sol',
      color: '#6ab4f0',
      activityState: 'running',
      totalTokens: 100 + groupCount * 50,
      costUsd: 0.1,
      unpricedTokens: 0,
      context: { displayPercent: 40, tone: 'ok' },
      subagentGroup: groupCount > 1,
      groupKind: groupCount > 1 ? 'subagents' : '',
      subagentCount: Math.max(0, groupCount - 1),
      groupCount
    }]
  });

  // 0 -> 1 subagent with same row key must rebuild subEl to insert the new badge
  context.renderWorkPanel(mkOverview(1));
  const noBadgeRow = makeBadgeRow({ withInitialBadge: false });
  mockRows = [noBadgeRow.row];
  context.renderWorkPanel(mkOverview(2));
  assert.match(noBadgeRow.subEl.innerHTML, /1 subagents/, '0-to-1 subagent transition must insert subagent badge');

  // 1 -> 2 subagents with existing badge & context meter updates badge text in place
  const withBadgeRow = makeBadgeRow({ withInitialBadge: true });
  mockRows = [withBadgeRow.row];
  context.renderWorkPanel(mkOverview(3));
  assert.equal(withBadgeRow.badgeEl.textContent, '2 subagents', '1-to-2 subagent growth must update badge text in place');
  assert.equal(withBadgeRow.subEl.innerHTML, '', 'in-place badge update preserves existing context meter DOM');
});


test('Dashboard applies Stats without History and fences older successful History responses', async () => {
  const js = read('src', 'electron', 'renderer', 'dashboard.js');
  const reads = [];
  let snapshot = 0;
  const context = {
    state: { stats: null, history: null },
    window: { tokenMonitor: {
      getStats: async () => ({ snapshot: { id: ++snapshot, source: 1 } }),
      getDashboardHistory: () => new Promise((resolve, reject) => reads.push({ resolve, reject }))
    } },
    observeStatsRates() {},
    render() {}
  };
  vm.runInNewContext(js.slice(js.indexOf('let historyRequestSeq'), js.indexOf('async function manualRefresh(')), context);
  const failed = context.pullDashboardData();
  const rejected = assert.rejects(failed, /History offline/);
  await new Promise(setImmediate);
  assert.equal(context.state.stats.snapshot.id, 1);
  reads[0].reject(new Error('History offline'));
  await rejected;

  const older = context.pullDashboardData();
  await Promise.resolve();
  const manual = context.pullDashboardData({ manual: true });
  await new Promise(setImmediate);
  reads[2].resolve({ revision: 'manual' });
  await manual;
  reads[1].resolve({ revision: 'older' });
  await older;
  assert.equal(context.state.history.revision, 'manual');
});


test('Dashboard schedules a repaint for session expiry without throughput samples', () => {
  const now = Date.now();
  const raw = { lastUsedAt: new Date(now - 1_000).toISOString() };
  const sessionLiveApi = require('../../src/shared/sessionLive');
  const expected = sessionLiveApi.nextSessionStatusChangeAt([raw], now);
  assert.ok(expected > now);
  let timer;
  let rendered = 0;
  const schedule = dashboardFunction('scheduleRateExpiry', '\nfunction observeStatsRates', {
    state: { overview: { sessions: [{ groupRows: [{ raw }] }] } },
    sessionLiveApi, document: { hidden: false }, Date: { now: () => now },
    deviceRateTracker: null, rateHistory: null, deviceRateTrackers: new Map(),
    rateExpiryTimer: null,
    setTimeout(callback, delay) { timer = { callback, delay }; },
    render() { rendered += 1; }
  });
  schedule();
  assert.equal(timer.delay, expected - now + 20);
  timer.callback();
  assert.equal(rendered, 1);
});
