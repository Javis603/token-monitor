'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  macTrayPopoverWorkspaceOptions,
  macActivationPolicyMode,
  mainWindowCloseAction,
  normalizeTrayModeSettings,
  shouldCreateTray,
  trayToggleAction
} = require('../../src/electron/trayModeSettings');

test('defaults to a visible tray icon without tray-only mode', () => {
  assert.deepEqual(normalizeTrayModeSettings({}), {
    showTrayIcon: true,
    trayMode: false
  });
});

test('keeps tray-only available only when the tray icon is visible', () => {
  assert.deepEqual(normalizeTrayModeSettings({ showTrayIcon: true, trayMode: true }), {
    showTrayIcon: true,
    trayMode: true
  });
  assert.deepEqual(normalizeTrayModeSettings({ showTrayIcon: false, trayMode: true }), {
    showTrayIcon: false,
    trayMode: false
  });
});

test('preserves older configs without an explicit tray icon setting', () => {
  assert.deepEqual(normalizeTrayModeSettings({ trayMode: true }), {
    showTrayIcon: true,
    trayMode: true
  });
});

test('creates the tray icon only when the setting is enabled', () => {
  assert.equal(shouldCreateTray({ showTrayIcon: true }), true);
  assert.equal(shouldCreateTray({ showTrayIcon: false }), false);
});

test('uses the tray icon as a window toggle unless tray-only mode is active', () => {
  assert.equal(trayToggleAction({ showTrayIcon: true, trayMode: false }), 'focusWindow');
  assert.equal(trayToggleAction({ showTrayIcon: true, trayMode: true }), 'togglePopover');
  assert.equal(trayToggleAction({ showTrayIcon: false, trayMode: true }), 'none');
});

test('uses accessory activation when macOS is running from the menu bar only', () => {
  assert.equal(macActivationPolicyMode({ showTrayIcon: true, trayMode: true }, { mainWindowVisible: true }), 'accessory');
  assert.equal(macActivationPolicyMode({ showTrayIcon: true, trayMode: false }, { mainWindowVisible: false }), 'accessory');
  assert.equal(macActivationPolicyMode({ showTrayIcon: true, trayMode: false }, { mainWindowVisible: true }), 'regular');
  assert.equal(macActivationPolicyMode({ showTrayIcon: false, trayMode: false }, { mainWindowVisible: false }), 'regular');
});

test('keeps the macOS tray popover visible across Spaces and fullscreen apps', () => {
  assert.deepEqual(macTrayPopoverWorkspaceOptions({ showTrayIcon: true, trayMode: true }, 'darwin'), {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });
  assert.equal(macTrayPopoverWorkspaceOptions({ showTrayIcon: true, trayMode: false }, 'darwin'), null);
  assert.equal(macTrayPopoverWorkspaceOptions({ showTrayIcon: true, trayMode: true }, 'win32'), null);
});

test('maps main-window close to the platform-appropriate background behavior', () => {
  assert.equal(mainWindowCloseAction({ showTrayIcon: true, trayMode: true }, { platform: 'darwin' }), 'hidePopover');
  assert.equal(mainWindowCloseAction({ showTrayIcon: true, trayMode: false }, { platform: 'darwin' }), 'hideWindow');
  assert.equal(mainWindowCloseAction({ showTrayIcon: false, trayMode: false }, { platform: 'darwin' }), 'closeWindow');
  assert.equal(mainWindowCloseAction({ showTrayIcon: true, trayMode: false }, { platform: 'win32' }), 'hideWindow');
  assert.equal(mainWindowCloseAction({ showTrayIcon: false, trayMode: false }, { platform: 'win32' }), 'closeWindow');
});
