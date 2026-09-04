'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  createStatsRenderScheduler,
  visibleStatsSurface
} = require('../../src/electron/renderer/statsRenderScheduler');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const electronDir = path.join(rendererDir, '..');

function rendererFunction(name, endMarker, context) {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const source = app.slice(app.indexOf(`function ${name}(`), app.indexOf(endMarker));
  return new vm.Script(`${source}\n${name};`).runInNewContext(context);
}

test('hidden stats updates coalesce into one render when visibility returns', () => {
  let hidden = true;
  let renders = 0;
  const scheduler = createStatsRenderScheduler({
    isHidden: () => hidden,
    render: () => { renders += 1; }
  });

  scheduler.request();
  scheduler.request();
  assert.equal(renders, 0);

  scheduler.flush();
  assert.equal(renders, 0);
  hidden = false;
  scheduler.flush();
  scheduler.flush();
  assert.equal(renders, 1);
});

test('visible stats updates continue rendering every push', () => {
  let renders = 0;
  const scheduler = createStatsRenderScheduler({
    isHidden: () => false,
    render: () => { renders += 1; }
  });

  scheduler.request();
  scheduler.request();
  assert.equal(renders, 2);
});

test('page and native visibility signals report each combined edge once', () => {
  let pageHidden = false;
  let nativeVisible = true;
  const scheduler = createStatsRenderScheduler({
    isHidden: () => pageHidden || !nativeVisible,
    render: () => {}
  });

  for (const [nextPageHidden, nextNativeVisible, changed] of [
    [false, true, false],
    [true, true, true],
    [true, false, false],
    [false, false, false],
    [false, true, true],
    [false, false, true],
    [true, false, false],
    [true, true, false],
    [false, true, true]
  ]) {
    pageHidden = nextPageHidden;
    nativeVisible = nextNativeVisible;
    assert.equal(scheduler.visibilityChanged(), changed);
  }
});

test('visible stats update only the primary exposed surface', () => {
  assert.equal(visibleStatsSurface(false, false), 'main');
  assert.equal(visibleStatsSurface(false, true), 'bubble');
  assert.equal(visibleStatsSurface(true, false), null);
  assert.equal(visibleStatsSurface(true, true), null);
});

test('a hidden floating-bubble state update changes state without touching DOM', () => {
  let scheduledRenders = 0;
  const state = { floatingBubble: { collapsed: false, side: null } };
  const applyFloatingBubbleState = rendererFunction(
    'applyFloatingBubbleState',
    'const BUBBLE_CONTENT_VALUES',
    {
      document: {
        get documentElement() {
          return assert.fail('hidden floating-bubble state touched DOM');
        }
      },
      isRendererWindowHidden: () => true,
      state,
      statsRenderScheduler: { request() { scheduledRenders += 1; } }
    }
  );

  applyFloatingBubbleState({ collapsed: true, side: 'left' });

  assert.equal(state.floatingBubble.collapsed, true);
  assert.equal(state.floatingBubble.side, 'left');
  assert.equal(scheduledRenders, 1);
});

