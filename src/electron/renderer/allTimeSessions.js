'use strict';

// The all-time session list is pulled rather than pushed: main composes it only
// when asked, and every stats push arrives without it. The last list pulled
// stays attached to newer stats until a fresh one lands, so the TOTAL session
// and project lists never drop back to the model list between a push and its
// pull.
(function exposeAllTimeSessions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorAllTimeSessions = api;
})(typeof window !== 'undefined' ? window : null, function createAllTimeSessionsApi() {
  function withAllTimeSessions(stats, sessions) {
    const allTime = stats?.periods?.allTime;
    if (!sessions || !allTime || typeof allTime !== 'object') return stats;
    return { ...stats, periods: { ...stats.periods, allTime: { ...allTime, sessions } } };
  }

  // One pull at a time. Stats that arrive during a pull mark the list stale, and
  // the pull that follows reads them; stats that arrive while nothing shows the
  // list only mark it, so a hidden view costs main nothing. A failed pull waits
  // for the next stats instead of retrying in a loop.
  function createAllTimeSessionsLoader({ fetchSessions, needed, onLoaded, onError }) {
    if (typeof fetchSessions !== 'function') throw new TypeError('fetchSessions must be a function');
    if (typeof needed !== 'function') throw new TypeError('needed must be a function');
    if (typeof onLoaded !== 'function') throw new TypeError('onLoaded must be a function');
    let sessions = null;
    let stale = true;
    let pending = false;

    function attach(stats) {
      return withAllTimeSessions(stats, sessions);
    }

    function invalidate() {
      stale = true;
    }

    function ensure() {
      if (pending || !stale || !needed()) return;
      stale = false;
      pending = true;
      Promise.resolve()
        .then(fetchSessions)
        .then((next) => {
          if (!next || typeof next !== 'object') return;
          sessions = next;
          onLoaded();
        }, (error) => {
          if (typeof onError === 'function') onError(error);
        })
        .finally(() => {
          pending = false;
          ensure();
        });
    }

    return {
      attach,
      ensure,
      invalidate,
      loaded: () => sessions !== null
    };
  }

  return {
    createAllTimeSessionsLoader,
    withAllTimeSessions
  };
});
