'use strict';

(function exposeWindowShortcut(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorWindowShortcut = api;
})(typeof window !== 'undefined' ? window : null, function createWindowShortcutApi() {
  const MODIFIER_ALIASES = new Map([
    ['cmdorctrl', 'CommandOrControl'],
    ['cmdorcontrol', 'CommandOrControl'],
    ['commandorcontrol', 'CommandOrControl'],
    ['command', 'Command'],
    ['cmd', 'Command'],
    ['ctrl', 'Control'],
    ['control', 'Control'],
    ['alt', 'Alt'],
    ['option', 'Alt'],
    ['shift', 'Shift'],
    ['super', 'Super'],
    ['meta', 'Super']
  ]);
  const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift', 'Super'];
  const PRIMARY_MODIFIERS = new Set(['CommandOrControl', 'Command', 'Control', 'Alt', 'Super']);
  const NAMED_KEYS = new Set([
    'Space', 'Tab', 'Enter',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
    'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24'
  ]);

  function platformId(platform = '') {
    const raw = String(platform || '').toLowerCase();
    if (raw.includes('mac') || raw === 'darwin') return 'darwin';
    if (raw.includes('win')) return 'win32';
    return raw;
  }

  function normalizeKey(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const upper = raw.toUpperCase();
    if (/^[A-Z0-9]$/.test(upper)) return upper;
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(upper)) return upper;
    const lower = raw.toLowerCase();
    if (lower === 'space' || raw === ' ') return 'Space';
    if (lower === 'tab') return 'Tab';
    if (lower === 'enter' || lower === 'return') return 'Enter';
    return NAMED_KEYS.has(raw) ? raw : '';
  }

  function keyFromEvent(event = {}) {
    const code = String(event.code || '');
    if (code === 'Escape') return 'Escape';
    if (code === 'Backspace') return 'Backspace';
    if (code === 'Delete') return 'Delete';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    if (code === 'Space') return 'Space';
    if (code === 'Tab') return 'Tab';
    if (code === 'Enter' || code === 'NumpadEnter') return 'Enter';
    return normalizeKey(event.key);
  }

  function normalizeModifier(value) {
    return MODIFIER_ALIASES.get(String(value || '').trim().toLowerCase()) || '';
  }

  function uniqueOrderedModifiers(values) {
    const set = new Set(values.map(normalizeModifier).filter(Boolean));
    return MODIFIER_ORDER.filter((modifier) => set.has(modifier));
  }

  function hasPrimaryModifier(modifiers) {
    return modifiers.some((modifier) => PRIMARY_MODIFIERS.has(modifier));
  }

  function normalizeWindowToggleShortcut(value, fallback = '') {
    const source = String(value || '').trim();
    if (!source) return '';
    const parts = source.split('+').map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) return normalizeWindowToggleShortcut(fallback);
    const key = normalizeKey(parts[parts.length - 1]);
    const modifiers = uniqueOrderedModifiers(parts.slice(0, -1));
    if (!key || !hasPrimaryModifier(modifiers)) return normalizeWindowToggleShortcut(fallback);
    return [...modifiers, key].join('+');
  }

  function shortcutModifiersFromEvent(event = {}, platform = '') {
    const modifiers = [];
    const currentPlatform = platformId(platform);
    if (event.metaKey) modifiers.push(currentPlatform === 'darwin' ? 'CommandOrControl' : 'Super');
    if (event.ctrlKey) modifiers.push(currentPlatform === 'darwin' ? 'Control' : 'CommandOrControl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    return uniqueOrderedModifiers(modifiers);
  }

  function windowToggleShortcutFromEvent(event = {}, platform = '') {
    const key = keyFromEvent(event);
    if (key === 'Escape') return { action: 'cancel' };
    const modifiers = shortcutModifiersFromEvent(event, platform);
    if ((key === 'Backspace' || key === 'Delete') && modifiers.length === 0) {
      return { action: 'clear', shortcut: '' };
    }
    if (!key || !hasPrimaryModifier(modifiers)) return { action: 'invalid', reason: 'modifierRequired' };
    const shortcut = normalizeWindowToggleShortcut([...modifiers, key].join('+'));
    return shortcut ? { action: 'record', shortcut } : { action: 'invalid', reason: 'unsupportedKey' };
  }

  // Accelerators are stored portably (CommandOrControl, Alt), so the label has
  // to follow the platform the user is on. Without one, show both spellings.
  function formatWindowToggleShortcut(shortcut, offLabel = 'Off', platform = '') {
    const normalized = normalizeWindowToggleShortcut(shortcut);
    if (!normalized) return offLabel;
    const current = platform ? platformId(platform) : '';
    const labels = {
      CommandOrControl: !current ? 'Cmd/Ctrl' : current === 'darwin' ? 'Cmd' : 'Ctrl',
      Command: 'Cmd',
      Control: 'Ctrl',
      Alt: !current ? 'Alt/Option' : current === 'darwin' ? 'Option' : 'Alt',
      Super: current === 'win32' ? 'Win' : 'Super'
    };
    return normalized
      .split('+')
      .map((part) => labels[part] || part)
      .join('+');
  }

  function windowToggleShortcutStatus(shortcut, registered) {
    const normalized = normalizeWindowToggleShortcut(shortcut);
    if (!normalized) return { shortcut: '', state: 'off' };
    return {
      shortcut: normalized,
      state: registered === true ? 'registered' : 'unregistered'
    };
  }

  function windowToggleShortcutAction(state = {}) {
    if (state.trayMode === true) return 'togglePopover';
    if (state.floatingBubbleCollapsed === true) return 'expandFloatingBubble';
    if (state.visible === true && state.minimized !== true) return 'hideWindow';
    return 'focusExistingWindow';
  }

  return {
    formatWindowToggleShortcut,
    normalizeWindowToggleShortcut,
    windowToggleShortcutAction,
    windowToggleShortcutFromEvent,
    windowToggleShortcutStatus
  };
});
