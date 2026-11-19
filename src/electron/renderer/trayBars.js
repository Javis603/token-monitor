'use strict';

(function exposeTrayBars(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorTrayBars = api;
})(typeof window !== 'undefined' ? window : null, function createTrayBarsApi() {
  function finiteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function trayBarFillWidth(percent, trackWidth) {
    const p = Number(percent);
    const width = Math.max(0, Math.round(finiteNumber(trackWidth, 0)));
    if (!Number.isFinite(p) || width <= 0) return null;
    const clamped = Math.max(0, Math.min(100, p));
    if (clamped <= 0) return 0;
    return Math.min(width, Math.max(1, Math.round(width * clamped / 100)));
  }

  function trayBarsLayout(height = 36, options = {}) {
    const h = Math.max(16, Math.round(finiteNumber(height, 36)));
    const fullWidth = Math.round(h * 2.06);
    const contentOnly = options?.contentOnly === true;
    const padX = 0;
    const iconSize = contentOnly ? 0 : Math.round(h * 1);
    const iconY = contentOnly ? 0 : Math.round((h - iconSize) / 2);
    const innerGap = Math.round(h * 0.14);
    const fullBarsX = padX + Math.round(h * 1) + innerGap;
    const barsWidth = Math.max(1, fullWidth - fullBarsX - padX);
    const width = contentOnly ? barsWidth : fullWidth;
    const barsX = contentOnly ? 0 : fullBarsX;
    const barHeight = Math.round(h * 0.24);
    const barGap = Math.round(h * 0.13);
    const totalBarsH = barHeight * 2 + barGap;
    const barsStartY = Math.round((h - totalBarsH) / 2);
    return {
      width,
      height: h,
      padX,
      iconSize,
      iconY,
      barsX,
      barsWidth,
      barHeight,
      barGap,
      barsStartY,
      radius: barHeight / 2
    };
  }

  return { trayBarFillWidth, trayBarsLayout };
});
