'use strict';

(function initMacBackdropMode(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorMacBackdropMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const MAC_BACKDROP_LIQUID_GLASS = 'liquid-glass';
  const MAC_BACKDROP_LIQUID_GLASS_CLEAR = 'liquid-glass-clear';
  const MAC_BACKDROP_VIBRANCY = 'vibrancy';
  const EDGE_DOCK_BACKDROP_INHERIT = 'inherit';

  // Keep the existing default and opacity preference for classic vibrancy.
  function normalizeMacBackdropMode(value) {
    return isLiquidGlassBackdrop(value)
      ? value
      : MAC_BACKDROP_VIBRANCY;
  }

  function isLiquidGlassBackdrop(value) {
    return value === MAC_BACKDROP_LIQUID_GLASS || value === MAC_BACKDROP_LIQUID_GLASS_CLEAR;
  }

  function liquidGlassStyle(value) {
    return value === MAC_BACKDROP_LIQUID_GLASS_CLEAR ? 'clear' : 'regular';
  }

  // Native optical effects stay with AppKit; only its public tint is adjustable.
  // Separate settings preserve each style's value without changing classic glass.
  function normalizeLiquidGlassTint(value, mode) {
    const fallback = mode === MAC_BACKDROP_LIQUID_GLASS_CLEAR ? 35 : 0;
    const parsed = value == null || value === '' ? NaN : Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : fallback;
  }

  function liquidGlassTint(settings = {}, mode = settings.macBackdrop) {
    const value = mode === MAC_BACKDROP_LIQUID_GLASS_CLEAR ? settings.macClearGlassTint : settings.macGlassTint;
    return normalizeLiquidGlassTint(value, mode) / 100;
  }

  // The edge dock is a small floating control over other apps' content, which
  // is where Liquid Glass reads best, while the widget holds dense figures; so
  // the dock may pick its own style. It only picks the style: whether there is
  // native material at all stays with System Glass and Reduce Transparency.
  function normalizeEdgeDockBackdropMode(value) {
    return isLiquidGlassBackdrop(value) || value === MAC_BACKDROP_VIBRANCY
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
    MAC_BACKDROP_LIQUID_GLASS_CLEAR,
    MAC_BACKDROP_VIBRANCY,
    isLiquidGlassBackdrop,
    liquidGlassStyle,
    normalizeLiquidGlassTint,
    liquidGlassTint,
    normalizeMacBackdropMode,
    normalizeEdgeDockBackdropMode,
    edgeDockBackdropMode,
    appearanceState
  };
});
