'use strict';

// Reclaim V8's committed-but-unused pages while the widget is idle.
//
// A collection burst (the initial scan, a large Hub snapshot) grows the young
// and old generations to their allocation-rate peak. V8 does not collect again
// once the objects die because nothing is asking for the space, so the main
// process keeps hundreds of megabytes committed after the numbers on screen
// have long settled. The usage worker does the same after a publish; main has
// no such boundary, so it checks on a 30-second idle timer instead.
//
// A full collection blocks the main thread for tens of milliseconds. That is
// why it only runs when no app window has focus, and why a collection that
// reclaims little raises the next threshold instead of repeating every tick.
//
// Renderers keep their own committed heap and expose `gc` through the app's
// js-flags switch. Theirs is independent of main's threshold; the app's callback
// runs it on every idle pass, but that callback leaves a visible window alone.
// Main itself only collects above its threshold.

const MIN_HEAP_TOTAL_BYTES = 64 * 1024 * 1024;
const RETAINED_HEADROOM_BYTES = 32 * 1024 * 1024;
const DEFAULT_INTERVAL_MS = 30 * 1000;
// Keep a one-shot startup check at one minute alongside the recurring timer.
const DEFAULT_INITIAL_DELAY_MS = 60 * 1000;
// A hung inspector session would otherwise leave `running` true forever and
// stop every later pass. Main collection is cheap; ten seconds is already far
// beyond a healthy collection.
const DEFAULT_COLLECT_TIMEOUT_MS = 10 * 1000;
// After this many consecutive main-pass failures, stop asking a broken
// inspector to collect. Renderer collection is independent and keeps running.
const MAX_CONSECUTIVE_MAIN_FAILURES = 3;

function collectWithTimeout(session, timeoutMs = DEFAULT_COLLECT_TIMEOUT_MS) {
  // Start the post first: if the session is already unusable it throws here,
  // before a timeout timer exists to reject an unobserved promise.
  let collection;
  try {
    collection = session.post('HeapProfiler.collectGarbage');
  } catch (error) {
    return Promise.reject(error);
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`idle heap collection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([collection, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function defaultCollect() {
  const { Session } = require('node:inspector/promises');
  const session = new Session();
  session.connect();
  try {
    await collectWithTimeout(session);
  } finally {
    try { session.disconnect(); } catch (_) {}
  }
}

function createIdleHeapCollector(options = {}) {
  const intervalMs = Math.max(1000, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const initialDelayMs = Math.max(0, Number(options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS));
  const isIdle = options.isIdle || (() => true);
  const getHeap = options.getHeap || (() => process.memoryUsage());
  const collect = options.collect || defaultCollect;
  const collectRenderers = options.collectRenderers || null;
  const log = options.log || ((message) => console.warn(message));
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  let timer = null;
  let initialTimer = null;
  let running = false;
  let stopped = false;
  let thresholdBytes = MIN_HEAP_TOTAL_BYTES;
  let mainFailures = 0;
  let mainDisabled = false;

  async function run() {
    if (stopped || running) return false;
    if (!isIdle()) return false;
    const collectMain = !mainDisabled && getHeap().heapTotal >= thresholdBytes;
    if (!collectMain && !collectRenderers) return false;
    running = true;
    let collected = false;
    try {
      if (collectMain) {
        try {
          await collect();
          const retained = getHeap().heapUsed;
          thresholdBytes = Math.max(MIN_HEAP_TOTAL_BYTES, retained + RETAINED_HEADROOM_BYTES);
          collected = true;
          mainFailures = 0;
        } catch (error) {
          // Heap collection is best effort; an inspector failure must not
          // affect the widget or make the next check impossible.
          mainFailures += 1;
          if (mainFailures >= MAX_CONSECUTIVE_MAIN_FAILURES && !mainDisabled) {
            mainDisabled = true;
            try {
              log(`[idle-heap] main heap collection disabled after ${mainFailures} consecutive failures: ${error?.message || error}`);
            } catch (_) {}
          }
        }
      }
      if (stopped) return collected;
      if (collectRenderers && (!collectMain || isIdle())) {
        try {
          await collectRenderers();
        } catch (_) {
          // A renderer that is gone or unresponsive is skipped; the next idle
          // pass asks the remaining processes again.
        }
      }
      return collected;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer !== null || initialTimer !== null || stopped) return;
    initialTimer = setTimeoutFn(() => {
      initialTimer = null;
      void run();
    }, initialDelayMs);
    initialTimer?.unref?.();
    timer = setIntervalFn(() => { void run(); }, intervalMs);
    timer?.unref?.();
  }

  function stop() {
    stopped = true;
    if (initialTimer !== null) clearTimeoutFn(initialTimer);
    initialTimer = null;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
  }

  return { start, stop, run };
}

module.exports = {
  collectWithTimeout,
  createIdleHeapCollector,
  DEFAULT_COLLECT_TIMEOUT_MS,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_INTERVAL_MS,
  MIN_HEAP_TOTAL_BYTES
};
