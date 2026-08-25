'use strict';

const DEFAULT_TERMINATION_GRACE_MS = 2000;
const DEFAULT_TERMINATION_CLOSE_GRACE_MS = 5000;

function terminationUnconfirmedError(cause, label = 'subprocess') {
  const error = new Error(`${label} did not close after forced termination`, {
    ...(cause instanceof Error ? { cause } : {})
  });
  error.code = 'termination-unconfirmed';
  for (const key of ['syncFailureStage', 'syncDetailCode', 'syncExitCode']) {
    if (cause && Object.prototype.hasOwnProperty.call(cause, key)) error[key] = cause[key];
  }
  return error;
}

// Request termination without treating delivery of SIGTERM as proof that the
// process is gone. Callers keep their operation pending until the child's
// `close` event, while this helper escalates a child that ignores the request.
// A second bounded grace reports an unconfirmed close so one kernel-stuck child
// cannot hold every later usage-runtime barrier forever.
function createSubprocessTermination(child, options = {}) {
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const graceMs = Math.max(0, Number(options.graceMs ?? DEFAULT_TERMINATION_GRACE_MS) || 0);
  const closeGraceMs = Math.max(
    0,
    Number(options.closeGraceMs ?? DEFAULT_TERMINATION_CLOSE_GRACE_MS) || 0
  );
  let forceTimer = null;
  let closeTimer = null;
  let requested = false;
  let closed = false;
  let unconfirmed = false;

  function armCloseReportGrace() {
    closeTimer = setTimer(() => {
      closeTimer = null;
      if (closed || unconfirmed) return;
      unconfirmed = true;
      try { options.onUnconfirmed?.(); } catch (_) {}
    }, closeGraceMs);
    if (typeof closeTimer?.unref === 'function') closeTimer.unref();
  }

  function request() {
    if (requested || closed) return false;
    requested = true;
    forceTimer = setTimer(() => {
      forceTimer = null;
      if (closed) return;
      try { child.kill('SIGKILL'); } catch (_) {}
      armCloseReportGrace();
    }, graceMs);
    if (typeof forceTimer?.unref === 'function') forceTimer.unref();
    try { child.kill('SIGTERM'); } catch (_) {}
    return true;
  }

  function confirmClosed() {
    closed = true;
    if (forceTimer !== null) clearTimer(forceTimer);
    if (closeTimer !== null) clearTimer(closeTimer);
    forceTimer = null;
    closeTimer = null;
  }

  return {
    confirmClosed,
    request
  };
}

module.exports = {
  createSubprocessTermination,
  terminationUnconfirmedError,
  DEFAULT_TERMINATION_GRACE_MS,
  DEFAULT_TERMINATION_CLOSE_GRACE_MS
};
