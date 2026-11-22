'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { popoverToggleAction, trayToggleAction } = require('../../src/electron/trayModeSettings');
const { windowToggleShortcutAction } = require('../../src/electron/windowShortcut');

const electronDir = path.join(__dirname, '../../src/electron');
const main = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8');
const section = (first, next) => main.slice(main.indexOf(first), main.indexOf(next, main.indexOf(first)));

function fixture(platform = 'linux') {
  const timers = new Set();
  const windows = new Set();
  const summons = [];
  const surfaceEvents = [];
  const app = new EventEmitter();
  const powerMonitor = new EventEmitter();
  let quits = 0;
  let trayPaints = 0;
  let mainWindowsCreated = 0;
  app.quit = () => { quits += 1; };
  class Window extends EventEmitter {
    constructor(options) {
      super();
      windows.add(this);
      this.options = options;
      this.visible = false;
      this.bounds = { width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.loadFile = (_file, loadOptions) => {
        this.query = loadOptions.query;
        return Promise.resolve();
      };
    }
    isDestroyed() { return !windows.has(this); }
    isVisible() { return this.visible; }
    isFocused() { return this.visible; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    show() { this.visible = true; if (!this.silentVisibility) this.emit('show'); }
    hide() { this.visible = false; if (!this.silentVisibility) this.emit('hide'); }
    isMinimized() { return false; }
    setBackgroundColor(color) { this.backgroundColors = [...(this.backgroundColors || []), color]; }
    destroy() {
      windows.delete(this);
      this.emit('closed');
      if (!windows.size) app.emit('window-all-closed');
    }
  }
  const controller = kind => ({
    owns: win => win.kind === kind,
    setAppearance() {},
    stop(options = {}) {
      surfaceEvents.push(`${kind}:stop${options.preserveSummary ? ':preserveSummary' : ''}`);
      for (const win of windows) if (this.owns(win)) win.destroy();
    },
    sync() {
      surfaceEvents.push(`${kind}:sync`);
      const win = new Window({});
      win.kind = kind;
    }
  });
  const edgeDockController = controller('dock');
  const notchController = {
    ...controller('notch'),
    setLocked: value => surfaceEvents.push(`notch:locked:${value}`)
  };
  const context = vm.createContext({
    app, powerMonitor, path, console, __dirname: electronDir, process: { platform },
    mainWindow: null, quitRequested: false, lastRendererStatsFingerprint: 'old',
    settings: { trayMode: true, showTrayIcon: true, notchEnabled: true, zoomFactor: 1.25 },
    BrowserWindow: class extends Window {
      constructor(options) { super(options); mainWindowsCreated += 1; }
    },
    BaseWindow: { getAllWindows: () => [...windows] },
    edgeDockController, notchController,
    limitsHistoryController: {
      isIdleWindow: win => win.kind === 'parked-history',
      hide() {},
      dispose() {
        for (const win of windows) if (this.isIdleWindow(win)) win.destroy();
      }
    },
    ensureTray: () => true, updateTrayDisplay() {},
    suspendWindowMaximized() {}, setWindowMaximizable() {},
    ensureEdgeDockController: () => edgeDockController,
    ensureNotchController: () => notchController,
    canUseEdgeDock: () => true, edgeDockAppearance() {}, edgeDockStats() {}, scheduleSessionExpiry() {},
    syncPluginQuotaSurfaceDemand() {}, dockAppearancePreview: null,
    ipcMain: new EventEmitter(),
    DEFAULT_WINDOW: { width: 340, height: 650 }, WINDOW_LIMITS: {},
    floatingBubbleState: { collapsed: false }, mainWindowChrome: {}, rendererViewState: { breakdown: 'limits' },
    tray: { isDestroyed: () => false, setTitle() {}, setToolTip() {}, setImage() { trayPaints += 1; } },
    recentPopoverBlur: null, suppressNextBlurHide: false,
    refreshTrayContextMenu() {}, desktopQuotaStats() {}, electronPresentationStats() {}, latestStats: null,
    normalizeCurrency() {}, compactTokenDisplayOptions() {}, formatTrayText: () => '0',
    isBarsTrayIconMode: () => false, providerTrayIcons: {}, trayShowsTitle: () => platform === 'darwin',
    pickUsageTrayIconId() {}, getDefaultTrayIcon() {},
    pluginWindowActions: { hide: win => win.hide() }, popoverToggleAction, trayToggleAction, windowToggleShortcutAction,
    activateWindowAction: () => 'none',
    rendererHiddenStatsNeeded: () => false, popoverBounds: (_tray, width, height, { clickPoint }) => ({ width, height, x: clickPoint?.x }),
    restoredBounds: () => ({ width: 420, height: 660 }),
    clampZoom: value => value, applyZoomFactor() {}, ensureSettingsLoaded() {}, skipTaskbarForSettings: () => true,
    createRetainedWindow: (_electron, options) => new Window(options), WebContentsView: {},
    refreshWindowsBackdrop() {}, stopFloatingBubbleAutoCollapseTimer() {},
    appWindowIcon: () => ({}), floatingBubbleWindowChrome: () => ({}),
    floatingBubbleInitialRendererQuery: (_state, { viewState }) => ({ breakdown: viewState.breakdown }),
    applyMacActivationPolicy() {}, applyMacSpaceBehavior() {}, applyWindowsChrome() {}, suppressLinuxSystemContextMenu() {},
    applyWindowSettings() {}, attachNativeMaterialVisibility() {}, applyNativeMaterial() {},
    syncTaskbarZOrder() {}, stopTaskbarZOrderKeeper() {}, syncPluginWindowVisibility() {}, handleZoomShortcut() {},
    scheduleMainWindowShowSync() {}, sendFloatingBubbleState() {}, sendMainWindowVisibility() {},
    restoreWindowMaximizedForReveal: () => false, revealWindow: win => win.show(),
    sendMainWindowEvent: channel => summons.push(channel),
    setTimeout(callback, ms) {
      const timer = { callback, ms, unref() { this.unrefed = true; } };
      timers.add(timer);
      return timer;
    },
    clearTimeout: timer => timers.delete(timer)
  });
  vm.runInContext([
    section('const MAIN_WINDOW_HIBERNATE_MS', 'function stopPersistBoundsTimer('),
    section('function updateTrayDisplay(', 'function recordDiagnosticEvent('),
    section('function showPopover(', 'function currentWindowToggleShortcutStatus('),
    section('function syncNotch(', '// The dock renderer'),
    section('function syncDockSurfaces(', 'function sendStatsPresentationToRenderer('),
    section('function handleWindowToggleShortcut(', 'function trayMenuLocale('),
    section('function enterTrayMode(', 'function exitTrayMode()'),
    section('function loadWindowFile(', 'function handleZoomShortcut('),
    section("app.on('activate',", '  startPluginRuntime();'),
    section('function suspendScreenUi(', 'app.whenReady().then('),
    section("powerMonitor.on('lock-screen', suspendScreenUi)", 'void sessionProxy.apply()'),
    section("app.on('second-instance'", '// Every window shares')
  ].join('\n'), context);
  context.createWindow();
  const original = context.mainWindow;
  return {
    context, original, windows, summons, app, powerMonitor, surfaceEvents, quits: () => quits,
    trayPaints: () => trayPaints, mainWindowsCreated: () => mainWindowsCreated,
    suspended: () => vm.runInContext('screenUiSuspended', context),
    addWindow(kind) {
      const win = new Window({});
      win.kind = kind;
      return win;
    },
    timer: ms => [...timers].find(timer => timer.ms === ms),
    fire(ms) {
      const timer = this.timer(ms);
      assert.ok(timer, `expected a ${ms} ms timer`);
      timers.delete(timer);
      timer.callback();
    }
  };
}

const HIBERNATE_MS = 600_000;
const RETRY_MS = 60_000;

test('screen lock destroys the tray UI and unlock rebuilds the dock and notch while keeping main hibernated', () => {
  const run = fixture('darwin');
  const { context, original, powerMonitor } = run;
  for (const kind of ['dock', 'notch', 'parked-history']) run.addWindow(kind);
  original.hide();
  assert.ok(run.timer(HIBERNATE_MS));
  context.rendererHiddenStatsNeeded = () => true;
  powerMonitor.emit('lock-screen');
  assert.equal(run.suspended(), true);
  assert.equal(run.timer(HIBERNATE_MS), undefined);
  assert.equal(original.isDestroyed(), true);
  assert.equal(context.mainWindow, null);
  assert.equal(run.windows.size, 0);
  assert.deepEqual(run.surfaceEvents, ['notch:locked:true', 'dock:stop', 'notch:stop:preserveSummary']);

  powerMonitor.emit('unlock-screen');
  assert.equal(run.suspended(), false);
  assert.equal(context.mainWindow, null);
  assert.equal(run.trayPaints(), 1);
  assert.deepEqual(run.surfaceEvents.slice(3), ['notch:locked:false', 'notch:sync', 'dock:sync']);
  assert.deepEqual([...run.windows].map(win => win.kind), ['notch', 'dock']);
  context.updateTrayDisplay();
  assert.ok(context.mainWindow, 'live artwork can resume on the next ordinary tray update');
  assert.equal(context.mainWindow.isVisible(), false);
});

test('a macOS main window rebuilt after screen lock restores its transparent canvas before reveal', () => {
  const run = fixture('darwin');
  const { context, powerMonitor } = run;
  for (const kind of ['dock', 'notch']) run.addWindow(kind);
  powerMonitor.emit('lock-screen');
  powerMonitor.emit('unlock-screen');
  context.handleTrayToggle(null, { x: 35 }, false, false, true);
  const next = context.mainWindow;
  assert.equal(next.backgroundColors, undefined);
  next.webContents.emit('did-finish-load');
  assert.deepEqual(next.backgroundColors, ['#00000000']);
  assert.equal(next.visible, false);
  context.ipcMain.emit('window:appearanceReady', { sender: next.webContents });
  assert.equal(next.visible, true);
  next.webContents.emit('did-finish-load');
  assert.deepEqual(next.backgroundColors, ['#00000000', '#00000000'], 'a reload restores it again');
});

test('a dependent window preserves the UI and keeps the existing Notch lock behavior', () => {
  for (const kind of ['dashboard', 'limits-history', 'plugin-page']) {
    const run = fixture('darwin');
    run.addWindow(kind);
    run.powerMonitor.emit('lock-screen');
    assert.equal(run.suspended(), false, kind);
    assert.equal(run.context.mainWindow, run.original, kind);
    run.powerMonitor.emit('unlock-screen');
    assert.deepEqual(run.surfaceEvents, ['notch:locked:true', 'notch:locked:false'], kind);
    assert.equal(run.trayPaints(), 0, kind);
  }
});

test('tray updates, settings sync and show entry points do not recreate pages while suspended', () => {
  const run = fixture('darwin');
  const { context } = run;
  run.original.show();
  run.powerMonitor.emit('lock-screen');
  assert.equal(run.original.isVisible(), false);
  context.rendererHiddenStatsNeeded = () => true;
  context.updateTrayDisplay();
  context.syncDockSurfaces();
  context.showPopover();
  context.focusExistingWindow();
  context.handleTrayToggle();
  context.handleWindowToggleShortcut();
  run.app.emit('activate');
  run.app.emit('second-instance');
  assert.equal(run.mainWindowsCreated(), 1);
  assert.equal(run.windows.size, 0);
  assert.equal(context.mainWindow, null);

  run.powerMonitor.emit('unlock-screen');
  context.handleTrayToggle();
  assert.equal(run.mainWindowsCreated(), 2);
  const next = context.mainWindow;
  context.ipcMain.emit('window:appearanceReady', { sender: next.webContents });
  assert.equal(next.isVisible(), true);
});

test('screen lock skips Windows and Linux tray mode and macOS non-tray mode', () => {
  for (const [platform, trayMode] of [['win32', true], ['linux', true], ['darwin', false]]) {
    const run = fixture(platform);
    run.context.settings.trayMode = trayMode;
    run.original.show();
    run.powerMonitor.emit('lock-screen');
    run.powerMonitor.emit('unlock-screen');
    assert.equal(run.suspended(), false, platform);
    assert.equal(run.context.mainWindow, run.original, platform);
    assert.equal(run.original.isVisible(), true, platform);
    assert.deepEqual(run.surfaceEvents, ['notch:locked:true', 'notch:locked:false'], platform);
  }
});

test('explicit popover hide and show manage the timer without native visibility events', () => {
  const run = fixture('darwin');
  run.original.silentVisibility = true;
  run.original.visible = true;
  run.context.hidePopover();
  assert.ok(run.timer(HIBERNATE_MS));
  run.context.showPopover();
  assert.equal(run.timer(HIBERNATE_MS), undefined);
});

test('native hide re-arms an unrefed one-shot and showing, focusing or restoring cancels it', () => {
  for (const cancel of ['show', 'focus', 'restore', 'replacement']) {
    const run = fixture();
    assert.equal(run.timer(HIBERNATE_MS)?.unrefed, true, 'tray startup arms hibernation');
    run.original.show();
    assert.equal(run.timer(HIBERNATE_MS), undefined, 'show cancels startup hibernation');
    run.original.hide();
    assert.equal(run.timer(HIBERNATE_MS)?.unrefed, true);
    if (cancel === 'replacement') {
      run.context.createWindow();
      assert.ok(run.timer(HIBERNATE_MS), 'the replacement arms its own startup timer');
    } else {
      run.original.emit(cancel);
      assert.equal(run.timer(HIBERNATE_MS), undefined, cancel);
    }
  }
});

test('a tray window that is never shown still hibernates after the quiet period', () => {
  const run = fixture();
  assert.equal(run.timer(HIBERNATE_MS)?.unrefed, true);
  run.fire(HIBERNATE_MS);
  assert.equal(run.original.isDestroyed(), true);
  assert.equal(run.context.mainWindow, null);
});

test('a background-only recreation arms hibernation for the replacement', () => {
  const run = fixture();
  run.original.hide();
  run.fire(HIBERNATE_MS);
  assert.equal(run.context.mainWindow, null);
  run.context.createWindow(undefined, { popoverReveal: { requested: false } });
  assert.equal(run.context.mainWindow.isVisible(), false);
  assert.equal(run.timer(HIBERNATE_MS)?.unrefed, true);
  run.fire(HIBERNATE_MS);
  assert.equal(run.context.mainWindow, null);
});

test('hibernate rechecks eligibility and retains the renderer for live tray artwork', () => {
  for (const change of [
    run => { run.original.visible = true; },
    run => { run.context.settings.trayMode = false; },
    run => { run.context.quitRequested = true; },
    run => { run.context.rendererHiddenStatsNeeded = () => true; },
    ...['dashboard', 'limits-history', 'plugin-page'].map(kind => run => run.windows.add({ kind }))
  ]) {
    const run = fixture();
    run.original.hide();
    change(run);
    run.fire(HIBERNATE_MS);
    assert.equal(run.original.isDestroyed(), false);
    assert.equal(run.context.mainWindow, run.original);
    assert.equal(run.timer(HIBERNATE_MS), undefined);
  }
  const win = fixture('win32');
  win.original.hide();
  assert.equal(win.timer(HIBERNATE_MS), undefined);
});

test('a temporary dependent window re-arms hibernation and releases it when closed', () => {
  const run = fixture();
  const blocker = { kind: 'dashboard' };
  run.windows.add(blocker);
  run.original.hide();
  run.fire(HIBERNATE_MS);
  assert.equal(run.original.isDestroyed(), false);
  assert.ok(run.timer(RETRY_MS));
  run.windows.delete(blocker);
  run.fire(RETRY_MS);
  assert.equal(run.original.isDestroyed(), true);
  assert.equal(run.context.mainWindow, null);
});

test('switching an already-hidden window to tray mode arms hibernation', () => {
  const run = fixture();
  run.context.cancelMainWindowHibernate();
  run.context.settings.trayMode = false;
  // Electron emits no hide event for a window that is already hidden.
  run.original.silentVisibility = true;
  run.original.visible = false;
  run.context.settings.trayMode = true;
  run.context.enterTrayMode();
  assert.equal(run.original.isVisible(), false);
  assert.equal(run.timer(HIBERNATE_MS)?.unrefed, true);
});

test('activate wakes a hibernated window before the remaining-window filter', () => {
  const run = fixture();
  run.original.hide();
  run.fire(HIBERNATE_MS);
  assert.equal(run.context.mainWindow, null);
  run.context.app.emit('activate');
  assert.ok(run.context.mainWindow && !run.context.mainWindow.isDestroyed());
  assert.equal(run.context.mainWindow.query.hibernateReveal, '1');
});

test('theme changes invalidate cached provider tray icons while hibernated', () => {
  const updates = [];
  const context = vm.createContext({
    mainWindow: null,
    mainWindowHibernated: true,
    currentSystemDarkUi: null,
    currentSystemDarkTrayUi: () => true,
    providerTrayIcons: { bars: { image: 1 }, custom: { image: 2 } },
    defaultTrayIcon: { image: 3 },
    updateTrayDisplay: () => updates.push('update')
  });
  const fn = main.slice(main.indexOf('function pushSystemUiThemeToRenderer'), main.indexOf('// Windows cannot answer'));
  vm.runInContext(`${fn}\npushSystemUiThemeToRenderer(true);`, context);
  assert.deepEqual(Object.keys(context.providerTrayIcons), []);
  assert.equal(context.defaultTrayIcon, null);
  assert.deepEqual(updates, ['update']);
});

test('hibernate destroys just the hidden main window and keeps Linux running with or without other surfaces', () => {
  for (const surfaces of [[], [{ kind: 'dock' }, { kind: 'notch' }, { kind: 'parked-history' }]]) {
    const run = fixture();
    for (const win of surfaces) run.windows.add(win);
    run.original.once('close', () => assert.fail('destroy must bypass the close-to-hide handler'));
    run.original.hide();
    run.fire(HIBERNATE_MS);
    assert.equal(run.original.isDestroyed(), true);
    assert.equal(run.context.mainWindow, null);
    assert.deepEqual([...run.windows], surfaces);
    assert.equal(run.quits(), 0);
  }
});

for (const route of ['tray', 'shortcut', 'focus']) {
  test(`${route} recreates a hibernated window and reveals on its own appearance signal`, () => {
    const run = fixture();
    const { context } = run;
    run.original.hide();
    run.fire(HIBERNATE_MS);
    const open = route === 'tray' ? () => context.handleTrayToggle(null, { x: 35 }, false, false, true)
      : route === 'shortcut' ? context.handleWindowToggleShortcut : context.focusExistingWindow;
    open();
    const next = context.mainWindow;
    open();
    assert.equal(context.mainWindow, next, 'repeated wake requests reuse the loading window');
    assert.notEqual(next, run.original);
    assert.equal(next.options.webPreferences.zoomFactor, 1.25);
    assert.equal(next.query.breakdown, 'limits');
    assert.equal(next.query.windowHidden, '1');
    assert.equal(next.query.hibernateReveal, '1');
    next.webContents.emit('did-finish-load');
    context.ipcMain.emit('window:appearanceReady', { sender: {} });
    assert.equal(next.visible, false);
    context.ipcMain.emit('window:appearanceReady', { sender: next.webContents });
    assert.equal(next.visible, true);
    assert.equal(next.bounds.width, 420);
    if (route === 'tray') assert.equal(next.bounds.x, 35);
    assert.deepEqual(run.summons, route === 'focus' ? [] : ['window:summoned']);
    assert.equal(run.timer(800), undefined);
  });
}

test('a wake without an appearance signal falls back in 800 ms', () => {
  const run = fixture();
  run.original.hide();
  run.fire(HIBERNATE_MS);
  run.context.focusExistingWindow();
  const next = run.context.mainWindow;
  assert.equal(next.visible, false);
  run.fire(800);
  assert.equal(next.visible, true);
  assert.equal(run.context.ipcMain.listenerCount('window:appearanceReady'), 0);
});
