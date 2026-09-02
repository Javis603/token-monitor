'use strict';

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

// hideAppIcon and trayMode both collapse to false without a tray icon: losing
// the Dock/taskbar entry while nothing is left in the menu bar or system tray
// would leave a background window with no way to focus or quit it. The DOM
// nests both controls under the tray toggle, but a hand-edited settings.json
// has to fail the same way, so the guard lives here rather than in the UI.
function normalizeTrayModeSettings(settings = {}) {
  const showTrayIcon = parseBoolean(settings.showTrayIcon, true);
  return {
    showTrayIcon,
    trayMode: showTrayIcon ? parseBoolean(settings.trayMode, false) : false,
    hideAppIcon: showTrayIcon ? parseBoolean(settings.hideAppIcon, false) : false
  };
}

// Windows/Linux counterpart of the accessory policy above; setSkipTaskbar() is
// a no-op on macOS.
function skipTaskbarForSettings(settings = {}) {
  const normalized = normalizeTrayModeSettings(settings);
  return normalized.trayMode || normalized.hideAppIcon;
}

function shouldCreateTray(settings = {}) {
  return normalizeTrayModeSettings(settings).showTrayIcon;
}

function trayToggleAction(settings = {}) {
  const normalized = normalizeTrayModeSettings(settings);
  if (!normalized.showTrayIcon) return 'none';
  return normalized.trayMode ? 'togglePopover' : 'focusWindow';
}

// macOS has no per-window taskbar entry, so hideAppIcon is expressed as the
// accessory activation policy (app.dock.hide()) instead of setSkipTaskbar().
// It has to be tested before the mainWindowVisible branch: focusExistingWindow()
// and openMainWindowFromWidget() both pass { mainWindowVisible: true }, and
// answering 'regular' there would pop the Dock icon back on the next tray click.
function macActivationPolicyMode(settings = {}, state = {}) {
  const normalized = normalizeTrayModeSettings(settings);
  if (normalized.trayMode) return 'accessory';
  if (normalized.hideAppIcon) return 'accessory';
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
  macActivationPolicyMode,
  mainWindowCloseAction,
  normalizeTrayModeSettings,
  shouldCreateTray,
  skipTaskbarForSettings,
  trayToggleAction
};
