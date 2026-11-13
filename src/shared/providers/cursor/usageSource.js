'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { abortReason, throwIfAborted } = require('../../abortSignal');
const { CURSOR_EXPLICIT_SYNC_TIMEOUT_MS } = require('./auth');
const { withCursorLifecycle } = require('./lifecycle');

function emptySnapshot(context) {
  return { context, revision: 0, today: { entries: [] }, month: { entries: [] },
    allTime: { entries: [] }, graph: null };
}

// Tokscale's scan diagnostics change on every read, including an empty cache,
// and it lists report rows and each day's graph clients in no fixed order: two
// reads of an unchanged cache differ only in that order. Compare rows as a set
// and ignore the diagnostics; keep the complete raw snapshot.
const rowSet = rows => (Array.isArray(rows) ? rows.map(row => JSON.stringify(row)).sort() : rows);

function reportContent(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return report;
  const content = { ...report, entries: rowSet(report.entries), sessions: rowSet(report.sessions) };
  delete content.processingTimeMs;
  return content;
}

function graphContent(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return graph;
  const content = { ...graph };
  if (graph.meta && typeof graph.meta === 'object' && !Array.isArray(graph.meta)) {
    content.meta = { ...graph.meta };
    delete content.meta.generatedAt;
  }
  if (Array.isArray(graph.contributions)) {
    content.contributions = graph.contributions.map(day => (day && typeof day === 'object' ? { ...day, clients: rowSet(day.clients) } : day));
  }
  return content;
}

// Revisions restart with the process. A persisted anchor records this instead,
// so a restart can tell whether the cache still holds the usage it was built
// from. Null until the first complete read.
function snapshotUsageKey(snapshot) {
  if (!snapshot || snapshot.revision === 0) return null;
  const hash = createHash('sha256');
  for (const period of ['today', 'month', 'allTime']) hash.update(`${JSON.stringify(reportContent(snapshot[period]) ?? null)}\n`);
  return hash.digest('hex');
}

