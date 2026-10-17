'use strict';

const LIGHTWEIGHT_IDLE_MS = 60_000;

// Native hide is the policy boundary. Minimize and macOS occlusion must keep
// their taskbar/window identity. An async renderer veto fails closed.
function createLightweightWindow({ getWindow, enabled, prepare, release, setTimer = setTimeout, clearTimer = clearTimeout, idleMs = LIGHTWEIGHT_IDLE_MS }) {
  let timer = null;
  let epoch = 0;
  let stopped = false;
  let scheduledWindow = null;
  const released = new WeakSet();

  function cancel() {
    epoch += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
    scheduledWindow = null;
  }

  function eligible(win) {
    return !stopped && enabled() && win && win === getWindow()
      && !win.isDestroyed() && !win.isVisible() && !win.isMinimized();
  }

  function schedule() {
    const win = getWindow();
    if (!eligible(win)) { cancel(); return; }
    if (scheduledWindow === win) return;
    cancel();
    scheduledWindow = win;
    const token = epoch;
    timer = setTimer(async () => {
      timer = null;
      if (token !== epoch) return;
      if (!eligible(win)) { scheduledWindow = null; return; }
      let state;
      try { state = await prepare(win); } catch (_) { /* keep the UI on timeout/failure */ }
      if (token !== epoch) return;
      if (!eligible(win)) { scheduledWindow = null; return; }
      scheduledWindow = null;
      if (!state) { schedule(); return; }
      released.add(win);
      release(win, state);
    }, idleMs);
    timer?.unref?.();
  }

  return {
    cancel,
    schedule,
    isReleased: (win) => released.has(win),
    stop() { stopped = true; cancel(); }
  };
}

module.exports = { createLightweightWindow, LIGHTWEIGHT_IDLE_MS };
