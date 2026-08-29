'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  attachNativeMaterialVisibility,
  syncNativeMaterialVisibility
} = require('../../src/electron/nativeMaterialVisibility');

function fakeWindow() {
  const listeners = new Map();
  const materials = [];
  let visible = false;
  let minimized = false;
  return {
    emit(event) { listeners.get(event)?.(); },
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isVisible: () => visible,
    materials,
    on(event, callback) { listeners.set(event, callback); },
    setMinimized(value) { minimized = value; },
    setVisible(value) { visible = value; },
    setVibrancy(value) { materials.push(value); }
  };
}

test('native material is active only for a visible non-minimized macOS window', () => {
  const win = fakeWindow();
  win.setVisible(true);
  syncNativeMaterialVisibility(win, true, 'darwin');
  win.setVisible(false);
  syncNativeMaterialVisibility(win, true, 'darwin');
  win.setVisible(true);
  win.setMinimized(true);
  syncNativeMaterialVisibility(win, true, 'darwin');
  syncNativeMaterialVisibility(win, true, 'win32');

  assert.deepEqual(win.materials, ['hud', null, null]);
});

test('window lifecycle suspends and restores the latest material preference', () => {
  const win = fakeWindow();
  let enabled = true;
  attachNativeMaterialVisibility(win, () => enabled, 'darwin');

  win.setVisible(true);
  win.emit('show');
  win.setVisible(false);
  win.emit('hide');
  enabled = false;
  win.setVisible(true);
  win.emit('restore');

  assert.deepEqual(win.materials, ['hud', null, null]);
});

test('an unchanged material preference does not re-apply to either window', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const applyMaterial = main.slice(
    main.indexOf('function applyNativeMaterial(source = settings)'),
    main.indexOf('function withHistoryPreview(')
  );

  // applyNativeMaterial() also runs for every appearance slider preview and
  // floating-bubble transition; neither should rebuild an unchanged effect.
  assert.match(
    applyMaterial,
    /mainWindowNativeBlurEnabled !== enabled\) \{\s*mainWindowNativeBlurEnabled = enabled;\s*syncNativeMaterialVisibility\(mainWindow, enabled\);/
  );
  assert.match(
    applyMaterial,
    /dashboardWindowNativeBlurEnabled !== enabled\) \{\s*dashboardWindowNativeBlurEnabled = enabled;\s*syncNativeMaterialVisibility\(dashboardWindow, enabled\);/
  );
});

test('main and Dashboard windows use the visibility-aware material lifecycle', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const mainWindowConstructor = main.slice(
    main.indexOf('function createWindow('),
    main.indexOf('function handleZoomShortcut(')
  );
  const dashboardWindowConstructor = main.slice(
    main.indexOf('function createDashboardWindow('),
    main.indexOf('async function getDashboardHistory(')
  );
  assert.equal([...main.matchAll(/attachNativeMaterialVisibility\(win,/g)].length, 2);
  // Electron has no setVisualEffectState, so 'active' can only be set at
  // construction. Both windows must retain that construction-time capability
  // even when system glass starts disabled and is enabled later at runtime.
  for (const constructor of [mainWindowConstructor, dashboardWindowConstructor]) {
    assert.match(
      constructor,
      /process\.platform === 'darwin' \? \{ vibrancy: 'hud', visualEffectState: 'active' \} : \{\}/
    );
  }
  assert.match(mainWindowConstructor, /mainWindow = win;\s*mainWindowNativeBlurEnabled = null;/);
  assert.doesNotMatch(main, /\.setVisualEffectState\(/);
  assert.equal([...main.matchAll(/syncNativeMaterialVisibility\((?:mainWindow|dashboardWindow),/g)].length, 2);
});
