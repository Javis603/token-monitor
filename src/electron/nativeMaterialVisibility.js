'use strict';

// Attaches or detaches the native material only. The active/inactive state of the
// material is a construction-time BrowserWindow property (visualEffectState);
// Electron ships no setVisualEffectState method, so calling one here would be a
// silent no-op that reads as if the state were being managed.
function syncNativeMaterialVisibility(win, enabled, platform = process.platform) {
  if (!win || win.isDestroyed?.() || platform !== 'darwin') return;
  const active = Boolean(enabled) && win.isVisible() && !win.isMinimized();
  win.setVibrancy?.(active ? 'hud' : null);
}

function attachNativeMaterialVisibility(win, isEnabled, platform = process.platform) {
  for (const event of ['show', 'restore']) {
    win.on(event, () => syncNativeMaterialVisibility(win, isEnabled(), platform));
  }
  for (const event of ['hide', 'minimize']) {
    win.on(event, () => syncNativeMaterialVisibility(win, false, platform));
  }
}

module.exports = {
  attachNativeMaterialVisibility,
  syncNativeMaterialVisibility
};
