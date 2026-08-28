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

test('an unchanged material preference does not re-apply to the Dashboard', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const applyMaterial = main.slice(
    main.indexOf('function applyNativeMaterial(source = settings)'),
    main.indexOf('function createWindow(')
  );

  // applyNativeMaterial() runs on every floating-bubble collapse/expand, which
  // carries no information about the Dashboard.
  assert.match(
    applyMaterial,
    /dashboardWindowNativeBlurEnabled !== enabled\) \{\s*dashboardWindowNativeBlurEnabled = enabled;\s*syncNativeMaterialVisibility\(dashboardWindow, enabled\);/
  );
});

test('main and Dashboard windows use the visibility-aware material lifecycle', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  assert.equal([...main.matchAll(/attachNativeMaterialVisibility\(win,/g)].length, 2);
  // Electron has no setVisualEffectState, so 'active' can only be set at
  // construction. Losing it makes macOS fall back to followWindow, which greys
  // the glass out whenever the window is not key.
  assert.equal([...main.matchAll(/visualEffectState: 'active'/g)].length, 2);
  assert.doesNotMatch(main, /\.setVisualEffectState\(/);
  assert.equal([...main.matchAll(/syncNativeMaterialVisibility\((?:mainWindow|dashboardWindow),/g)].length, 2);
});
