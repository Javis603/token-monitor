'use strict';

const os = require('node:os');
const { createMacLiquidGlass } = require('./macLiquidGlass');

const windows = new WeakMap();

function entryFor(win) {
  let entry = windows.get(win);
  if (!entry) {
    entry = { glass: null, failed: null, vibrancy: undefined, state: null, shaped: false };
    windows.set(win, entry);
  }
  return entry;
}

function getNativeMaterialState(win) {
  return windows.get(win)?.state || {
    type: 'transparent', reducedTransparency: false, highContrast: false, fallbackReason: null, liquidGlassSupported: false
  };
}

// Clear the entry before touching AppKit so a throwing cleanup can neither keep
// a disposed view reported as live nor pre-empt the HUD fallback. A view that
// may still be attached also blocks recreation, so views never stack.
function disposeGlass(entry, options) {
  const glass = entry.glass;
  entry.glass = null;
  try {
    glass?.dispose(options);
  } catch (error) {
    entry.failed ||= error.message;
    console.warn(`[native-material] Liquid Glass cleanup failed: ${error.message}`);
  }
}

function syncNativeMaterialVisibility(win, options, platform = process.platform, deps = {}) {
  if (!win || win.isDestroyed?.() || platform !== 'darwin') return;
  const entry = entryFor(win);
  const {
    enabled, opaque, liquidGlass = false, style = 'regular', tintOpacity, reducedTransparency: systemReduced = false, highContrast = false, dark = true, radius = 14, shape
  } = typeof options === 'boolean' ? { enabled: options } : (options || {});
  // Reduce Transparency replaces only the system material. With System Glass
  // off, the CSS glass and background image stay under the user's sliders.
  const reducedTransparency = Boolean(enabled) && systemReduced;
  const visible = win.isVisible() && !win.isMinimized();
  // Liquid Glass is opt-in. The classic style is not a failure: it only skips
  // the glass view, so the HUD vibrancy below takes over as on older macOS.
  const wantsGlass = enabled && !opaque && !reducedTransparency && liquidGlass === true;
  const supported = Number.parseInt(deps.osRelease || os.release(), 10) >= 25;
  const setVibrancy = (material) => {
    if (entry.vibrancy === material) return;
    win.setVibrancy(material);
    entry.vibrancy = material;
  };
  if (entry.shaped !== Boolean(shape)) {
    // A rectangular fallback must not retain the previous canvas path/mask.
    if (entry.glass) disposeGlass(entry);
    setVibrancy(null);
    entry.shaped = Boolean(shape);
  }
  if (wantsGlass && supported && !entry.failed) {
    try {
      setVibrancy(null);
      if (!entry.glass) entry.glass = (deps.createGlass || createMacLiquidGlass)(win, { shaped: Boolean(shape) });
      entry.glass.update({ dark, radius, style, tintOpacity, ...(shape ? { shape } : {}) });
    } catch (error) {
      entry.failed = error.message;
      console.warn(`[native-material] Liquid Glass unavailable: ${error.message}`);
      disposeGlass(entry);
    }
  } else if (entry.glass) {
    disposeGlass(entry);
  }
  const type = opaque || reducedTransparency ? 'opaque'
    : !enabled ? 'transparent'
      : entry.glass ? 'liquid-glass' : 'vibrancy';
  // Shaped retained cards install and mask their material before first reveal,
  // and keep that same container between opacity-only dismissals.
  setVibrancy(type === 'vibrancy' && (visible || Boolean(shape)) ? 'hud' : null);
  const state = { type, reducedTransparency, highContrast, fallbackReason: entry.failed, liquidGlassSupported: supported };
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
    const entry = windows.get(win);
    windows.delete(win);
    if (entry) disposeGlass(entry, { windowClosed: true });
  });
}

module.exports = {
  attachNativeMaterialVisibility,
  syncNativeMaterialVisibility,
  getNativeMaterialState
};