test('hidden payloads keep the latest state and tray updates before visible rendering resumes', () => {
  let hidden = true;
  let latestStats = null;
  const renderedStats = [];
  const trayStats = [];
  const scheduler = createStatsRenderScheduler({
    isHidden: () => hidden,
    render: () => renderedStats.push(latestStats)
  });
  const pushStats = (stats) => {
    latestStats = stats;
    scheduler.request();
    trayStats.push(stats);
  };

  pushStats({ revision: 1 });
  pushStats({ revision: 2 });
  assert.deepEqual(latestStats, { revision: 2 });
  assert.deepEqual(renderedStats, []);
  assert.deepEqual(trayStats, [{ revision: 1 }, { revision: 2 }]);

  hidden = false;
  scheduler.flush();
  assert.deepEqual(renderedStats, [{ revision: 2 }]);

  pushStats({ revision: 3 });
  assert.deepEqual(renderedStats, [{ revision: 2 }, { revision: 3 }]);
  assert.deepEqual(trayStats, [{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
});

test('renderer wires visibility scheduling without deferring tray icon updates', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const statsPush = app.match(/window\.tokenMonitor\.onStatsPush\?\.\(\(payload\) => \{[\s\S]*?\n\}\);/)?.[0] || '';
  const schedulerIndex = html.indexOf('<script src="statsRenderScheduler.js"></script>');
  const appIndex = html.indexOf('<script src="app.js"></script>');
  const visibilityListenerStart = app.indexOf('function handleWindowVisibilityChange()');
  const visibilityListenerEnd = app.indexOf("document.addEventListener('visibilitychange'", visibilityListenerStart);
  const visibilityListener = visibilityListenerStart >= 0 && visibilityListenerEnd > visibilityListenerStart
    ? app.slice(visibilityListenerStart, visibilityListenerEnd)
    : '';

  assert.notEqual(schedulerIndex, -1);
  assert.notEqual(appIndex, -1);
  assert.ok(schedulerIndex < appIndex);
  assert.notEqual(visibilityListenerStart, -1);
  assert.notEqual(visibilityListenerEnd, -1);
  assert.match(app, /document\.addEventListener\('visibilitychange', handleWindowVisibilityChange\)/);
  assert.match(visibilityListener, /cancelTokenRateBoost\(\)/);
  assert.match(visibilityListener, /!isRendererWindowHidden\(\)[\s\S]*hubBuildStatusRefreshDue\(\)[\s\S]*refreshHubBuildStatus\(\)/);
  assert.match(visibilityListener, /const settingsVisible = isSettingsSurfaceVisible\(\);[\s\S]*if \(settingsVisible \|\| settingsDomSyncPending\) syncSettingsForm\(\);[\s\S]*statsRenderScheduler\.flush\(\)/);
  assert.doesNotMatch(visibilityListener, /statsRenderScheduler\.clear\(\)/);
  assert.match(app, /isHidden: isRendererWindowHidden/);
  assert.match(app, /onWindowVisibilityPush\?\.\(\(visible\) => \{/);
  assert.match(
    statsPush,
    /state\.stats = overlayAllTimeSessions\(payload\.data\.stats\);[\s\S]*statsRenderScheduler\.request\(\);[\s\S]*maybeUpdateBarsIcon\(\);/
  );
});

test('native window visibility covers a tray window that has never been shown', () => {
  const main = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(electronDir, 'preload.js'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');

  assert.match(main, /webContents\.send\('window:visibility'/);
  assert.match(main, /win\.on\('show',[\s\S]*win\.on\('hide',[\s\S]*win\.on\('minimize',[\s\S]*win\.on\('restore'/);
  assert.match(main, /settings\?\.trayMode \? \{ windowHidden: '1' \} : \{\}/);
  assert.match(preload, /onWindowVisibilityPush:[\s\S]*ipcRenderer\.on\('window:visibility'/);
  assert.match(app, /windowVisible: new URLSearchParams\(window\.location\.search\)\.get\('windowHidden'\) !== '1'/);
  assert.match(app, /return document\.hidden \|\| !state\.windowVisible;/);
});

test('native visibility is resynced after every renderer load without blocking the initial reveal', () => {
  const main = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8');
  const createWindow = main.slice(main.indexOf('function createWindow('), main.indexOf('function handleZoomShortcut('));
  const visibilityHooks = createWindow.slice(
    createWindow.indexOf("win.on('show'"),
    createWindow.indexOf('loadWindowFile(win')
  );

  // loadWindowFile({ waitForContent }) reveals on window:contentReady, which the
  // renderer only sends once it renders — and it does not render while it
  // believes it is hidden. Reporting the pre-reveal isVisible() === false here
  // would leave the 2.5s fallback as the only way a replaced window can appear.
  // The listener must also survive Cmd+Shift+R: tray-mode URLs retain
  // windowHidden=1, so a visible reloaded renderer needs the native truth again.
  assert.match(visibilityHooks, /win\.webContents\.on\('did-finish-load'/);
  assert.match(visibilityHooks, /if \(win\.isVisible\(\)\) sendMainWindowVisibility\(win\);/);
  assert.doesNotMatch(visibilityHooks, /^\s*sendMainWindowVisibility\(win\);/m);
});

test('a window revealed straight into Settings still reports painted content', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const visibilityHandler = app.slice(
    app.indexOf('function handleWindowVisibilityChange()'),
    app.indexOf("document.addEventListener('visibilitychange'")
  );
  // Settings is an overlay, so revealing into it must flush the pending main
  // repaint as well as syncing the visible form and reporting painted content.
  assert.match(visibilityHandler, /if \(settingsVisible \|\| settingsDomSyncPending\) syncSettingsForm\(\);/);
  assert.match(visibilityHandler, /statsRenderScheduler\.flush\(\);/);
  assert.match(visibilityHandler, /if \(settingsVisible\) \{[\s\S]*signalContentReady\(\);/);
  assert.doesNotMatch(visibilityHandler, /statsRenderScheduler\.clear\(\)/);
});

test('Settings remains open while its background view changes', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const changeView = app.slice(
    app.indexOf('function renderBreakdownChange('),
    app.indexOf('\nfunction restartTimer(')
  );
  const trayView = app.slice(
    app.indexOf('function openViewFromTray('),
    app.indexOf('\nconst HOME_HISTORY_MAX_RETRIES')
  );

  assert.doesNotMatch(changeView, /settingsPanel|settings-open|resetSettingsListSearch|stopWindowShortcutRecording/);
  assert.match(changeView, /setBreakdown\([\s\S]*render\(\)/);
  assert.match(trayView, /settingsPanel\?\.classList\.add\('hidden'\)/);
  assert.match(trayView, /els\.shell\.classList\.remove\('settings-open'\)/);
});

test('a stats update repaints main and the visible Settings overlay', () => {
  const calls = [];
  const settingsRenderers = [
    'renderCodexAccounts',
    'renderSettingsSummaries',
    'renderLimitProviderCheckboxes',
    'renderToolPreferences',
    'renderWslPanel',
    'updateOpenRouterProfilesStatus',
    'updateThirdPartyProfilesStatus',
    'renderDeepseekStatus',
    'renderMinimaxStatus',
    'renderCopilotStatus'
  ];
  const context = {
    visibleStatsSurface: () => 'main',
    renderConnectionStatus: (surface) => calls.push(`connection:${surface}`),
    render: () => calls.push('main'),
    isSettingsSurfaceVisible: () => true,
    renderFloatingBubbleContent: () => calls.push('bubble'),
    signalContentReady: () => calls.push('ready')
  };
  for (const name of settingsRenderers) context[name] = () => calls.push(name);
  context.renderExternalProviderStatus = (provider) => calls.push(`external:${provider}`);

  const renderStatsUpdate = rendererFunction(
    'renderStatsUpdate',
    '\nconst statsRenderScheduler =',
    context
  );
  renderStatsUpdate();

  assert.deepEqual(calls.slice(0, 2), ['connection:main', 'main']);
  assert.ok(calls.indexOf('renderSettingsSummaries') > calls.indexOf('main'));
  assert.equal(calls.at(-1), 'ready');
});

test('the closed-Settings guard does not strand main-surface controls', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const body = app.slice(app.indexOf('function syncSettingsForm()'), app.indexOf('function enabledClientSet()'));
  const guard = body.indexOf('if (!isSettingsSurfaceVisible()) return;');

  // The pin button lives in the header and is clickable while Settings is closed,
  // so the only thing that redraws it has to run before the guard. Behind it, the
  // icon silently keeps the previous mode while the window behaviour changes.
  assert.ok(guard > 0);
  assert.ok(body.indexOf('syncWindowBehaviorControls()') < guard);

  // Nothing reached after the guard may write main-surface DOM.
  const after = body.slice(guard);
  for (const el of ['pinButton', 'shell', 'totalTokens', 'breakdown', 'homePanel', 'viewSwitcher']) {
    assert.doesNotMatch(after, new RegExp(`els\\.${el}\\b`), `syncSettingsForm writes els.${el} behind the Settings guard`);
  }
});

test('heavy render roots reject work for an inactive surface', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const body = (name, next) => app.slice(app.indexOf(`function ${name}(`), app.indexOf(next));

  assert.match(body('renderServiceStatus', '\nasync function refreshServiceStatus('), /function renderServiceStatus\(\) \{\n {2}if \(!serviceStatusSurfaceVisible\(\)\) return;/);
  assert.match(body('renderFloatingBubbleContent', '\nfunction setupFloatingBubbleInteraction('), /function renderFloatingBubbleContent\(\) \{\n {2}if \(visibleStatsSurface\(\) !== 'bubble'\) return;/);

  for (const [name, next] of [
    ['renderSettingsSummaries', '\nfunction formatNumber('],
    ['renderSubscriptionSettings', '\n// The list may live on a hub'],
    ['renderCodexAccounts', '\nasync function refreshCodexAccounts('],
    ['renderMimoStatus', '\nfunction externalLimitProviderConfig('],
    ['renderOpenCodeProfiles', '\nfunction normalizeProfileName('],
    ['renderNamedApiProfiles', '\nfunction renderOpenRouterProfiles('],
    ['renderCursorStatus', '\nasync function refreshCursorStatus('],
    ['renderCustomPricing', '\nfunction setupCustomPricingUI(']
  ]) {
    assert.match(body(name, next), new RegExp(`function ${name}\\([^)]*\\) \\{\\n {2}if \\(!isSettingsSurfaceVisible\\(\\)\\) return;`));
  }

  assert.match(body('renderOpenCodeProfiles', '\nfunction normalizeProfileName('), /\.then\(\([^)]*\) => \{\n {4}if \(!isSettingsSurfaceVisible\(\)\) return;/);
  assert.match(body('renderNamedApiProfiles', '\nfunction renderOpenRouterProfiles('), /\.then\(\([^)]*\) => \{\n {4}if \(!isSettingsSurfaceVisible\(\)\) return;/);
});

test('entering Status does not depend on the panel class from the previous render', () => {
  const serviceStatusSurfaceVisible = rendererFunction(
    'serviceStatusSurfaceVisible',
    '\nfunction openHomeSettings(',
    {
      visibleStatsSurface: () => 'main',
      state: { breakdown: 'status' },
      els: { serviceStatusPanel: { classList: { contains: () => true } } }
    }
  );

  assert.equal(serviceStatusSurfaceVisible(), true);
});

test('a hidden Session detail result waits for the main surface to return', () => {
  let surface = null;
  let scheduled = 0;
  const rendered = [];
  const request = {};
  const state = { openSession: request };
  const applySessionDetailResult = rendererFunction(
    'applySessionDetailResult',
    '\nasync function openSessionDetail(',
    {
      visibleStatsSurface: () => surface,
      isRendererWindowHidden: () => surface === null,
      statsRenderScheduler: { request() { scheduled += 1; } },
      renderSessionDetail: (options) => rendered.push(options),
      state
    }
  );

  const options = { detail: { turns: [1, 2, 3] } };
  applySessionDetailResult(request, options);
  assert.equal(scheduled, 1);
  assert.deepEqual(rendered, []);
  assert.equal(request.renderOptions, options);

  surface = 'bubble';
  applySessionDetailResult(request, options);
  assert.equal(scheduled, 1);
  assert.deepEqual(rendered, []);

  surface = 'main';
  applySessionDetailResult(request, options);
  assert.deepEqual(rendered, [options]);
  assert.equal(request.renderOptions, null);

  const renderBody = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const sessionBranch = renderBody.slice(
    renderBody.indexOf('} else if (state.openSession) {'),
    renderBody.indexOf('} else {', renderBody.indexOf('} else if (state.openSession) {'))
  );
  assert.match(sessionBranch, /state\.openSession\.renderOptions[\s\S]*renderSessionDetail/);
});

test('a direct main render defers only while the window is hidden', () => {
  let surface = 'bubble';
  let scheduled = 0;
  const render = rendererFunction('render', '\nfunction setStatus(', {
    visibleStatsSurface: () => surface,
    statsRenderScheduler: { request() { scheduled += 1; } },
    state: { stats: null }
  });

  render();
  assert.equal(scheduled, 0);

  surface = null;
  render();
  assert.equal(scheduled, 1);
});

test('hidden event sources defer DOM work and visible surfaces catch up', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const settingsPush = app.match(/window\.tokenMonitor\.onSettingsPush\?\.\(\(next\) => \{[\s\S]*?\n\}\);/)?.[0] || '';
  const hubPush = app.match(/window\.tokenMonitor\.onHubPush\?\.\(\(payload\) => \{[\s\S]*?\n\}\);/)?.[0] || '';
  const statsPush = app.match(/window\.tokenMonitor\.onStatsPush\?\.\(\(payload\) => \{[\s\S]*?\n\}\);/)?.[0] || '';
  const statsRender = app.slice(app.indexOf('function renderStatsUpdate()'), app.indexOf('const statsRenderScheduler ='));
  const bubbleState = app.slice(app.indexOf('function applyFloatingBubbleState('), app.indexOf('const BUBBLE_CONTENT_VALUES'));
  const settingsSync = app.slice(app.indexOf('function syncSettingsForm()'), app.indexOf('function enabledClientSet()'));
  const visibilityHandler = app.slice(app.indexOf('function handleWindowVisibilityChange()'), app.indexOf("document.addEventListener('visibilitychange'"));
  const hiddenGuard = settingsSync.indexOf('if (isRendererWindowHidden())');
  const hiddenReturn = settingsSync.indexOf('return;', hiddenGuard);

  assert.match(settingsPush, /statsRenderScheduler\.request\(\)/);
  assert.match(hubPush, /if \(settingsVisible\) renderHubStatus\(\)/);
  assert.match(hubPush, /const settingsVisible = isSettingsSurfaceVisible\(\)[\s\S]*settingsVisible && els\.hubSecretInput/);
  assert.doesNotMatch(statsPush, /\b(?:setLiveDot|setStatus|renderSyncClientStatus)\(/);
  assert.match(statsPush, /if \(isRendererWindowHidden\(\)\) statsRenderScheduler\.request\(\);[\s\S]*else renderConnectionStatus\(\);/);
  assert.match(statsRender, /renderConnectionStatus\(surface\)/);
  assert.match(bubbleState, /if \(isSettingsPanelOpen\(\)\) syncSettingsForm\(\);[\s\S]*renderStatsUpdate\(\)/);
  assert.doesNotMatch(bubbleState, /renderConnectionStatus\('settings'\)/);
  assert.ok(hiddenGuard < settingsSync.indexOf('applyInitialBreakdownPreference()'));
  assert.ok(settingsSync.indexOf('applyInitialBreakdownPreference()') < hiddenReturn);
  assert.ok(hiddenGuard < settingsSync.indexOf('applyVendorColorOverrides('));
  assert.ok(settingsSync.indexOf('applyVendorColorOverrides(') < hiddenReturn);
  for (const domCall of ['applySettingsTranslations()', 'syncPeriodTabs()', 'applyAppearanceSettings(']) {
    assert.ok(hiddenReturn < settingsSync.indexOf(domCall));
  }
  assert.match(settingsSync, /if \(isRendererWindowHidden\(\)\) \{[\s\S]*settingsDomSyncPending = true;[\s\S]*return;/);
  assert.match(visibilityHandler, /else applyFloatingBubbleState\(state\.floatingBubble, \{ renderContent: false \}\);/);
  assert.match(visibilityHandler, /if \(settingsVisible \|\| settingsDomSyncPending\) syncSettingsForm\(\);[\s\S]*statsRenderScheduler\.flush\(\);/);
});

test('all stats refreshes use visibility-aware rendering', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const refreshStats = app.slice(
    app.indexOf('async function refreshStats(options = {})'),
    app.indexOf('async function refreshStatusViewManually()')
  );
  const statsRender = app.slice(
    app.indexOf('function renderStatsUpdate()'),
    app.indexOf('const statsRenderScheduler =')
  );

  assert.match(refreshStats, /getStats\(options\)[\s\S]*statsRenderScheduler\.request\(\);/);
  assert.equal([...refreshStats.matchAll(/setStatus\(statusTextFor/g)].length, 1);
  assert.doesNotMatch(statsRender, /renderMimoStatus\(\);/);
});
