'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const electronDir = path.join(__dirname, '../../src/electron');
const main = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(electronDir, 'renderer/app.js'), 'utf8');

function startupWindow(options = {}, settings = {}) {
  const ipcMain = new EventEmitter();
  const target = new EventEmitter();
  target.webContents = new EventEmitter();
  target.webContents.loadFile = () => Promise.resolve();
  let reveals = 0;
  let fallback;
  const context = vm.createContext({
    ipcMain, settings, target, options, path, __dirname: electronDir, console,
    setTimeout: (callback) => { fallback = callback; return 1; },
    clearTimeout: () => { fallback = null; },
    applyZoomFactor: () => {},
    restoreWindowMaximizedForReveal: () => false,
    revealWindow: () => { reveals += 1; target.emit('show'); }
  });
  const loader = main.slice(main.indexOf('function loadWindowFile('), main.indexOf('function createWindow('));
  // Use the actual startup call's option expression, not the test's own default.
  const create = main.slice(main.indexOf('function createWindow('), main.indexOf('function handleZoomShortcut('));
  const wait = create.slice(create.indexOf('loadWindowFile(win,')).match(/waitForContent: ([^,]+),/)[1];
  vm.runInContext(`${loader}\nloadWindowFile(target, { waitForContent: ${wait} });`, context);
  return { target, ipcMain, reveals: () => reveals, fallback: () => fallback?.() };
}

test('cold startup waits for appearance without requiring stats content', () => {
  const run = startupWindow();
  run.target.emit('ready-to-show');
  run.target.webContents.emit('did-finish-load');
  assert.equal(run.reveals(), 0);
  run.ipcMain.emit('window:appearanceReady', { sender: {} });
  assert.equal(run.reveals(), 0, 'another renderer cannot reveal this window');
  run.ipcMain.emit('window:contentReady', { sender: run.target.webContents });
  assert.equal(run.reveals(), 0, 'content is not the startup reveal boundary');
  run.ipcMain.emit('window:appearanceReady', { sender: run.target.webContents });
  assert.equal(run.reveals(), 1);
  assert.equal(run.ipcMain.listenerCount('window:appearanceReady'), 0);
  run.fallback();
  assert.equal(run.reveals(), 1);
});

test('startup retains failure fallback and tray hiding; replacements can wait for content', () => {
  const slow = startupWindow();
  slow.fallback();
  assert.equal(slow.reveals(), 1);
  const tray = startupWindow({}, { trayMode: true });
  tray.ipcMain.emit('window:appearanceReady', { sender: tray.target.webContents });
  tray.fallback();
  assert.equal(tray.reveals(), 0);
  const replacement = startupWindow({ waitForContent: true });
  replacement.ipcMain.emit('window:appearanceReady', { sender: replacement.target.webContents });
  assert.equal(replacement.reveals(), 0);
  replacement.ipcMain.emit('window:contentReady', { sender: replacement.target.webContents });
  assert.equal(replacement.reveals(), 1);
});

test('an early stats push cannot announce readiness before initial settings are applied', () => {
  let signals = 0;
  const context = vm.createContext({
    state: { settings: {}, stats: {} },
    window: { tokenMonitor: { signalContentReady: () => { signals += 1; } } }
  });
  const ready = app.slice(app.indexOf('let contentReadySignaled ='), app.indexOf('function hideTrendTooltip()'));
  vm.runInContext(`${ready}\nsignalContentReady();`, context);
  assert.equal(signals, 0);
  vm.runInContext('initialSettingsApplied = true; signalContentReady(); signalContentReady();', context);
  assert.equal(signals, 1);
  const init = app.slice(app.indexOf('async function init()'), app.indexOf("for (const tab of document.querySelectorAll('.tab'))"));
  assert.match(init, /syncSettingsForm\(\);\s*initialSettingsApplied = true;/);
});


