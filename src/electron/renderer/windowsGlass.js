'use strict';

(function initWindowsGlass(root, factory) {
  const backdropModeApi = typeof module === 'object' && module.exports
    ? require('../windowsBackdropMode')
    : root?.TokenMonitorWindowsBackdropMode;
  const api = factory(backdropModeApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorWindowsGlass = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, (backdropModeApi) => {
  const { normalizeWindowsBackdropMode } = backdropModeApi;

  function appearanceState(settings = {}, { isWindows = false, osRelease = '', accentActive = false } = {}) {
    const systemGlassEnabled = settings.systemGlass !== false;
    const backdropMode = normalizeWindowsBackdropMode(settings.windowsBackdrop);
    const showAccentNote = isWindows && systemGlassEnabled && backdropMode === 'accent';
    const build = Number(osRelease.split('.')[2]);
    return {
      showBackdropControl: isWindows && systemGlassEnabled,
      showAccentNote,
      // Windows 10's Accent backdrop fills the HWND, including outside the CSS corners.
      squareCorners: isWindows && accentActive && build > 0 && build < 22000,
      backdropMode
    };
  }

  return { appearanceState, normalizeWindowsBackdropMode };
});
