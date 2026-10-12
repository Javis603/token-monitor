'use strict';

// File events are the primary trigger. The timer only renews short-lived
// observations and reconciles missed events; unavailable watches stay fast.
function createSessionActivityScheduler(options, timers = {}) {
  const later = timers.setTimeout || setTimeout;
  const cancel = timers.clearTimeout || clearTimeout;
  const now = timers.now || (() => performance.now());
  let timer = null;
  let deadline = 0;
  let running = null;
  let dirty = false;
  let stopped = false;

  function arm(delay) {
    if (timer !== null) cancel(timer);
    timer = later(run, delay);
  }
  function reconciliationDelay() {
    if (!options.nativeEventsReady()) return 3000;
    // Renew at one third of the 30-second lease, leaving room for a busy tick.
    return options.needsRenewal() ? 10_000 : 60_000;
  }
  function request() {
    if (stopped) return;
    dirty = true;
    if (!deadline) deadline = now() + 3000;
    if (running) return;
    arm(Math.max(1, Math.min(500, deadline - now())));
  }
  function run() {
    timer = null;
    deadline = 0;
    if (stopped || running) return;
    dirty = false;
    let retry = false;
    running = Promise.resolve().then(options.refresh).then((completed) => {
      if (completed === false) retry = true;
    }).catch((error) => { retry = true; options.onError?.(error); }).finally(() => {
      running = null;
      if (!stopped) {
        if (retry) { deadline = 0; arm(3000); }
        else if (dirty) request();
        else arm(reconciliationDelay());
      }
    });
  }
  return {
    start() { if (!stopped && timer === null && !running) arm(3000); },
    request,
    stop() { stopped = true; if (timer !== null) cancel(timer); timer = null; },
    whenIdle() { return running || Promise.resolve(); }
  };
}

module.exports = { createSessionActivityScheduler };
