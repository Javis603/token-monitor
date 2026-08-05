'use strict';

(function exposeClientRescanState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorClientRescanState = api;
})(typeof window !== 'undefined' ? window : null, function createClientRescanStateApi() {
  function createClientRescanState(options = {}) {
    const entries = new Map();
    const failureMs = Number(options.failureMs) > 0 ? Number(options.failureMs) : 3000;
    const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    let nextRequestId = 0;

    function snapshot(clientId) {
      const entry = entries.get(String(clientId || ''));
      return entry
        ? { pending: entry.pending, failed: entry.failed }
        : { pending: false, failed: false };
    }

    function begin(clientId) {
      const id = String(clientId || '');
      const previous = entries.get(id);
      if (previous?.timer !== null && previous?.timer !== undefined) clearTimer(previous.timer);
      const requestId = ++nextRequestId;
      entries.set(id, { requestId, pending: true, failed: false, timer: null });
      onChange(id);
      return requestId;
    }

    function finish(clientId, requestId, succeeded) {
      const id = String(clientId || '');
      const entry = entries.get(id);
      if (!entry || entry.requestId !== requestId) return false;
      entry.pending = false;
      entry.failed = succeeded !== true;
      if (entry.timer !== null && entry.timer !== undefined) clearTimer(entry.timer);
      entry.timer = null;
      if (entry.failed) {
        entry.timer = setTimer(() => {
          const current = entries.get(id);
          if (!current || current.requestId !== requestId) return;
          current.failed = false;
          current.timer = null;
          onChange(id);
        }, failureMs);
      }
      onChange(id);
      return true;
    }

    return { begin, finish, snapshot };
  }

  return { createClientRescanState };
});
