'use strict';

// Shared typography for the tray Canvas and the top-entry DOM.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TokenMonitorTrayTypography = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function font(item, fontSize, defaultWeight) {
    const style = item?.fontStyle || 'normal';
    const family = style === 'compactMono'
      ? 'ui-monospace, ".AppleSystemUIFontMonospaced", "SFMono-Regular", "SF Mono", Menlo, monospace'
      : '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
    const weight = style === 'menubar' ? 700 : style === 'compactMono' ? 600 : defaultWeight;
    return `${weight} ${fontSize}px ${family}`;
  }

  function horizontalScale(item) {
    if (item?.fontStyle === 'condensed') return 0.86;
    if (item?.fontStyle === 'menubar') return 0.92;
    return 1;
  }

  function spaceScale(item) {
    return item?.fontStyle === 'compactMono' ? 0.55 : 1;
  }

  function spacerWidth(item, height) {
    const ratios = item.variant === 'dot' ? { narrow: 0.18, regular: 0.24, wide: 0.34 } : { narrow: 0.07, regular: 0.14, wide: 0.27 };
    return Math.max(2, Math.round(height * (ratios[item.size] || ratios.regular)));
  }
  function iconGap(height) {
    return Math.max(2, Math.round(height * 0.08));
  }

  return { font, horizontalScale, spaceScale, spacerWidth, iconGap };
});
