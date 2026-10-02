'use strict';

// The all-time session list is pulled rather than pushed: main composes it only
// when asked, for the snapshot the renderer names, and every stats push arrives
// without it. The last list pulled stays attached to newer stats from the same
// source until a fresh one lands, so the TOTAL session and project lists never
// drop back to the model list between a push and its pull.
(function exposeAllTimeSessions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorAllTimeSessions = api;
})(typeof window !== 'undefined' ? window : null, function createAllTimeSessionsApi() {
  function withAllTimeSessions(stats, sessions) {
    const allTime = stats?.periods?.allTime;
    if (!sessions || !allTime || typeof allTime !== 'object' || stats.codexAccountActivity?.detailsSuppressed) return stats;
    return { ...stats, periods: { ...stats.periods, allTime: { ...allTime, sessions } } };
  }

  function sameSource(a, b) {
    return Boolean(a && b) && a.source === b.source;
  }

  // One pull at a time, always for the snapshot the renderer holds when it
  // starts (`currentSnapshot()`, main's `{ id, source }` stamp). Stats that
  // arrive during a pull mark the list stale, and the pull that follows reads
  // them; stats that arrive while nothing shows the list only mark it, so a
  // hidden view costs main nothing. A list never crosses a source change: it is
  // neither attached to stats from another Hub or mode, nor kept when it lands
  // after a switch. A failed pull waits for the next stats instead of retrying
  // in a loop.
  function createAllTimeSessionsLoader({ fetchSessions, currentSnapshot, needed, onLoaded, onError }) {
    if (typeof fetchSessions !== 'function') throw new TypeError('fetchSessions must be a function');
    if (typeof currentSnapshot !== 'function') throw new TypeError('currentSnapshot must be a function');
    if (typeof needed !== 'function') throw new TypeError('needed must be a function');
    if (typeof onLoaded !== 'function') throw new TypeError('onLoaded must be a function');
    let pulled = null;
    let stale = true;
    let pending = false;

    function attach(stats) {
      if (!pulled || !sameSource(pulled.snapshot, stats?.snapshot)) return stats;
      return withAllTimeSessions(stats, pulled.sessions);
    }

    function invalidate() {
      stale = true;
    }

    function loaded() {
      return Boolean(pulled) && sameSource(pulled.snapshot, currentSnapshot());
    }

    function ensure() {
      if (pending || !stale || !needed()) return;
      const snapshot = currentSnapshot();
      if (!snapshot) return;
      stale = false;
      pending = true;
      Promise.resolve()
        .then(() => fetchSessions(snapshot.id))
        .then((sessions) => {
          if (!sessions || typeof sessions !== 'object') return;
          if (!sameSource(snapshot, currentSnapshot())) return;
          pulled = { snapshot, sessions };
          onLoaded();
        }, (error) => {
          if (typeof onError === 'function') onError(error);
        })
        .finally(() => {
          pending = false;
          ensure();
        });
    }

    return { attach, ensure, invalidate, loaded };
  }

  return {
    createAllTimeSessionsLoader,
    withAllTimeSessions
  };
});
