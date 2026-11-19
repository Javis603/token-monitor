'use strict';

const DEFAULT_TERMINATION_GRACE_MS = 2000;
const DEFAULT_TERMINATION_CLOSE_GRACE_MS = 5000;
// Enough for every subprocess one collector can have running at once.
const LIVE_SUBPROCESS_SLOTS = 16;

// A worker thread's subprocesses are children of the whole process, and they
// outlive it. When the process exits before the worker has handled a stop, the
// worker never gets to terminate them, so a hung tokscale would keep running.
// A worker that owns subprocesses registers a shared table here, and every
// subprocess this module terminates is listed in it while it runs, so the owning
// thread can signal them synchronously on its way out (usageHost.js).
let liveSubprocessTable = null;

function createLiveSubprocessTable() {
  return new Int32Array(new SharedArrayBuffer(LIVE_SUBPROCESS_SLOTS * Int32Array.BYTES_PER_ELEMENT));
}

function trackLiveSubprocesses(table) {
  liveSubprocessTable = table instanceof Int32Array ? table : null;
}

// Returns the function that removes it again. A full table leaves the extra
// subprocess untracked rather than failing its spawn.
function registerLiveSubprocess(child) {
  const table = liveSubprocessTable;
  const pid = child?.pid;
  if (!table || !Number.isInteger(pid) || pid <= 0) return () => {};
  for (let slot = 0; slot < table.length; slot += 1) {
    if (Atomics.compareExchange(table, slot, 0, pid) === 0) {
      return () => { Atomics.compareExchange(table, slot, pid, 0); };
    }
  }
  return () => {};
}

function signalLiveSubprocesses(table, signal = 'SIGTERM', kill = process.kill.bind(process)) {
  for (let index = 0; index < table.length; index += 1) {
    const pid = Atomics.load(table, index);
    if (pid <= 0) continue;
    try { kill(pid, signal); } catch (_) { /* already gone */ }
  }
}

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
  // Listed until it has exited: its PID is free for reuse from then on.
  const untrack = registerLiveSubprocess(child);
  child.once?.('exit', untrack);

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
    untrack();
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
  createLiveSubprocessTable,
  createSubprocessTermination,
  signalLiveSubprocesses,
  trackLiveSubprocesses,
  terminationUnconfirmedError,
  DEFAULT_TERMINATION_GRACE_MS,
  DEFAULT_TERMINATION_CLOSE_GRACE_MS
};
