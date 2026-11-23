'use strict';

// Keeps only the newest value in a burst and hands it to `flush` at most once
// per `intervalMs`. The first enqueue after the window is free flushes at once,
// so a surface is never blank waiting for a timer. Used for surfaces that are
// rebuilt from scratch on every value: the dock's cells are cheap to hold and
// expensive to paint, and a live agent stream would otherwise repaint them every
// few seconds for numbers nobody can read that fast.
function createLatestCoalescer({ flush, intervalMs, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let pending = null;
  // No push yet: the first value must not wait for a window that never started.
  let lastFlushAt = -Infinity;

  function run() {
    timer = null;
    if (pending === null) return;
    const value = pending;
    pending = null;
    lastFlushAt = now();
    flush(value);
  }

  function enqueue(value) {
    if (value === null || value === undefined) return;
    pending = value;
    if (timer) return;
    const wait = intervalMs - (now() - lastFlushAt);
    if (wait <= 0) {
      run();
      return;
    }
    timer = setTimer(run, wait);
    timer?.unref?.();
  }

  // An immediate push through another path should not leave a timer armed for
  // a value that may already be older than what was painted; the caller drops
  // the pending read instead of replaying it into the new window.
  function cancel() {
    if (timer) clearTimer(timer);
    timer = null;
    pending = null;
  }

  return { enqueue, cancel, pending: () => pending };
}

module.exports = { createLatestCoalescer };
