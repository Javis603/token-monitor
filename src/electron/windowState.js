'use strict';

// Single source of truth for the main widget's BrowserView size limits, used
// both by the explicit width/height inputs in Settings and by main.js's
// WINDOW_LIMITS (restore + drag resize). The height floor (56) admits the
// compact horizontal bar shown in issue #873 (e.g. 600x80, 800x100); the
// renderer already lays that compact surface out at these heights.
const WIDGET_SIZE_LIMITS = { minWidth: 240, minHeight: 56, maxWidth: 1600, maxHeight: 1400 };

function normalizeWidgetDimensions(input, limits = WIDGET_SIZE_LIMITS) {
  if (!input || typeof input !== 'object') return null;
  const width = Math.round(Number(input.width));
  const height = Math.round(Number(input.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return {
    width: Math.min(limits.maxWidth, Math.max(limits.minWidth, width)),
    height: Math.min(limits.maxHeight, Math.max(limits.minHeight, height))
  };
}

// Keeps the window's current top-left anchor when applying an explicit size,
// then pulls it back inside the work area so growing the widget can never push
// it off-screen.
function resizeWidgetBounds(current, desired, workArea, limits = WIDGET_SIZE_LIMITS) {
  const size = normalizeWidgetDimensions(desired, limits);
  if (!size || !current || !workArea) return null;
  const minX = Number(workArea.x);
  const minY = Number(workArea.y);
  const maxX = Number(workArea.x) + Number(workArea.width) - size.width;
  const maxY = Number(workArea.y) + Number(workArea.height) - size.height;
  const x = Math.min(Math.max(Number(current.x), minX), Math.max(minX, maxX));
  const y = Math.min(Math.max(Number(current.y), minY), Math.max(minY, maxY));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height };
}

function isWindowMaximized(window) {
  return Boolean(
    window &&
    !(typeof window.isDestroyed === 'function' && window.isDestroyed()) &&
    typeof window.isMaximized === 'function' &&
    window.isMaximized()
  );
}

function normalWindowBounds(window) {
  if (!window || (typeof window.isDestroyed === 'function' && window.isDestroyed())) return null;
  if (typeof window.isMinimized === 'function' && window.isMinimized()) return null;
  if (typeof window.isFullScreen === 'function' && window.isFullScreen()) return null;
  const getBounds = isWindowMaximized(window) && typeof window.getNormalBounds === 'function'
    ? window.getNormalBounds
    : window.getBounds;
  if (typeof getBounds !== 'function') return null;
  try {
    const bounds = getBounds.call(window);
    return bounds && typeof bounds === 'object' ? bounds : null;
  } catch (_) {
    return null;
  }
}

function shouldPersistWindowBounds(window) {
  return Boolean(normalWindowBounds(window) && !isWindowMaximized(window));
}

// Tray popovers are re-anchored and re-sized on every open, and a collapsed
// floating bubble persists through settings.floatingBubbleBounds — in both
// modes the native maximize/unmaximize events describe a window that is no
// longer the normal one, so they must not rewrite the normal window state.
function shouldTrackWindowMaximized(settings = {}, bubbleState = {}) {
  return settings.trayMode !== true && bubbleState.collapsed !== true;
}

// Drops the native maximized state while leaving settings.windowMaximized
// alone, so the flag still describes the window the user will come back to.
function suspendWindowMaximized(window) {
  if (!isWindowMaximized(window) || typeof window.unmaximize !== 'function') return false;
  window.unmaximize();
  return true;
}

function setWindowMaximizable(window, maximizable) {
  if (!window || (typeof window.isDestroyed === 'function' && window.isDestroyed())) return false;
  if (typeof window.setMaximizable !== 'function') return false;
  window.setMaximizable(maximizable === true);
  return true;
}

// The bounds a collapse should remember as the expanded window. A maximized
// window's getBounds() is the whole screen, so remembering it would lose the
// size the user gets back when they unmaximize.
function expandedBoundsForCollapse(window, currentBounds) {
  return normalWindowBounds(window) || currentBounds || null;
}

function shouldRestoreWindowMaximized(settings = {}, options = {}) {
  if (settings.trayMode === true || options.collapsedFloatingBubble === true) return false;
  return settings.windowMaximized === true;
}

function restoreWindowMaximized(window, settings = {}, options = {}) {
  if (!shouldRestoreWindowMaximized(settings, options)) return false;
  if (!window || (typeof window.isDestroyed === 'function' && window.isDestroyed())) return false;
  if (typeof window.maximize !== 'function' || isWindowMaximized(window)) return false;
  window.maximize();
  return true;
}

function restoreWindowMaximizedForReveal(window, settings = {}, options = {}) {
  const restored = options.restoreMaximized === true && restoreWindowMaximized(window, settings, options);
  if (!restored) return false;
  if (
    options.inactive !== true &&
    typeof window.isFocused === 'function' &&
    !window.isFocused() &&
    typeof window.focus === 'function'
  ) {
    window.focus();
  }
  return true;
}

function sameWindowBounds(first, second) {
  return first?.x === second?.x &&
    first?.y === second?.y &&
    first?.width === second?.width &&
    first?.height === second?.height;
}

function persistWindowState(settings, saveSettings, bounds, maximized) {
  const nextMaximized = maximized === true;
  const boundsChanged = Boolean(bounds) && !sameWindowBounds(settings.windowBounds, bounds);
  const maximizedChanged = settings.windowMaximized !== nextMaximized;
  if (!boundsChanged && !maximizedChanged) return false;
  if (boundsChanged) settings.windowBounds = bounds;
  if (maximizedChanged) settings.windowMaximized = nextMaximized;
  saveSettings();
  return true;
}

function rebuildWindowBounds(window, state = {}) {
  if (state.collapsed === true && state.expandedBounds) return state.expandedBounds;
  const bounds = normalWindowBounds(window);
  if (bounds) return bounds;
  if (window && typeof window.getBounds === 'function') return window.getBounds();
  return null;
}

module.exports = {
  WIDGET_SIZE_LIMITS,
  expandedBoundsForCollapse,
  isWindowMaximized,
  normalWindowBounds,
  normalizeWidgetDimensions,
  persistWindowState,
  rebuildWindowBounds,
  resizeWidgetBounds,
  restoreWindowMaximized,
  restoreWindowMaximizedForReveal,
  setWindowMaximizable,
  shouldPersistWindowBounds,
  shouldRestoreWindowMaximized,
  shouldTrackWindowMaximized,
  suspendWindowMaximized
};
