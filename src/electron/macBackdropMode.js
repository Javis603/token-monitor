'use strict';

(function initMacBackdropMode(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorMacBackdropMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const MAC_BACKDROP_LIQUID_GLASS = 'liquid-glass';
  const MAC_BACKDROP_VIBRANCY = 'vibrancy';
  const EDGE_DOCK_BACKDROP_INHERIT = 'inherit';

  // Classic vibrancy stays the default: the app's own tint keeps dense figures
  // legible over any wallpaper, whereas the system-managed glass cannot be dimmed.
  function normalizeMacBackdropMode(value) {
    return value === MAC_BACKDROP_LIQUID_GLASS
      ? MAC_BACKDROP_LIQUID_GLASS
      : MAC_BACKDROP_VIBRANCY;
  }

  // The edge dock is a small floating control over other apps' content, which
  // is where Liquid Glass reads best, while the widget holds dense figures; so
  // the dock may pick its own style. It only picks the style: whether there is
  // native material at all stays with System Glass and Reduce Transparency.
  function normalizeEdgeDockBackdropMode(value) {
    return value === MAC_BACKDROP_LIQUID_GLASS || value === MAC_BACKDROP_VIBRANCY
      ? value
      : EDGE_DOCK_BACKDROP_INHERIT;
  }

  function edgeDockBackdropMode(settings = {}) {
    const own = normalizeEdgeDockBackdropMode(settings.edgeDockMacBackdrop);
    return own === EDGE_DOCK_BACKDROP_INHERIT ? normalizeMacBackdropMode(settings.macBackdrop) : own;
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
    normalizeEdgeDockBackdropMode,
    edgeDockBackdropMode,
    appearanceState
  };
});
