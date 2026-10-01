'use strict';

function showWindow(target, inactive = false) {
  if (!target || target.isDestroyed() || target.isVisible()) return;
  if (inactive && typeof target.showInactive === 'function') {
    target.showInactive();
  } else {
    target.show();
  }
}

function handoffWindow(oldWindow, nextWindow, options = {}) {
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const shouldFocus = options.focus === true;
  const fallbackMs = Number.isFinite(options.fallbackMs) ? options.fallbackMs : 3000;
  let fallbackTimer = null;
  let finished = false;

  const destroyOld = () => {
    if (oldWindow && !oldWindow.isDestroyed()) oldWindow.destroy();
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    if (fallbackTimer) {
      clearTimer(fallbackTimer);
      fallbackTimer = null;
    }
    nextWindow?.removeListener('show', finish);
    destroyOld();
    if (shouldFocus && nextWindow && !nextWindow.isDestroyed()) nextWindow.focus();
  };

  if (!nextWindow || nextWindow.isDestroyed()) {
    destroyOld();
    return;
  }
  if (nextWindow.isVisible()) {
    finish();
    return;
  }
  nextWindow.once('show', finish);
  fallbackTimer = setTimer(finish, fallbackMs);
}

function actionWindowForEvent(BrowserWindow, event, fallbackWindow) {
  const senderWindow = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
  const target = senderWindow || fallbackWindow;
  return target && !target.isDestroyed() ? target : null;
}

// macOS 'activate' (Dock click, Finder/`open` reopen) arrives whatever the
// window state: a live main window that is hidden or minimized is refocused;
// another live window still blocks creation; only an empty or edge-dock-only
// set spawns a new main window.
function activateWindowAction(state = {}) {
  const mainWindow = state.mainWindow;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const minimized = typeof mainWindow.isMinimized === 'function' && mainWindow.isMinimized();
    return (!mainWindow.isVisible() || minimized) ? 'focusWindow' : 'none';
  }
  const windows = Array.isArray(state.windows) ? state.windows : [];
  const isDockOwned = typeof state.isDockOwned === 'function' ? state.isDockOwned : () => false;
  return windows.every((win) => isDockOwned(win)) ? 'createWindow' : 'none';
}

module.exports = {
  actionWindowForEvent,
  activateWindowAction,
  handoffWindow,
  showWindow
};
