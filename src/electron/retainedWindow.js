'use strict';

// Floating-bubble thickFrame changes require a new native host. Keep the page
// in a WebContentsView so those changes replace only the HWND. Use a
// real BaseWindow (not a proxy): dialogs and fromWebContents still get its owner.
const entries = new WeakMap();
const { afterVisiblePaint, captureWindowViewState, restoreWindowViewState } = require('./renderer/windowViewState');

const REVEAL_FALLBACK_MS = 1000;

function createRetainedWindow({ BaseWindow, WebContentsView }, options, previous, { beforeReveal } = {}) {
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
  // Unlike BrowserWindow, a shown BaseWindow marks its view visible only after
  // a delay (~200 ms on Windows 11), exposing the empty backdrop. Keep each
  // show transparent until the page paints; the fallback covers paused frames.
  // Hiding goes transparent first: DWM can present the stale pre-hide frame
  // before the show event arrives. show() on a shown host also emits 'show'.
  // beforeReveal runs at reveal rather than show, after a replacement has
  // retired the previous host.
  let revealEpoch = 0;
  let hidden = true;
  win.on('hide', () => {
    hidden = true;
    if (entry.owner !== win) return;
    revealEpoch++;
    win.setOpacity(0);
  });
  win.on('show', () => {
    if (!hidden || entry.owner !== win) return;
    hidden = false;
    const epoch = ++revealEpoch;
    let timer = null;
    let settled = false;
    const reveal = () => {
      clearTimeout(timer);
      if (settled || epoch !== revealEpoch || win.isDestroyed()) return;
      settled = true;
      beforeReveal?.(win);
      win.setOpacity(1);
    };
    win.setOpacity(0);
    timer = setTimeout(reveal, REVEAL_FALLBACK_MS);
    view.webContents.executeJavaScript(`(${afterVisiblePaint.toString()})()`).then(reveal, reveal);
  });
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
  const entry = entries.get(win);
  if (!entry || entry.owner !== win || win.isDestroyed()) return Promise.resolve();
  const visible = win.isVisible() && !win.isMinimized();
  if (!visible) win.once('show', () => {
    if (entry.owner !== win || win.isDestroyed()) return;
    restoreRetainedWindowState(win, restoreViewport).catch(error => console.warn(`[window] view restore failed: ${error.message}`));
  });
  const restore = afterPaint => win.webContents.executeJavaScript(`(${restoreWindowViewState.toString()})(${JSON.stringify({ afterPaint, restoreViewport, releaseSnapshot: visible })})`);
  const restored = restore(visible);
  if (!visible) return restored;
  return new Promise((resolve, reject) => {
    // Occluded pages may pause RAF despite a visible native host. Finish the
    // restore synchronously in the page before allowing another queued capture.
    const timer = setTimeout(() => {
      if (entry.owner !== win || win.isDestroyed()) { resolve(); return; }
      restore(false).then(resolve, reject);
    }, 1000);
    restored.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

module.exports = { createRetainedWindow, captureRetainedWindowState, restoreRetainedWindowState };
