'use strict';

(function exposeGlassRendering(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorGlassRendering = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function clampOpacity(value) {
    const parsed = value == null ? NaN : Number(value);
    const opacity = Number.isFinite(parsed) ? parsed : 68;
    return Math.max(0, Math.min(100, opacity)) / 100;
  }

  function isMacPlatform(platform, userAgent) {
    if (String(platform || '').toLowerCase() === 'darwin') return true;
    return String(userAgent || '').toLowerCase().includes('macintosh');
  }

  function renderedGlassOpacity(settings, context = {}) {
    const requested = clampOpacity(settings?.glassOpacity);
    const transparentMacFallback = settings?.systemGlass === false
      && isMacPlatform(context.platform, context.userAgent);
    return transparentMacFallback && requested < 0.05 ? 0.05 : requested;
  }

  // A non-number (hand-edited settings.json) must not survive as NaN: in CSS an
  // invalid opacity resolves to 1 and hides the glass, and a range input would
  // silently turn it into its midpoint.
  const DEFAULT_BACKGROUND_IMAGE_OPACITY = 28;

  function normalizeBackgroundImageOpacity(value) {
    const numeric = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
    const opacity = numeric ? Number(value) : NaN;
    return Number.isFinite(opacity) ? Math.max(0, Math.min(100, opacity)) : DEFAULT_BACKGROUND_IMAGE_OPACITY;
  }

  const MATERIAL_TYPES = new Set(['liquid-glass', 'vibrancy', 'transparent', 'opaque']);

  function normalizeNativeMaterialState(value) {
    const type = MATERIAL_TYPES.has(value?.type) ? value.type : 'transparent';
    return {
      type,
      reducedTransparency: value?.reducedTransparency === true,
      highContrast: value?.highContrast === true,
      fallbackReason: value?.fallbackReason == null ? null : String(value.fallbackReason),
      liquidGlassSupported: value?.liquidGlassSupported === true
    };
  }

  function usesNativeMaterial(state) {
    return state?.type === 'liquid-glass' || state?.reducedTransparency === true;
  }

  function applyNativeMaterialClasses(state, root = document.documentElement, body = document.body) {
    const material = normalizeNativeMaterialState(state);
    for (const node of [root, body]) {
      if (!node) continue;
      node.classList.toggle('native-liquid-glass', material.type === 'liquid-glass');
      node.classList.toggle('native-material-opaque', material.type === 'opaque');
      node.classList.toggle('native-reduced-transparency', material.reducedTransparency);
      node.classList.toggle('native-high-contrast', material.highContrast);
    }
    return material;
  }

  return { renderedGlassOpacity, normalizeBackgroundImageOpacity, normalizeNativeMaterialState, usesNativeMaterial, applyNativeMaterialClasses };
});
