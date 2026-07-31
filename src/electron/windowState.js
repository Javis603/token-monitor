'use strict';

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

module.exports = {
  isWindowMaximized,
  normalWindowBounds,
  persistWindowState,
  restoreWindowMaximized,
  restoreWindowMaximizedForReveal,
  shouldPersistWindowBounds,
  shouldRestoreWindowMaximized
};
