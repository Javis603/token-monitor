'use strict';

(function initWindowsBackdropMode(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorWindowsBackdropMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const WINDOWS_BACKDROP_ACRYLIC = 'acrylic';
  const WINDOWS_BACKDROP_ACCENT = 'accent';

  function normalizeWindowsBackdropMode(value) {
    return value === WINDOWS_BACKDROP_ACCENT
      ? WINDOWS_BACKDROP_ACCENT
      : WINDOWS_BACKDROP_ACRYLIC;
  }

  return {
    WINDOWS_BACKDROP_ACRYLIC,
    WINDOWS_BACKDROP_ACCENT,
    normalizeWindowsBackdropMode
  };
});
