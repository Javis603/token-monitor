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
  const states = [];
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
    setVibrancy(value) { materials.push(value); },
    setVisualEffectState(value) { states.push(value); },
    states
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
  assert.deepEqual(win.states, ['active', 'inactive', 'inactive']);
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
  assert.deepEqual(win.states, ['active', 'inactive', 'inactive']);
});

test('main and Dashboard windows use the visibility-aware material lifecycle', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  assert.equal([...main.matchAll(/attachNativeMaterialVisibility\(win,/g)].length, 2);
  assert.doesNotMatch(main, /vibrancy:\s*'hud'/);
  assert.equal([...main.matchAll(/syncNativeMaterialVisibility\((?:mainWindow|dashboardWindow),/g)].length, 2);
});
