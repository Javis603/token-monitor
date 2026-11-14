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

const MIN_HEAP_TOTAL_BYTES = 64 * 1024 * 1024;
const RETAINED_HEADROOM_BYTES = 32 * 1024 * 1024;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function defaultCollect() {
  const { Session } = require('node:inspector/promises');
  const session = new Session();
  session.connect();
  return session.post('HeapProfiler.collectGarbage').finally(() => session.disconnect());
}

function createIdleHeapCollector(options = {}) {
  const intervalMs = Math.max(1000, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const isIdle = options.isIdle || (() => true);
  const getHeap = options.getHeap || (() => process.memoryUsage());
  const collect = options.collect || defaultCollect;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  let timer = null;
  let running = false;
  let stopped = false;
  let thresholdBytes = MIN_HEAP_TOTAL_BYTES;

  async function run() {
    if (stopped || running) return false;
    if (!isIdle()) return false;
    if (getHeap().heapTotal < thresholdBytes) return false;
    running = true;
    try {
      await collect();
      const retained = getHeap().heapUsed;
      thresholdBytes = Math.max(MIN_HEAP_TOTAL_BYTES, retained + RETAINED_HEADROOM_BYTES);
      return true;
    } catch (_) {
      // Heap collection is best effort; an inspector failure must not affect
      // the widget or make the next check impossible.
      return false;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer !== null || stopped) return;
    timer = setIntervalFn(() => { void run(); }, intervalMs);
    timer?.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
  }

  return { start, stop, run };
}

module.exports = { createIdleHeapCollector, DEFAULT_INTERVAL_MS, MIN_HEAP_TOTAL_BYTES };
