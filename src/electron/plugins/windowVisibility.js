'use strict';

// Explicit host actions must publish their completed native state: Electron can
// change isVisible() without a hide or DOM visibility event. Native listeners
// remain responsible for OS-driven transitions. No BrowserWindow monkeypatch.
function createWindowVisibilityActions(onChanged) {
  function apply(win, action) {
    if (!win || win.isDestroyed()) return;
    win[action]();
    onChanged(win);
  }
  return { hide: win => apply(win, 'hide'), minimize: win => apply(win, 'minimize') };
}
module.exports = { createWindowVisibilityActions };
