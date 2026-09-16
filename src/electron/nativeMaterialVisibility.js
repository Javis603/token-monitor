'use strict';

const os = require('node:os');
const { createMacLiquidGlass } = require('./macLiquidGlass');

const windows = new WeakMap();

function entryFor(win) {
  let entry = windows.get(win);
  if (!entry) {
    entry = { glass: null, failed: null, vibrancy: undefined, state: null };
    windows.set(win, entry);
  }
  return entry;
}

function getNativeMaterialState(win) {
  return windows.get(win)?.state || {
    type: 'transparent', reducedTransparency: false, highContrast: false, fallbackReason: null
  };
}

function syncNativeMaterialVisibility(win, options, platform = process.platform, deps = {}) {
  if (!win || win.isDestroyed?.() || platform !== 'darwin') return;
  const entry = entryFor(win);
  const { enabled, opaque, reducedTransparency = false, highContrast = false, dark = true, radius = 14 } =
    typeof options === 'boolean' ? { enabled: options } : (options || {});
  const visible = win.isVisible() && !win.isMinimized();
  const wantsGlass = enabled && !opaque && !reducedTransparency;
  const supported = Number.parseInt(deps.osRelease || os.release(), 10) >= 25;
  const setVibrancy = (material) => {
    if (entry.vibrancy === material) return;
    win.setVibrancy(material);
    entry.vibrancy = material;
  };
  if (wantsGlass && supported && !entry.failed) {
    try {
      setVibrancy(null);
      if (!entry.glass) entry.glass = (deps.createGlass || createMacLiquidGlass)(win);
      entry.glass.update({ dark, radius });
    } catch (error) {
      entry.glass?.dispose();
      entry.glass = null;
      entry.failed = error.message;
      console.warn(`[native-material] Liquid Glass unavailable: ${error.message}`);
    }
  } else if (entry.glass) {
    entry.glass.dispose();
    entry.glass = null;
  }
  const type = opaque || reducedTransparency ? 'opaque'
    : !enabled ? 'transparent'
      : entry.glass ? 'liquid-glass' : 'vibrancy';
  setVibrancy(type === 'vibrancy' && visible ? 'hud' : null);
  const state = { type, reducedTransparency, highContrast, fallbackReason: entry.failed };
  if (JSON.stringify(entry.state) !== JSON.stringify(state)) {
    entry.state = state;
    if (!win.webContents.isDestroyed()) win.webContents.send('appearance:nativeMaterial', state);
  }
}

function attachNativeMaterialVisibility(win, getOptions, platform = process.platform, deps = {}) {
  if (platform !== 'darwin') return;
  const sync = () => syncNativeMaterialVisibility(win, getOptions(), platform, deps);
  for (const event of ['show', 'restore', 'hide', 'minimize']) win.on(event, sync);
  win.webContents.on('did-finish-load', () => {
    sync();
    win.webContents.send('appearance:nativeMaterial', getNativeMaterialState(win));
  });
  win.on('closed', () => {
    windows.get(win)?.glass?.dispose({ windowClosed: true });
    windows.delete(win);
  });
}

module.exports = {
  attachNativeMaterialVisibility,
  syncNativeMaterialVisibility,
  getNativeMaterialState
};
