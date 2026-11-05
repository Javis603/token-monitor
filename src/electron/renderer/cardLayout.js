'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCardLayout = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  // Readiness must work in a hidden native window, where Windows may not
  // deliver animation frames. Only an already visible update may wait to paint.
  function createCardLayout({ measure, report, requestFrame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id) }) {
    let frame = null;
    let revision = 0;
    function cancel() {
      revision += 1;
      if (frame !== null) cancelFrame(frame);
      frame = null;
    }
    function prepare(content, { opening = false, afterPaint = false } = {}) {
      cancel();
      const request = revision;
      const finish = () => {
        if (request !== revision) return;
        frame = null;
        report(measure(content), content);
      };
      if (opening || !afterPaint) finish();
      else frame = requestFrame(() => {
        if (request === revision) frame = requestFrame(finish);
      });
    }
    return { prepare, cancel };
  }
  return { createCardLayout };
});
