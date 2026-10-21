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

  // Concave dock curves use a clipped HostBackdrop, independent of the main
  // window's Acrylic/Accent choice. Existing installs follow System Glass.
  function normalizeWindowsDockBackdropMode(value) {
    return value === 'transparent' || value === 'host-backdrop' ? value : 'inherit';
  }

  return {
    WINDOWS_BACKDROP_ACRYLIC,
    WINDOWS_BACKDROP_ACCENT,
    normalizeWindowsBackdropMode,
    normalizeWindowsDockBackdropMode
  };
});
