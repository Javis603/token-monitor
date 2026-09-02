'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  macActivationPolicyMode,
  mainWindowCloseAction,
  normalizeTrayModeSettings,
  shouldCreateTray,
  skipTaskbarForSettings,
  trayToggleAction
} = require('../../src/electron/trayModeSettings');

test('defaults to a visible tray icon without tray-only mode', () => {
  assert.deepEqual(normalizeTrayModeSettings({}), {
    showTrayIcon: true,
    trayMode: false,
    hideAppIcon: false
  });
});

test('keeps tray-only available only when the tray icon is visible', () => {
  assert.deepEqual(normalizeTrayModeSettings({ showTrayIcon: true, trayMode: true }), {
    showTrayIcon: true,
    trayMode: true,
    hideAppIcon: false
  });
  assert.deepEqual(normalizeTrayModeSettings({ showTrayIcon: false, trayMode: true }), {
    showTrayIcon: false,
    trayMode: false,
    hideAppIcon: false
  });
});

test('preserves older configs without an explicit tray icon setting', () => {
  assert.deepEqual(normalizeTrayModeSettings({ trayMode: true }), {
    showTrayIcon: true,
    trayMode: true,
    hideAppIcon: false
  });
});

test('drops the hidden app icon when nothing is left in the tray', () => {
  assert.deepEqual(normalizeTrayModeSettings({ showTrayIcon: true, hideAppIcon: true }), {
    showTrayIcon: true,
    trayMode: false,
    hideAppIcon: true
  });
  // A hand-edited settings.json must not be able to strand a background window
  // with no Dock/taskbar entry and no tray icon to bring it back.
  assert.deepEqual(normalizeTrayModeSettings({ showTrayIcon: false, hideAppIcon: true }), {
    showTrayIcon: false,
    trayMode: false,
    hideAppIcon: false
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

test('keeps the Dock icon hidden while the window is visible', () => {
  // focusExistingWindow() and openMainWindowFromWidget() both assert
  // mainWindowVisible: true, so hideAppIcon has to win over that branch or the
  // Dock icon returns on the first tray click.
  assert.equal(macActivationPolicyMode({ showTrayIcon: true, hideAppIcon: true }, { mainWindowVisible: true }), 'accessory');
  assert.equal(macActivationPolicyMode({ showTrayIcon: false, hideAppIcon: true }, { mainWindowVisible: true }), 'regular');
});

test('skips the taskbar entry for either hiding mode', () => {
  assert.equal(skipTaskbarForSettings({ showTrayIcon: true, trayMode: true }), true);
  assert.equal(skipTaskbarForSettings({ showTrayIcon: true, hideAppIcon: true }), true);
  assert.equal(skipTaskbarForSettings({ showTrayIcon: true }), false);
  assert.equal(skipTaskbarForSettings({ showTrayIcon: false, hideAppIcon: true }), false);
});

test('maps main-window close to the platform-appropriate background behavior', () => {
  assert.equal(mainWindowCloseAction({ showTrayIcon: true, trayMode: true }, { platform: 'darwin' }), 'hidePopover');
  assert.equal(mainWindowCloseAction({ showTrayIcon: true, trayMode: false }, { platform: 'darwin' }), 'hideWindow');
  assert.equal(mainWindowCloseAction({ showTrayIcon: false, trayMode: false }, { platform: 'darwin' }), 'closeWindow');
  assert.equal(mainWindowCloseAction({ showTrayIcon: true, trayMode: false }, { platform: 'win32' }), 'hideWindow');
  assert.equal(mainWindowCloseAction({ showTrayIcon: false, trayMode: false }, { platform: 'win32' }), 'closeWindow');
});
