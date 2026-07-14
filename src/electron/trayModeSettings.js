'use strict';

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeTrayModeSettings(settings = {}) {
  const showTrayIcon = parseBoolean(settings.showTrayIcon, true);
  return {
    showTrayIcon,
    trayMode: showTrayIcon ? parseBoolean(settings.trayMode, false) : false
  };
}

function shouldCreateTray(settings = {}) {
  return normalizeTrayModeSettings(settings).showTrayIcon;
}

function trayToggleAction(settings = {}) {
  const normalized = normalizeTrayModeSettings(settings);
  if (!normalized.showTrayIcon) return 'none';
  return normalized.trayMode ? 'togglePopover' : 'focusWindow';
}

function macTrayPopoverWorkspaceOptions(settings = {}, platform = process.platform) {
  const normalized = normalizeTrayModeSettings(settings);
  if (platform !== 'darwin' || !normalized.trayMode) return null;
  return {
    visibleOnFullScreen: true,
    // Tray mode already uses the accessory activation policy (UIElement on
    // macOS), so Electron does not need to briefly transform the process type.
    skipTransformProcessType: true
  };
}

function macActivationPolicyMode(settings = {}, state = {}) {
  const normalized = normalizeTrayModeSettings(settings);
  if (normalized.trayMode) return 'accessory';
  if (normalized.showTrayIcon && state.mainWindowVisible === false) return 'accessory';
  return 'regular';
}

function mainWindowCloseAction(settings = {}, _state = {}) {
  const normalized = normalizeTrayModeSettings(settings);
  if (normalized.trayMode) return 'hidePopover';
  if (normalized.showTrayIcon) return 'hideWindow';
  return 'closeWindow';
}

module.exports = {
  macTrayPopoverWorkspaceOptions,
  macActivationPolicyMode,
  mainWindowCloseAction,
  normalizeTrayModeSettings,
  shouldCreateTray,
  trayToggleAction
};
