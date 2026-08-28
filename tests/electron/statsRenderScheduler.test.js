'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createStatsRenderScheduler,
  visibleStatsSurface
} = require('../../src/electron/renderer/statsRenderScheduler');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const electronDir = path.join(rendererDir, '..');

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

test('clearing a hidden update prevents a redundant catch-up render', () => {
  let hidden = true;
  let renders = 0;
  const scheduler = createStatsRenderScheduler({
    isHidden: () => hidden,
    render: () => { renders += 1; }
  });

  scheduler.request();
  scheduler.clear();
  hidden = false;
  scheduler.flush();
  assert.equal(renders, 0);
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

test('visible stats update only the exposed surface', () => {
  assert.equal(visibleStatsSurface(false, false, false), 'main');
  assert.equal(visibleStatsSurface(false, false, true), 'settings');
  assert.equal(visibleStatsSurface(false, true, false), 'bubble');
  assert.equal(visibleStatsSurface(true, false, false), null);
  assert.equal(visibleStatsSurface(true, true, false), null);
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
  assert.match(visibilityListener, /if \(isSettingsSurfaceVisible\(\)\)[\s\S]*statsRenderScheduler\.clear\(\)[\s\S]*syncSettingsForm\(\)[\s\S]*else[\s\S]*statsRenderScheduler\.flush\(\)/);
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

test('a window awaiting its content-ready reveal is not reported as hidden', () => {
  const main = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8');
  const createWindow = main.slice(main.indexOf('function createWindow('), main.indexOf('function handleZoomShortcut('));
  const finishLoad = createWindow.slice(createWindow.indexOf("win.webContents.once('did-finish-load'"));

  // loadWindowFile({ waitForContent }) reveals on window:contentReady, which the
  // renderer only sends once it renders — and it does not render while it
  // believes it is hidden. Reporting the pre-reveal isVisible() === false here
  // would leave the 2.5s fallback as the only way a replaced window can appear.
  assert.match(finishLoad, /if \(win\.isVisible\(\)\) sendMainWindowVisibility\(win\);/);
  assert.doesNotMatch(finishLoad, /^\s*sendMainWindowVisibility\(win\);/m);
  assert.match(main, /win\.on\('show', \(\) => sendMainWindowVisibility\(win\)\)/);
});

test('a window revealed straight into Settings still reports painted content', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const visibilityHandler = app.slice(
    app.indexOf('function handleWindowVisibilityChange()'),
    app.indexOf("document.addEventListener('visibilitychange'")
  );
  const settingsBranch = visibilityHandler.slice(
    visibilityHandler.indexOf('if (isSettingsSurfaceVisible())'),
    visibilityHandler.indexOf('} else {')
  );

  // clear() drops the catch-up render that would otherwise have signalled, and
  // syncSettingsForm() is not a stats render, so the signal has to be explicit.
  assert.match(settingsBranch, /statsRenderScheduler\.clear\(\)/);
  assert.match(settingsBranch, /signalContentReady\(\);/);
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
  assert.match(bubbleState, /isSettingsPanelOpen\(\)[\s\S]*syncSettingsForm\(\)[\s\S]*renderStatsUpdate\(\)/);
  assert.match(bubbleState, /syncSettingsForm\(\);[\s\S]*renderConnectionStatus\('settings'\)/);
  assert.ok(hiddenGuard < settingsSync.indexOf('applyInitialBreakdownPreference()'));
  assert.ok(settingsSync.indexOf('applyInitialBreakdownPreference()') < hiddenReturn);
  assert.ok(hiddenGuard < settingsSync.indexOf('applyVendorColorOverrides('));
  assert.ok(settingsSync.indexOf('applyVendorColorOverrides(') < hiddenReturn);
  for (const domCall of ['applySettingsTranslations()', 'syncPeriodTabs()', 'applyAppearanceSettings(']) {
    assert.ok(hiddenReturn < settingsSync.indexOf(domCall));
  }
  assert.match(settingsSync, /if \(isRendererWindowHidden\(\)\) \{[\s\S]*settingsDomSyncPending = true;[\s\S]*return;/);
  assert.match(visibilityHandler, /else \{[\s\S]*if \(settingsDomSyncPending\) syncSettingsForm\(\);[\s\S]*statsRenderScheduler\.flush\(\);/);
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
