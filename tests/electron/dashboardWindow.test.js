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
  assert.match(js, /lastTopologyStructureSig/);
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
      visibilityChanged: () => true
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
  assert.match(handler[1], /nextLocale = i18n\.resolveLocale\(next\.locale \|\| next\.language, navigator\.languages\)/);
  assert.match(handler[1], /nextCompactTokenUnits = compactTokenApi\.normalizeCompactTokenUnits\(next\.compactTokenUnits\)/);
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
    ['getDashboardHistory', { includeDevices: true }],
    ['rates', { periods: { today: { totalTokens: 12 } } }],
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
