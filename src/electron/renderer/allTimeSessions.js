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
    if (!sessions || !allTime || typeof allTime !== 'object') return stats;
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
  function createAllTimeSessionsLoader({ fetchSessions, currentSnapshot, needed, onLoaded, onError, projectSessions = (sessions) => sessions, projectionKey = () => undefined }) {
    if (typeof fetchSessions !== 'function') throw new TypeError('fetchSessions must be a function');
    if (typeof currentSnapshot !== 'function') throw new TypeError('currentSnapshot must be a function');
    if (typeof needed !== 'function') throw new TypeError('needed must be a function');
    if (typeof onLoaded !== 'function') throw new TypeError('onLoaded must be a function');
    let pulled = null;
    let stale = true;
    let pending = false;
    let projected = null;

    function attach(stats) {
      if (!pulled || !sameSource(pulled.snapshot, stats?.snapshot)) return stats;
      const key = projectionKey();
      // Project only the pulled map, once per map and policy. Main already
      // applies the policy to pushed stats; late pulls need their own guard.
      if (projected?.input !== pulled.sessions || projected.key !== key) {
        projected = { input: pulled.sessions, key, sessions: projectSessions(pulled.sessions) };
      }
      return withAllTimeSessions(stats, projected.sessions);
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

  function attachPeriodDetails(stats, details) {
    const periods = { ...stats.periods };
    const nativeSessions = { ...stats.nativeSessions };
    const nativeProjects = { ...stats.nativeProjects };
    for (const [period, detail] of Object.entries(details)) {
      if (!periods[period]) continue;
      const { nativeSessions: sessions, nativeProjects: projects, ...accounting } = detail;
      periods[period] = { ...periods[period], ...accounting };
      if (sessions) nativeSessions[period] = sessions;
      if (projects) nativeProjects[period] = projects;
    }
    return { ...stats, periods, nativeSessions, nativeProjects };
  }

  function applyPeriodDetailPatch(details, patch) {
    if (!patch.length) return details;
    const next = { ...details };
    for (const [period, field, replacements] of patch) {
      next[period] = { ...next[period], [field]: { ...next[period][field], ...replacements } };
    }
    return next;
  }

  function createPeriodDetailsLoader({ current, fetchDetails, onLoaded, onError }) {
    let active = null;
    let cached = null;
    let pending = false;
    let epoch = 0;

    function matches(target, request = active) {
      return Boolean(target?.snapshot && request && request.epoch === epoch
        && target.scope === request.scope && target.snapshot.id === request.snapshot.id
        && sameSource(target.snapshot, request.snapshot));
    }

    function ensure() {
      const target = current();
      if (!target || pending || matches(target)) return;
      const known = cached?.scope === target.scope && sameSource(cached.snapshot, target.snapshot) ? cached : null;
      const request = { ...target, epoch, details: null, failed: false };
      active = request;
      pending = true;
      Promise.resolve()
        .then(() => fetchDetails(request.snapshot, request.scope, known?.revision))
        .then((reply) => {
          if (!matches(current(), request)) {
            active = null;
            return;
          }
          request.details = reply?.details;
          if (known && reply?.baseRevision === known.revision) {
            request.details = applyPeriodDetailPatch(known.details, reply.patch);
          }
          request.failed = !request.details;
          if (request.details) cached = { ...request, revision: reply.revision };
          onLoaded();
        }, (error) => {
          if (!matches(current(), request)) {
            active = null;
            return;
          }
          request.failed = true;
          onError(error);
          onLoaded();
        })
        .finally(() => {
          pending = false;
          ensure();
        });
    }

    return {
      ensure,
      invalidate() {
        epoch += 1;
        cached = null;
      },
      ready() { return matches(current()) && Boolean(active.details); },
      failed() { return matches(current()) && active.failed; },
      attach(stats) {
        const target = current();
        return target && matches({ ...target, snapshot: stats?.snapshot }) && active.details
          ? attachPeriodDetails(stats, active.details) : stats;
      }
    };
  }

  return {
    createAllTimeSessionsLoader,
    createPeriodDetailsLoader,
    withAllTimeSessions
  };
});
