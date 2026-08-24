'use strict';

const DEFAULT_TERMINATION_GRACE_MS = 2000;

// Request termination without treating delivery of SIGTERM as proof that the
// process is gone. Callers keep their operation pending until the child's
// `close` event, while this helper escalates a child that ignores the request.
function createSubprocessTermination(child, options = {}) {
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const graceMs = Math.max(0, Number(options.graceMs ?? DEFAULT_TERMINATION_GRACE_MS) || 0);
  let forceTimer = null;
  let requested = false;
  let closed = false;

  function request() {
    if (requested || closed) return false;
    requested = true;
    forceTimer = setTimer(() => {
      forceTimer = null;
      if (closed) return;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, graceMs);
    if (typeof forceTimer?.unref === 'function') forceTimer.unref();
    try { child.kill('SIGTERM'); } catch (_) {}
    return true;
  }

  function confirmClosed() {
    closed = true;
    if (forceTimer !== null) clearTimer(forceTimer);
    forceTimer = null;
  }

  return {
    confirmClosed,
    request
  };
}

module.exports = {
  createSubprocessTermination,
  DEFAULT_TERMINATION_GRACE_MS
};
