'use strict';

(function exposeBreakdownRenderPolicy(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorBreakdownRenderPolicy = api;
})(typeof window !== 'undefined' ? window : null, function createBreakdownRenderPolicy() {
  // FLIP captures force synchronous layout and every animated row creates both Web
  // Animations and a number-counting rAF. Keep that polish for the compact views it was
  // designed for, but never fan it out across a Hub-sized session collection.
  const MAX_ANIMATED_BREAKDOWN_ROWS = 40;

  function rowCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  function shouldAnimateBreakdownRows(count, options = {}) {
    return options.reducedMotion !== true && rowCount(count) <= MAX_ANIMATED_BREAKDOWN_ROWS;
  }

  function isLargeSessionBreakdown(breakdown, count) {
    return breakdown === 'session' && rowCount(count) > MAX_ANIMATED_BREAKDOWN_ROWS;
  }

  function toolIconsEnabled(value) {
    return value === true;
  }

  function createAfterLayoutScheduler(requestFrame, cancelFrame) {
    let handle = 0;

    function cancel() {
      if (!handle) return;
      if (typeof cancelFrame === 'function') cancelFrame(handle);
      handle = 0;
    }

    function schedule(callback) {
      cancel();
      if (typeof requestFrame !== 'function') {
        callback();
        return;
      }
      handle = requestFrame(() => {
        handle = requestFrame(() => {
          handle = 0;
          callback();
        });
      });
    }

    return {
      cancel,
      pending: () => handle !== 0,
      schedule
    };
  }

  function rowRenderFingerprint(row, max, context = {}) {
    return JSON.stringify([row || null, Number(max) || 0, context || null]);
  }

  return {
    MAX_ANIMATED_BREAKDOWN_ROWS,
    createAfterLayoutScheduler,
    isLargeSessionBreakdown,
    rowRenderFingerprint,
    shouldAnimateBreakdownRows,
    toolIconsEnabled
  };
});
