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

  // Main normalizes the stored value on load and on every save, so a
  // hand-edited settings.json never reaches the renderer as NaN — which CSS
  // would resolve to opacity 1, hiding the glass behind the image.
  function normalizeBackgroundImageOpacity(value) {
    const opacity = Number(value ?? 28);
    return Number.isFinite(opacity) ? Math.max(0, Math.min(100, opacity)) : 28;
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
