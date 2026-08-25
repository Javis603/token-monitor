'use strict';

function syncNativeMaterialVisibility(win, enabled, platform = process.platform) {
  if (!win || win.isDestroyed?.() || platform !== 'darwin') return;
  const active = Boolean(enabled) && win.isVisible() && !win.isMinimized();
  if (!active) win.setVisualEffectState?.('inactive');
  win.setVibrancy?.(active ? 'hud' : null);
  if (active) win.setVisualEffectState?.('active');
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