test('appearance readiness precedes plugin, sync, updater and stats waits', () => {
  const init = app.slice(app.indexOf('async function init()'), app.indexOf("for (const tab of document.querySelectorAll('.tab'))"));
  const signal = init.indexOf('window.tokenMonitor.signalAppearanceReady');
  assert.ok(init.indexOf('applyVisibleSettingsAppearance();') < signal);
  for (const wait of ['await pluginApi?.list()', 'await syncContentForm?.refresh(false)', 'await window.tokenMonitor.getAppUpdateState()', 'await refreshStats()']) {
    assert.ok(signal < init.indexOf(wait), wait);
  }
  assert.match(init, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
});

test('static shell agrees with the icon-only title default', () => {
  const html = fs.readFileSync(path.join(electronDir, 'renderer/index.html'), 'utf8');
  assert.match(main, /titleIconOnly: true/);
  assert.match(html, /<main class="shell title-icon-only"/);
});

test('early appearance does not consume a plugin-dependent initial Limits preference', () => {
  const context = vm.createContext({
    state: { settings: { viewDisplayOrder: 'limits,home', hiddenViews: '' }, breakdown: 'home', pluginCatalog: null },
    VIEW_DISPLAY_OPTIONS: [{ id: 'home' }, { id: 'limits' }],
    viewDisplayPreferencesApi: require('../../src/electron/renderer/viewDisplayPreferences'),
    effectiveViewDisplayOrderValue: () => 'limits,home',
    // The plugin-only Limits page is unavailable until discovery supplies it.
    availableBreakdownIds: () => context.state.pluginCatalog ? ['home', 'limits'] : ['home'],
    setBreakdown: value => { context.state.breakdown = value; },
    isRendererWindowHidden: () => false,
    isSettingsSurfaceVisible: () => false,
    setupLimitAccountPanels: () => {},
    applySettingsTranslations: () => {},
    syncPeriodTabs: () => {},
    applyVendorColorOverrides: () => {},
    applyAppearanceSettings: () => {},
    syncWindowBehaviorControls: () => {}
  });
  const preference = app.slice(app.indexOf('function applyInitialBreakdownPreference()'), app.indexOf('function renderSessionUsageArchiveStatus()'));
  const sync = app.slice(app.indexOf('function syncSettingsForm()'), app.indexOf('function enabledClientSet()'));
  vm.runInContext(`let initialBreakdownPreferenceApplied = false;\n${preference}\n${sync}\napplyVisibleSettingsAppearance();`, context);
  assert.equal(context.state.breakdown, 'home');
  context.state.pluginCatalog = { limits: { modules: [{ id: 'plugin:fixture:quota' }] } };
  vm.runInContext('syncSettingsForm();', context);
  assert.equal(context.state.breakdown, 'limits');
});

function initialAppearance({ nativeHidden, windowVisible }) {
  let applied = 0;
  let signaled = 0;
  const frames = [];
  const context = vm.createContext({
    state: { windowVisible },
    document: { hidden: nativeHidden },
    isRendererWindowHidden: () => nativeHidden || !windowVisible,
    applyVisibleSettingsAppearance: () => { applied += 1; },
    window: { tokenMonitor: { signalAppearanceReady: () => { signaled += 1; } } },
    requestAnimationFrame: callback => { frames.push(callback); }
  });
  const init = app.slice(app.indexOf('async function init()'));
  const early = init.slice(init.indexOf('// Local appearance'), init.indexOf('try { await pluginApi?.list();'));
  vm.runInContext(`let initialSettingsApplied = false;\n${early}`, context);
  return { applied: () => applied, signaled: () => signaled, frames };
}

test('an initially hidden retained startup view prepares appearance without waiting for hidden-page frames', () => {
  const run = initialAppearance({ nativeHidden: true, windowVisible: true });
  assert.equal(run.applied(), 1);
  assert.equal(run.signaled(), 1);
  assert.equal(run.frames.length, 0);
});

test('tray-hidden startup prepares appearance without revealing while paintable startup waits for its configured frame', () => {
  const tray = initialAppearance({ nativeHidden: true, windowVisible: false });
  assert.equal(tray.applied(), 1);
  assert.equal(tray.signaled(), 0);
  const visible = initialAppearance({ nativeHidden: false, windowVisible: true });
  assert.equal(visible.applied(), 1);
  assert.equal(visible.signaled(), 0);
  visible.frames.shift()();
  assert.equal(visible.signaled(), 0);
  visible.frames.shift()();
  assert.equal(visible.signaled(), 1);
});

test('native material pushes before settings cannot replace the static icon title with default appearance', () => {
  let materialPush;
  const applied = [];
  const context = vm.createContext({
    state: { settings: null }, nativeMaterialRevision: 0, nativeMaterialState: {},
    pendingSettingsPatches: new Set(), appearancePreview: {},
    glassRenderingApi: { normalizeNativeMaterialState: value => value, applyNativeMaterialClasses: () => {} },
    applyAppearanceSettings: value => applied.push(value),
    window: { tokenMonitor: { onNativeMaterialState: callback => { materialPush = callback; } } }
  });
  const init = app.slice(app.indexOf('async function init()'));
  vm.runInContext(init.slice(init.indexOf('const materialPush ='), init.indexOf('const materialQueryRevision =')), context);
  materialPush({ type: 'vibrancy' });
  assert.equal(applied.length, 0, 'preserve static appearance until saved preferences arrive');
  context.state.settings = { titleIconOnly: true, interfaceFontFamily: 'Arial' };
  materialPush({ type: 'vibrancy' });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].titleIconOnly, true);
  assert.equal(applied[0].interfaceFontFamily, 'Arial');
});

