'use strict';

// Reclaim V8's committed-but-unused pages while the widget is idle.
//
// A collection burst (the initial scan, a large Hub snapshot) grows the young
// and old generations to their allocation-rate peak. V8 does not collect again
// once the objects die because nothing is asking for the space, so the main
// process keeps hundreds of megabytes committed after the numbers on screen
// have long settled. The usage worker does the same after a publish; main has
// no such boundary, so it checks on a slow idle timer instead.
//
// A full collection blocks the main thread for tens of milliseconds. That is
// why it only runs when no window has focus, and why a collection that reclaims
// little raises the next threshold instead of repeating every tick.
//
// Renderers keep their own committed heap and expose `gc` through the app's
// js-flags switch. Theirs is independent of main's: the option runs on every
// idle pass, while main itself only collects above its threshold.

const MIN_HEAP_TOTAL_BYTES = 64 * 1024 * 1024;
const RETAINED_HEADROOM_BYTES = 32 * 1024 * 1024;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
// The first complete collection usually finishes well inside a minute. Check
// once then, so the startup high-water is returned before the steady-state
// cadence rather than lingering for five minutes.
const DEFAULT_INITIAL_DELAY_MS = 60 * 1000;

function defaultCollect() {
  const { Session } = require('node:inspector/promises');
  const session = new Session();
  session.connect();
  return session.post('HeapProfiler.collectGarbage').finally(() => session.disconnect());
}

function createIdleHeapCollector(options = {}) {
  const intervalMs = Math.max(1000, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const initialDelayMs = Math.max(0, Number(options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS));
  const isIdle = options.isIdle || (() => true);
  const getHeap = options.getHeap || (() => process.memoryUsage());
  const collect = options.collect || defaultCollect;
  const collectRenderers = options.collectRenderers || null;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  let timer = null;
  let initialTimer = null;
  let running = false;
  let stopped = false;
  let thresholdBytes = MIN_HEAP_TOTAL_BYTES;

  async function run() {
    if (stopped || running) return false;
    if (!isIdle()) return false;
    const collectMain = getHeap().heapTotal >= thresholdBytes;
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
        } catch (_) {
          // Heap collection is best effort; an inspector failure must not
          // affect the widget or make the next check impossible.
        }
      }
      if (collectRenderers) {
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

module.exports = { createIdleHeapCollector, DEFAULT_INITIAL_DELAY_MS, DEFAULT_INTERVAL_MS, MIN_HEAP_TOTAL_BYTES };
