'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  formatWindowToggleShortcut,
  normalizeWindowToggleShortcut,
  windowToggleShortcutFromEvent,
  windowToggleShortcutAction,
  windowToggleShortcutStatus
} = require('../../src/electron/windowShortcut');

test('normalizes recorded window toggle shortcuts with off as the default', () => {
  assert.equal(normalizeWindowToggleShortcut(), '');
  assert.equal(normalizeWindowToggleShortcut(''), '');
  assert.equal(normalizeWindowToggleShortcut(' CmdOrCtrl + Shift + m '), 'CommandOrControl+Shift+M');
  assert.equal(normalizeWindowToggleShortcut('Ctrl+Alt+k'), 'Control+Alt+K');
  assert.equal(normalizeWindowToggleShortcut('Alt+Shift+M'), 'Alt+Shift+M');
  assert.equal(normalizeWindowToggleShortcut('Alt+F12'), 'Alt+F12');
  assert.equal(normalizeWindowToggleShortcut('M'), '');
  assert.equal(normalizeWindowToggleShortcut('Shift+M'), '');
  assert.equal(normalizeWindowToggleShortcut('CommandOrControl'), '');
});

test('describes shortcut registration status without losing user preference', () => {
  assert.deepEqual(windowToggleShortcutStatus('', false), { shortcut: '', state: 'off' });
  assert.deepEqual(windowToggleShortcutStatus('CommandOrControl+Shift+M', true), {
    shortcut: 'CommandOrControl+Shift+M',
    state: 'registered'
  });
  assert.deepEqual(windowToggleShortcutStatus('CommandOrControl+Shift+M', false), {
    shortcut: 'CommandOrControl+Shift+M',
    state: 'unregistered'
  });
});

test('builds shortcuts from recorded key events', () => {
  assert.deepEqual(windowToggleShortcutFromEvent({
    metaKey: true,
    shiftKey: true,
    key: 'm',
    code: 'KeyM'
  }, 'darwin'), { action: 'record', shortcut: 'CommandOrControl+Shift+M' });

  assert.deepEqual(windowToggleShortcutFromEvent({
    ctrlKey: true,
    shiftKey: true,
    key: ' ',
    code: 'Space'
  }, 'win32'), { action: 'record', shortcut: 'CommandOrControl+Shift+Space' });

  assert.deepEqual(windowToggleShortcutFromEvent({
    ctrlKey: true,
    altKey: true,
    key: 'k',
    code: 'KeyK'
  }, 'darwin'), { action: 'record', shortcut: 'Control+Alt+K' });

  assert.deepEqual(windowToggleShortcutFromEvent({
    metaKey: true,
    ctrlKey: true,
    key: 'k',
    code: 'KeyK'
  }, 'darwin'), { action: 'record', shortcut: 'CommandOrControl+Control+K' });

  assert.deepEqual(windowToggleShortcutFromEvent({ key: 'Escape', code: 'Escape' }), { action: 'cancel' });
  assert.deepEqual(windowToggleShortcutFromEvent({ key: 'Backspace', code: 'Backspace' }), { action: 'clear', shortcut: '' });
  assert.deepEqual(windowToggleShortcutFromEvent({ shiftKey: true, key: 'm', code: 'KeyM' }), { action: 'invalid', reason: 'modifierRequired' });
});

test('formats recorded shortcuts for display', () => {
  assert.equal(formatWindowToggleShortcut(''), 'Off');
  assert.equal(formatWindowToggleShortcut('CommandOrControl+Shift+M'), 'Cmd/Ctrl+Shift+M');
  assert.equal(formatWindowToggleShortcut('Control+Alt+K'), 'Ctrl+Alt/Option+K');
});

test('formats recorded shortcuts with the current platform labels', () => {
  assert.equal(formatWindowToggleShortcut('CommandOrControl+Alt+M', 'Off', 'darwin'), 'Cmd+Option+M');
  assert.equal(formatWindowToggleShortcut('CommandOrControl+Alt+M', 'Off', 'MacIntel'), 'Cmd+Option+M');
  assert.equal(formatWindowToggleShortcut('CommandOrControl+Alt+M', 'Off', 'win32'), 'Ctrl+Alt+M');
  assert.equal(formatWindowToggleShortcut('CommandOrControl+Alt+M', 'Off', 'linux'), 'Ctrl+Alt+M');
  assert.equal(formatWindowToggleShortcut('Control+Shift+K', 'Off', 'darwin'), 'Ctrl+Shift+K');
  assert.equal(formatWindowToggleShortcut('Super+K', 'Off', 'win32'), 'Win+K');
  assert.equal(formatWindowToggleShortcut('Super+K', 'Off', 'linux'), 'Super+K');
});

test('maps shortcut activation to the correct window action', () => {
  assert.equal(windowToggleShortcutAction({ trayMode: true, visible: true }), 'togglePopover');
  assert.equal(windowToggleShortcutAction({ floatingBubbleCollapsed: true, visible: true }), 'expandFloatingBubble');
  assert.equal(windowToggleShortcutAction({ visible: true, minimized: false }), 'hideWindow');
  assert.equal(windowToggleShortcutAction({ visible: true, minimized: true }), 'focusExistingWindow');
  assert.equal(windowToggleShortcutAction({ visible: false, minimized: false }), 'focusExistingWindow');
});
