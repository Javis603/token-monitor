'use strict';

// Floating-bubble thickFrame changes require a new native host. Keep the page
// in a WebContentsView so those changes replace only the HWND. Use a
// real BaseWindow (not a proxy): dialogs and fromWebContents still get its owner.
const entries = new WeakMap();
const { captureWindowViewState, restoreWindowViewState } = require('./renderer/windowViewState');

function createRetainedWindow({ BaseWindow, WebContentsView }, options, previous) {
  const { webPreferences = {}, ...windowOptions } = options;
  const win = new BaseWindow(windowOptions);
  let entry = entries.get(previous);
  if (!entry) {
    entry = { view: new WebContentsView({ webPreferences }), owner: null };
    entry.view.webContents.on('page-title-updated', (_event, title) => {
      if (entry.owner && !entry.owner.isDestroyed()) entry.owner.setTitle(title);
    });
    entry.view.webContents.once('destroyed', () => {
      if (entry.owner && !entry.owner.isDestroyed()) entry.owner.destroy();
    });
  }
  const { view } = entry;
  view.setBackgroundColor('#00000000');
  win.contentView.addChildView(view);
  entry.owner = win;
  if (view.webContents.getTitle()) win.setTitle(view.webContents.getTitle());
  entries.set(win, entry);
  // The desktop host's document-window contract; BaseWindow has no primary page.
  Object.defineProperty(win, 'webContents', { value: view.webContents });
  const resize = () => {
    if (entry.owner !== win) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  win.on('resize', resize);
  // BaseWindow has no primary page to receive keyboard focus automatically.
  // The transfer's viewport restore handles Chromium's scroll-to-focus.
  win.on('focus', () => { if (entry.owner === win) view.webContents.focus(); });
  win.once('closed', () => {
    entries.delete(win);
    if (entry.owner === win && !view.webContents.isDestroyed()) view.webContents.close();
  });
  resize();
  return win;
}

function captureRetainedWindowState(win) {
  return win.webContents.executeJavaScript(`(${captureWindowViewState.toString()})()`);
}

function restoreRetainedWindowState(win, restoreViewport = true) {
  const visible = win.isVisible() && !win.isMinimized();
  if (!visible) win.once('show', () => {
    restoreRetainedWindowState(win, restoreViewport).catch(error => console.warn(`[window] view restore failed: ${error.message}`));
  });
  return win.webContents.executeJavaScript(`(${restoreWindowViewState.toString()})(${JSON.stringify({ afterPaint: visible, restoreViewport })})`);
}

module.exports = { createRetainedWindow, captureRetainedWindowState, restoreRetainedWindowState };
