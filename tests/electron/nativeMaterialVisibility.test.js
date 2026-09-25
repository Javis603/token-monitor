'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  attachNativeMaterialVisibility,
  syncNativeMaterialVisibility,
  getNativeMaterialState
} = require('../../src/electron/nativeMaterialVisibility');

function fakeWindow() {
  const listeners = new Map();
  const materials = [];
  let visible = false;
  let minimized = false;
  return {
    emit(event) { listeners.get(event)?.(); },
    webContents: { isDestroyed: () => false, send() {}, on() {} },
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
  syncNativeMaterialVisibility(win, true, 'darwin', { osRelease: '24.0.0' });
  win.setVisible(false);
  syncNativeMaterialVisibility(win, true, 'darwin', { osRelease: '24.0.0' });
  win.setVisible(true);
  win.setMinimized(true);
  syncNativeMaterialVisibility(win, true, 'darwin', { osRelease: '24.0.0' });
  syncNativeMaterialVisibility(win, true, 'win32');

  assert.deepEqual(win.materials, ['hud', null]);
});

test('window lifecycle suspends and restores the latest material preference', () => {
  const win = fakeWindow();
  let enabled = true;
  attachNativeMaterialVisibility(win, () => enabled, 'darwin', { osRelease: '24.0.0' });

  win.setVisible(true);
  win.emit('show');
  win.setVisible(false);
  win.emit('hide');
  enabled = false;
  win.setVisible(true);
  win.emit('restore');

  assert.deepEqual(win.materials, ['hud', null]);
});

test('an unchanged material preference does not recreate its native container', () => {
  const win = fakeWindow();
  let creations = 0;
  let disposals = 0;
  const deps = {
    osRelease: '26.0.0',
    createGlass() {
      creations += 1;
      return { update() {}, dispose() { disposals += 1; } };
    }
  };
  win.setVisible(true);
  syncNativeMaterialVisibility(win, { enabled: true }, 'darwin', deps);
  syncNativeMaterialVisibility(win, { enabled: true, dark: false }, 'darwin', deps);
  win.setVisible(false);
  syncNativeMaterialVisibility(win, { enabled: true }, 'darwin', deps);
  assert.equal(creations, 1);
  assert.equal(getNativeMaterialState(win).type, 'liquid-glass');
  assert.equal(disposals, 0);
  syncNativeMaterialVisibility(win, { enabled: false }, 'darwin', deps);
  assert.equal(disposals, 1);
});

test('failed native initialization reports the fallback instead of claiming Liquid Glass', (t) => {
  t.mock.method(console, 'warn', () => {});
  const win = fakeWindow();
  win.setVisible(true);
  syncNativeMaterialVisibility(win, { enabled: true }, 'darwin', {
    osRelease: '25.0.0',
    createGlass() { throw new Error('bridge initialization failed'); }
  });
  assert.deepEqual(win.materials, [null, 'hud']);
  assert.equal(getNativeMaterialState(win).type, 'vibrancy');
  assert.equal(getNativeMaterialState(win).fallbackReason, 'bridge initialization failed');
});

test('a throwing native cleanup still publishes the HUD fallback and keeps the original failure', (t) => {
  t.mock.method(console, 'warn', () => {});
  const win = fakeWindow();
  let creations = 0;
  const deps = {
    osRelease: '26.0.0',
    createGlass() {
      creations += 1;
      return {
        update() { throw new Error('appearance update failed'); },
        dispose() { throw new Error('removeFromSuperview failed'); }
      };
    }
  };
  win.setVisible(true);
  assert.doesNotThrow(() => syncNativeMaterialVisibility(win, { enabled: true }, 'darwin', deps));
  assert.deepEqual(win.materials, [null, 'hud']);
  assert.equal(getNativeMaterialState(win).type, 'vibrancy');
  assert.equal(getNativeMaterialState(win).fallbackReason, 'appearance update failed');
  syncNativeMaterialVisibility(win, { enabled: true }, 'darwin', deps);
  assert.equal(creations, 1);
});

test('a throwing cleanup on disable blocks recreation instead of stacking native views', (t) => {
  t.mock.method(console, 'warn', () => {});
  const win = fakeWindow();
  let creations = 0;
  const deps = {
    osRelease: '26.0.0',
    createGlass() {
      creations += 1;
      return { update() {}, dispose() { throw new Error('release failed'); } };
    }
  };
  win.setVisible(true);
  syncNativeMaterialVisibility(win, { enabled: true }, 'darwin', deps);
  assert.doesNotThrow(() => syncNativeMaterialVisibility(win, { enabled: true, opaque: true }, 'darwin', deps));
  assert.equal(getNativeMaterialState(win).type, 'opaque');
  syncNativeMaterialVisibility(win, { enabled: true }, 'darwin', deps);
  assert.equal(creations, 1);
  assert.equal(getNativeMaterialState(win).type, 'vibrancy');
  assert.equal(getNativeMaterialState(win).fallbackReason, 'release failed');
});

test('closing a window contains a throwing native cleanup', (t) => {
  t.mock.method(console, 'warn', () => {});
  const win = fakeWindow();
  const deps = {
    osRelease: '26.0.0',
    createGlass() {
      return { update() {}, dispose() { throw new Error('release failed'); } };
    }
  };
  win.setVisible(true);
  attachNativeMaterialVisibility(win, () => ({ enabled: true }), 'darwin', deps);
  win.emit('show');
  assert.equal(getNativeMaterialState(win).type, 'liquid-glass');
  assert.doesNotThrow(() => win.emit('closed'));
  assert.equal(getNativeMaterialState(win).type, 'transparent');
});

test('Reduce Transparency replaces only the system material, not the CSS glass', () => {
  const win = fakeWindow();
  const deps = { osRelease: '26.0.0', createGlass: () => ({ update() {}, dispose() {} }) };
  win.setVisible(true);
  syncNativeMaterialVisibility(win, { enabled: false, reducedTransparency: true }, 'darwin', deps);
  assert.equal(getNativeMaterialState(win).type, 'transparent');
  assert.equal(getNativeMaterialState(win).reducedTransparency, false);
  syncNativeMaterialVisibility(win, { enabled: true, reducedTransparency: true }, 'darwin', deps);
  assert.equal(getNativeMaterialState(win).type, 'opaque');
  assert.equal(getNativeMaterialState(win).reducedTransparency, true);
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
  assert.match(mainWindowConstructor, /attachNativeMaterialVisibility\(win, \(\) => nativeMaterialOptions\(\)\)/);
  assert.doesNotMatch(main, /\.setVisualEffectState\(/);
  assert.equal([...main.matchAll(/syncNativeMaterialVisibility\((?:mainWindow|dashboardWindow),/g)].length, 2);
});
