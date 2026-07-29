'use strict';

(function exposeStatsRenderScheduler(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorStatsRenderScheduler = api;
})(typeof window !== 'undefined' ? window : null, function createStatsRenderSchedulerApi() {
  function createStatsRenderScheduler({ isHidden, render }) {
    if (typeof isHidden !== 'function') throw new TypeError('isHidden must be a function');
    if (typeof render !== 'function') throw new TypeError('render must be a function');
    let renderPending = false;

    function request() {
      if (isHidden()) {
        renderPending = true;
        return;
      }
      renderPending = false;
      render();
    }

    function flush() {
      if (!renderPending || isHidden()) return;
      render();
      renderPending = false;
    }

    return {
      flush,
      request
    };
  }

  return {
    createStatsRenderScheduler
  };
});
