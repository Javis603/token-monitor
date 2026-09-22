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

module.exports = {
  actionWindowForEvent,
  handoffWindow,
  showWindow
};
