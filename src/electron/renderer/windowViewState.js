'use strict';

// These functions also run in the retained page through executeJavaScript.
// Keep the snapshot in that page: DOM references never cross IPC.
function captureWindowViewState() {
  const { document } = globalThis;
  globalThis[Symbol.for('token-monitor.window-view-state')]?.cancelRestore?.();
  globalThis[Symbol.for('token-monitor.window-view-state')] = {
    transferring: true,
    active: document.activeElement,
    scroll: Array.from(document.querySelectorAll('*'))
      .filter(node => node.scrollTop || node.scrollLeft
        || node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
      .map(node => [node, node.scrollTop, node.scrollLeft])
  };
}

function restoreWindowViewState({ afterPaint = true, restoreViewport = true, releaseSnapshot = true } = {}) {
  const snapshot = globalThis[Symbol.for('token-monitor.window-view-state')];
  if (!snapshot) return Promise.resolve();
  snapshot.cancelRestore?.();
  const restore = () => {
    if (globalThis[Symbol.for('token-monitor.window-view-state')] === snapshot) {
      if (restoreViewport) {
        if (snapshot.active?.isConnected) snapshot.active.focus({ preventScroll: true });
        for (const [node, top, left] of snapshot.scroll) {
          if (!node.isConnected) continue;
          node.scrollTop = top;
          node.scrollLeft = left;
        }
        if (releaseSnapshot) {
          snapshot.active = null;
          snapshot.scroll = [];
        }
      }
      snapshot.transferring = !restoreViewport;
    }
  };
  if (!afterPaint) { restore(); return Promise.resolve(); }
  // Restore before the next paint. Waiting a second RAF exposes one frame of
  // Chromium's automatic scroll-to-focus after the new host becomes active.
  return new Promise(resolve => {
    let cancelled = false;
    const frame = globalThis.requestAnimationFrame(() => {
      if (cancelled) return;
      delete snapshot.cancelRestore;
      restore();
      resolve();
    });
    snapshot.cancelRestore = () => {
      cancelled = true;
      globalThis.cancelAnimationFrame(frame);
      delete snapshot.cancelRestore;
      resolve();
    };
  });
}

// Resolves once a frame painted while visible has reached the screen. The
// native host's opacity applies a frame sooner than the page's content does.
function afterVisiblePaint() {
  const { document, requestAnimationFrame } = globalThis;
  return new Promise(resolve => {
    const paint = () => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (document.visibilityState === 'visible') paint();
    else document.addEventListener('visibilitychange', paint, { once: true });
  });
}

module.exports = { afterVisiblePaint, captureWindowViewState, restoreWindowViewState };
