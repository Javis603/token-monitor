'use strict';

(function exposeClientRescanState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorClientRescanState = api;
})(typeof window !== 'undefined' ? window : null, function createClientRescanStateApi() {
  function createClientRescanState(options = {}) {
    const entries = new Map();
    const failureMs = Number(options.failureMs) > 0 ? Number(options.failureMs) : 3000;
    // Per-client floor on how long `pending` stays true: a client whose scan
    // completes in a few hundred milliseconds would otherwise make its button's
    // disabled state flash imperceptibly. A number applies to every client; a
    // function decides per client (return 0 to keep the old behavior).
    const minimumPendingFor = typeof options.minimumPendingMs === 'function'
      ? options.minimumPendingMs
      : () => (Number(options.minimumPendingMs) > 0 ? Number(options.minimumPendingMs) : 0);
    const now = options.now || (() => Date.now());
    const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    let nextRequestId = 0;

    function snapshot(clientId) {
      const entry = entries.get(String(clientId || ''));
      return entry
        ? { pending: entry.pending, failed: entry.failed, feedbackCode: entry.feedbackCode }
        : { pending: false, failed: false, feedbackCode: '' };
    }

    function begin(clientId) {
      const id = String(clientId || '');
      const previous = entries.get(id);
      if (previous?.timer !== null && previous?.timer !== undefined) clearTimer(previous.timer);
      const requestId = ++nextRequestId;
      entries.set(id, { requestId, pending: true, failed: false, feedbackCode: '', timer: null, beganAt: now() });
      onChange(id);
      return requestId;
    }

    function finish(
      clientId,
      requestId,
      succeeded,
      feedbackCode = succeeded === true ? '' : 'rescan-failed'
    ) {
      const id = String(clientId || '');
      const entry = entries.get(id);
      if (!entry || entry.requestId !== requestId) return false;
      // A request ending inside the minimum window keeps `pending` until the
      // window elapses; the result (including the failure badge's own timer)
      // only applies once the held finish actually fires. A new begin during
      // the hold replaces the entry, and the requestId guard below discards
      // the stale completion.
      const apply = () => {
        const current = entries.get(id);
        if (!current || current.requestId !== requestId) return;
        current.pending = false;
        current.failed = succeeded !== true;
        current.feedbackCode = String(feedbackCode || '');
        current.timer = null;
        if (current.failed) {
          current.timer = setTimer(() => {
            const cleared = entries.get(id);
            if (!cleared || cleared.requestId !== requestId) return;
            cleared.failed = false;
            cleared.feedbackCode = '';
            cleared.timer = null;
            onChange(id);
          }, failureMs);
        }
        onChange(id);
      };
      const minimumMs = minimumPendingFor(id);
      const remaining = minimumMs > 0 ? minimumMs - (now() - entry.beganAt) : 0;
      if (remaining > 0) {
        if (entry.timer !== null && entry.timer !== undefined) clearTimer(entry.timer);
        entry.timer = setTimer(apply, remaining);
        return true;
      }
      apply();
      return true;
    }

    return { begin, finish, snapshot };
  }

  return { createClientRescanState };
});
