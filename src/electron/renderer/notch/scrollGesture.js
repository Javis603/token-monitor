'use strict';

(function exposeNotchScroll(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorNotchScroll = api;
})(typeof window !== 'undefined' ? window : null, function createNotchScrollApi() {
  // Account pages take precedence while that direction has another account;
  // an edge passes the next gesture to main-page navigation.
  function swipeDestination(page, count, strip, direction) {
    const step = Math.sign(direction);
    if (strip?.pageWidth > 0 && step) {
      const origin = strip.origin;
      const target = origin + step;
      if (target >= 0 && target < strip.pageCount) {
        return { lane: 'strip', origin, target };
      }
    }
    return { lane: 'outer', origin: page, target: Math.max(0, Math.min(count - 1, page + step)) };
  }
  return { swipeDestination };
});
