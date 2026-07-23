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

  return { renderedGlassOpacity };
});