// Long cloud imports own the Cursor lane, not the collector's local scan lane.
// Only a complete serial cache read is published; readers keep this immutable
// snapshot while the next import or an account operation owns the cache.
function createCursorUsageSource({ sync, read, onChange, onError, signal, context }) {
  let snapshot = emptySnapshot(context);
  let desiredContext = context;
  let initialized = false;
  let active = null;
  let controller = null;
  let forcePending = false;
  let syncPending = false;
  let pendingSyncOptions = null;
  let scheduledSync = false;
  let readPending = false;
  let stopped = false;
  let contextWaiters = [];
  const failureCallbacks = new Set();
  const queuedFailureCallbacks = new Set();

  const changedContext = (next) => next.day !== desiredContext.day || next.pricing !== desiredContext.pricing || next.calendar !== desiredContext.calendar;
  async function readComplete(current, currentSignal) {
    const next = await withCursorLifecycle(() => read(current, currentSignal), { signal: currentSignal });
    throwIfAborted(currentSignal);
    if (changedContext(current)) return;
    const changed = snapshot.revision === 0 || !isDeepStrictEqual(snapshot.context, current)
      || ['today', 'month', 'allTime'].some(key => !isDeepStrictEqual(reportContent(snapshot[key]), reportContent(next[key])))
      || !isDeepStrictEqual(graphContent(snapshot.graph), graphContent(next.graph))
      || snapshot.graphFailed !== next.graphFailed;
    if (changed) snapshot = { ...next, context: current, revision: snapshot.revision + 1 };
    initialized = true;
    readPending = false;
    const waiters = contextWaiters;
    contextWaiters = [];
    for (const waiter of waiters) {
      if (waiter.context.day === current.day && waiter.context.pricing === current.pricing && waiter.context.calendar === current.calendar) waiter.resolve();
      else waiter.reject(new Error('Cursor snapshot context superseded'));
    }
    // Even unchanged usage must publish the completed sync's health state.
    onChange?.({ changed });
  }

  function refresh(options = {}) {
    if (stopped || signal.aborted) return Promise.resolve(false);
    if (options.context && changedContext(options.context)) {
      desiredContext = options.context;
      readPending = true;
      // Pricing and period boundaries require a fresh offline view. Cancel the
      // obsolete import, then wait for its close barrier before reading again.
      controller?.abort(new Error('Cursor snapshot inputs changed'));
    }
    forcePending ||= options.force === true;
    const queuedSync = active && (options.force === true || options.source === true
      || (options.readOnly !== true && !scheduledSync));
    if (queuedSync) {
      syncPending = true;
      pendingSyncOptions = options;
      scheduledSync = true;
    }
    if (typeof options.onFailure === 'function') {
      (queuedSync ? queuedFailureCallbacks : failureCallbacks).add(options.onFailure);
    }
    if (active) return active;
    scheduledSync = options.readOnly !== true;
    const operation = async () => {
      let first = true;
      let successful = true;
      do {
        const force = forcePending;
        forcePending = false;
        const wantsSync = force || syncPending || (first && options.readOnly !== true);
        const syncOptions = pendingSyncOptions || options;
        pendingSyncOptions = null;
        syncPending = false;
        scheduledSync = wantsSync;
        for (const callback of queuedFailureCallbacks) failureCallbacks.add(callback);
        queuedFailureCallbacks.clear();
        const current = desiredContext;
        const needsRead = !initialized || readPending || snapshot.graphFailed;
        readPending = false;
        controller = new AbortController();
        const abort = () => controller.abort(abortReason(signal));
        signal.addEventListener('abort', abort, { once: true });
        try {
          throwIfAborted(signal);
          if (needsRead) await readComplete(current, controller.signal);
          if (wantsSync) {
            const attempted = await sync({
              signal: controller.signal,
              minIntervalMs: force ? 0 : typeof syncOptions.minIntervalMs === 'function'
                ? syncOptions.minIntervalMs() : syncOptions.minIntervalMs,
              timeoutMs: syncOptions.timeoutMs ?? CURSOR_EXPLICIT_SYNC_TIMEOUT_MS,
              onFailure: kind => { for (const callback of failureCallbacks) callback(kind); }
            });
            // A source event arriving during an import may now be inside the
            // success floor or failure backoff. Put it back on the collector's
            // deadline queue instead of consuming an event no attempt read.
            if (!attempted && syncOptions.source === true) {
              for (const callback of failureCallbacks) callback('cursor');
            }
            failureCallbacks.clear();
            // A failed import still permits a complete offline read: logout
            // may have removed an account, and retained files remain useful.
            if (attempted || force) await readComplete(current, controller.signal);
          }
        } catch (error) {
          if (signal.aborted || stopped || !controller.signal.aborted) {
            const waiters = contextWaiters;
            contextWaiters = [];
            for (const waiter of waiters) waiter.reject(error);
          }
          if (signal.aborted || stopped) return false;
          if (controller.signal.aborted && wantsSync) {
            syncPending = true;
            pendingSyncOptions ||= syncOptions;
          } else if (!controller.signal.aborted) {
            // Retry a failed context read on the next request; desiredContext
            // alone is not evidence that a matching snapshot was published.
            initialized = false;
            successful = false;
            onError?.(error);
          }
        } finally {
          signal.removeEventListener('abort', abort);
          controller = null;
          scheduledSync = false;
        }
        first = false;
      } while (!stopped && !signal.aborted && (forcePending || readPending || syncPending));
      // Release the lane in the same turn the loop decides to exit. A request
      // landing after that decision would otherwise join a finished loop, and
      // its sync would never run.
      if (active === pending) active = null;
      return successful;
    };
    const pending = Promise.resolve().then(operation).finally(() => {
      if (active === pending) active = null;
    });
    active = pending;
    // Watch/interval callers deliberately do not wait for the network lane.
    void pending.catch(error => { if (!stopped && !signal.aborted) onError?.(error); });
    return pending;
  }

  return {
    refresh,
    getSnapshot: () => snapshot,
    contextMatches: next => next.day === snapshot.context.day && next.pricing === snapshot.context.pricing && next.calendar === snapshot.context.calendar,
    readCache(next) {
      if (stopped || signal.aborted) return Promise.reject(abortReason(signal));
      readPending = true;
      const ready = new Promise((resolve, reject) => contextWaiters.push({ context: next, resolve, reject }));
      void refresh({ context: next, readOnly: true });
      return ready;
    },
    ensureContext(next) {
      if (stopped || signal.aborted) return Promise.reject(abortReason(signal));
      if (next.day === snapshot.context.day && next.pricing === snapshot.context.pricing && next.calendar === snapshot.context.calendar) return Promise.resolve();
      const ready = new Promise((resolve, reject) => contextWaiters.push({ context: next, resolve, reject }));
      void refresh({ context: next, readOnly: true });
      return ready;
    },
    stop() {
      stopped = true;
      controller?.abort(new Error('Cursor usage source stopped'));
      const waiters = contextWaiters;
      contextWaiters = [];
      for (const waiter of waiters) waiter.reject(new Error('Cursor usage source stopped'));
    },
    whenIdle: () => active || Promise.resolve(),
    isActive: () => active !== null
  };
}

module.exports = { createCursorUsageSource, snapshotUsageKey };
