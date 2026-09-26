'use strict';

(function initMacBackdropMode(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorMacBackdropMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const MAC_BACKDROP_LIQUID_GLASS = 'liquid-glass';
  const MAC_BACKDROP_VIBRANCY = 'vibrancy';

  // Classic vibrancy stays the default: the app's own tint keeps dense figures
  // legible over any wallpaper, whereas the system-managed glass cannot be dimmed.
  function normalizeMacBackdropMode(value) {
    return value === MAC_BACKDROP_LIQUID_GLASS
      ? MAC_BACKDROP_LIQUID_GLASS
      : MAC_BACKDROP_VIBRANCY;
  }

  // The choice only exists where Liquid Glass does (macOS 26+); older systems
  // always get the classic vibrancy, so the control would do nothing there.
  function appearanceState(settings = {}, { liquidGlassSupported = false } = {}) {
    return {
      showBackdropControl: liquidGlassSupported && settings.systemGlass !== false,
      backdropMode: normalizeMacBackdropMode(settings.macBackdrop)
    };
  }

  return {
    MAC_BACKDROP_LIQUID_GLASS,
    MAC_BACKDROP_VIBRANCY,
    normalizeMacBackdropMode,
    appearanceState
  };
});
