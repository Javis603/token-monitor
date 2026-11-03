'use strict';

// These functions also run in the retained page through executeJavaScript.
// Keep the snapshot in that page: DOM references never cross IPC.
function captureWindowViewState() {
  const { document } = globalThis;
  globalThis[Symbol.for('token-monitor.window-view-state')] = {
    transferring: true,
    active: document.activeElement,
    scroll: Array.from(document.querySelectorAll('*'))
      .filter(node => node.scrollTop || node.scrollLeft)
      .map(node => [node, node.scrollTop, node.scrollLeft])
  };
}

function restoreWindowViewState({ afterPaint = true, restoreViewport = true } = {}) {
  const restore = () => {
    const snapshot = globalThis[Symbol.for('token-monitor.window-view-state')];
    if (snapshot) {
      if (restoreViewport) {
        if (snapshot.active?.isConnected) snapshot.active.focus({ preventScroll: true });
        for (const [node, top, left] of snapshot.scroll) {
          if (!node.isConnected) continue;
          node.scrollTop = top;
          node.scrollLeft = left;
        }
      }
      snapshot.transferring = !restoreViewport;
    }
  };
  if (!afterPaint) { restore(); return Promise.resolve(); }
  // Restore before the next paint. Waiting a second RAF exposes one frame of
  // Chromium's automatic scroll-to-focus after the new host becomes active.
  return new Promise(resolve => globalThis.requestAnimationFrame(() => {
    restore();
    resolve();
  }));
}

module.exports = { captureWindowViewState, restoreWindowViewState };