test('settings changed while hidden update appearance before the next native show', () => {
  const applied = [];
  const context = vm.createContext({
    state: { settings: { titleIconOnly: true, interfaceFontFamily: 'Arial', themeColors: {} } },
    pendingSettingsPatches: new Set(), appearancePreview: {},
    isRendererWindowHidden: () => true,
    applyInitialBreakdownPreference: () => {}, applyVendorColorOverrides: () => {},
    themePresetsApi: { normalizeOverrides: value => value },
    applyAppearanceSettings: value => applied.push({ ...value })
  });
  const sync = app.slice(app.indexOf('function syncSettingsForm()'), app.indexOf('function applyVisibleSettingsAppearance()'));
  vm.runInContext(`let appliedThemeOverrides; let settingsDomSyncPending = false; ${sync}\nsyncSettingsForm();`, context);
  context.state.settings = { titleIconOnly: false, interfaceFontFamily: 'Georgia', themeColors: {} };
  vm.runInContext('syncSettingsForm();', context);
  assert.equal(applied.length, 2);
  assert.equal(applied[0].titleIconOnly, true);
  assert.equal(applied[0].interfaceFontFamily, 'Arial');
  assert.equal(applied[1].titleIconOnly, false);
  assert.equal(applied[1].interfaceFontFamily, 'Georgia');
  context.pendingSettingsPatches.add({ titleIconOnly: true, interfaceFontFamily: 'Arial' });
  context.appearancePreview = { interfaceFontFamily: 'Verdana' };
  vm.runInContext('syncSettingsForm();', context);
  assert.equal(applied[2].titleIconOnly, true, 'an in-flight save takes precedence over saved settings');
  assert.equal(applied[2].interfaceFontFamily, 'Verdana', 'the current preview takes precedence over an in-flight save');
});

test('the native window starts with saved zoom before any page-load event', () => {
  const create = main.slice(main.indexOf('function createWindow('), main.indexOf('function handleZoomShortcut('));
  const options = create.slice(create.indexOf('const windowOptions ='), create.indexOf('\n  const win ='));
  const context = vm.createContext({
    bounds: { width: 400, height: 820 }, collapsedFloatingBubble: false,
    WINDOW_LIMITS: {}, settings: { zoomFactor: 1.4 }, process: { platform: 'win32' },
    appWindowIcon: () => ({}), skipTaskbarForSettings: () => false,
    floatingBubbleWindowChrome: () => ({}), clampZoom: value => value,
    path, __dirname: electronDir
  });
  const result = vm.runInContext(`${options}\nwindowOptions`, context);
  assert.equal(result.webPreferences.zoomFactor, 1.4);
});
