'use strict';

// Where the file watcher physically runs.
//
// chokidar's close() is synchronous on the calling thread and superlinear in
// watched-directory count (measured on a real tree: ~1.1s for 548 dirs, ~12s
// for 1820). Every tracked-client change rewrites the watch roots, so on the
// owning thread that teardown froze the widget for about a second per toggle.
//
// One worker per coordinator, reused across collector restarts. That is not an
// optimisation: it is what preserves the invariant the synchronous close used
// to provide, namely that the old watcher is fully gone before a new one starts
// on the same paths. Spawning a second worker per restart would instead overlap
// two full descriptor sets, and on Linux the inotify budget is per-user and
// shared with editors, so the overlap could trip the exhaustion fallback, which
// is deliberately sticky for the process.
//
// unwatch() is not an alternative for incremental root edits: it stops event
// delivery but retains the descriptors (verified: 2613 fds before and after).
//
// The in-process implementation is a real fallback, not dead code. A worker can
// fail asynchronously (a Worker constructor does not throw on a missing or
// broken module; it emits 'error' and exits afterwards), and watching on this
// thread is worse for latency but still correct. It is also what the collector's
// watch-behaviour tests drive, since the reaction logic is identical on both.

const WORKER_PATH = require.resolve('./watcherWorker');
const CLOSE_REPORT_GRACE_MS = 30_000;

function inProcessRequested(env = process.env) {
  const raw = String(env.TOKEN_MONITOR_WATCH_IN_PROCESS ?? '').trim().toLowerCase();
  if (!raw) return false;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function createInProcessWatcherHost(config = {}, handlers = {}) {
  // Required lazily so a worker-hosted run never loads chokidar on the owning
  // thread, and so the collector's tests can still swap chokidar.watch.
  const chokidar = require('chokidar');
  const { watcherOptions, watchIgnoreMatcher } = require('./collector');
  const watcher = chokidar.watch(
    config.dirs,
    watcherOptions(config.usePolling === true, watchIgnoreMatcher(config.clients))
  );
  watcher.on('all', (event, filePath) => handlers.onEvent?.(event, filePath));
  watcher.on('error', (error) => handlers.onError?.(error));
  watcher.on('ready', () => handlers.onReady?.());
  return {
    kind: 'in-process',
    close({ skipClose = false } = {}) {
      if (skipClose) return;
      try { watcher.close(); } catch (_) { /* teardown must not throw */ }
    }
  };
}

// Exported as a factory rather than only as a module-level singleton: tests run
// concurrently and a future second collector in one process must not share this
// state. Production uses the default instance below.
function createWatcherCoordinator(deps = {}) {
  const WorkerClass = deps.Worker || require('node:worker_threads').Worker;
  const workerPath = deps.workerPath || WORKER_PATH;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;

  let worker = null;
  let workerDisabled = false;
  // Per instance rather than one coordinator-wide flag: a flag would let a
  // terminate we asked for mask a genuine failure of the worker that replaced it.
  const expectedExits = new WeakSet();
  let revision = 0;
  let pendingStopRevision = null;
  let current = null;
  let inProcessHost = null;
  let graceTimer = null;

  function clearGrace() {
    if (!graceTimer) return;
    clearTimer(graceTimer);
    graceTimer = null;
  }

  function forceTerminate() {
    clearGrace();
    pendingStopRevision = null;
    if (!worker) return;
    const dying = worker;
    worker = null;
    expectedExits.add(dying);
    void dying.terminate();
  }

  // A failing worker emits 'error' and then 'exit', so this runs twice for one
  // failure. Without both guards the second call builds a second in-process
  // watcher and abandons the first, reintroducing the descriptor overlap this
  // design exists to prevent.
  function fallBackToInProcess(error, failedWorker) {
    if (workerDisabled) return;
    if (failedWorker && worker && worker !== failedWorker) return;
    worker = null;
    workerDisabled = true;
    clearGrace();
    if (!current) return;
    current.handlers.onHostFallback?.(error);
    inProcessHost = createInProcessWatcherHost(current.config, current.handlers);
  }

  function onMessage(message) {
    if (message?.type === 'stopped') {
      // Routed before the owner lookup: a normal stop clears `current` by
      // definition, so gating this on an owner meant the ack could never
      // arrive and the grace timer always fired. Matched on revision so a late
      // ack from an earlier stop cannot clear the current one's timer.
      if (message.revision !== pendingStopRevision) return;
      pendingStopRevision = null;
      clearGrace();
      return;
    }
    const owner = current;
    if (!owner) return;
    // A watcher that is still tearing down can emit between the owner moving on
    // and the close completing, and those events belong to the previous roots.
    if (message?.revision !== undefined && message.revision !== owner.revision) return;
    const handlers = owner.handlers;
    if (message?.type === 'event') {
      handlers.onEvent?.(message.event, message.filePath);
      return;
    }
    if (message?.type === 'ready') {
      handlers.onReady?.();
      return;
    }
    if (message?.type === 'error') {
      const error = new Error(message.message || 'watcher error');
      // Rebuild the code so the descriptor-exhaustion check sees what chokidar
      // would have given it directly.
      if (message.code) error.code = message.code;
      handlers.onError?.(error);
    }
  }

  function ensureWorker() {
    if (worker || workerDisabled) return worker;
    try {
      const spawned = new WorkerClass(workerPath, {});
      // Listeners first, then unref: attaching a 'message' listener refs the
      // underlying MessagePort, so unref'ing before this would be undone and
      // the watcher would keep the process alive.
      spawned.on('message', onMessage);
      spawned.on('error', (error) => {
        if (expectedExits.has(spawned)) return;
        fallBackToInProcess(error, spawned);
      });
      spawned.on('exit', (code) => {
        if (expectedExits.has(spawned)) return;
        // An exit we did not ask for means the watcher is gone; a Worker that
        // fails to load its module lands here rather than throwing above.
        fallBackToInProcess(new Error(`watch worker exited unexpectedly (code ${code})`), spawned);
      });
      spawned.unref();
      worker = spawned;
    } catch (error) {
      fallBackToInProcess(error);
    }
    return worker;
  }

  function acquire(config = {}, handlers = {}) {
    revision += 1;
    const owned = revision;
    current = { revision: owned, config, handlers };
    clearGrace();
    pendingStopRevision = null;

    if (inProcessHost) {
      inProcessHost.close();
      inProcessHost = null;
    }
    if (workerDisabled) {
      inProcessHost = createInProcessWatcherHost(config, handlers);
      return makeHandle(owned, 'in-process');
    }

    const active = ensureWorker();
    if (!active) return makeHandle(owned, 'in-process');

    active.postMessage({ type: 'configure', revision: owned, config });
    return makeHandle(owned, 'worker');
  }

  function makeHandle(owned, kind) {
    return {
      kind,
      close({ skipClose = false } = {}) {
        if (current?.revision !== owned) return;
        current = null;
        if (inProcessHost) {
          inProcessHost.close({ skipClose });
          inProcessHost = null;
          return;
        }
        if (!worker) return;
        if (skipClose) {
          // Quit path: descriptors go with the process, so skip the slow
          // teardown rather than waiting for a thread we are about to lose.
          forceTerminate();
          return;
        }
        revision += 1;
        pendingStopRevision = revision;
        try {
          worker.postMessage({ type: 'stop', revision });
        } catch (_) {
          pendingStopRevision = null;
          forceTerminate();
          return;
        }
        // Only covers a worker that never answers. A normal stop leaves the
        // thread idle and reusable, so the next acquire skips spawn cost.
        clearGrace();
        graceTimer = setTimer(forceTerminate, CLOSE_REPORT_GRACE_MS);
        if (typeof graceTimer.unref === 'function') graceTimer.unref();
      }
    };
  }

  return {
    acquire,
    // Test seam: asserts on which host actually served the last acquire.
    inspect: () => ({
      hasWorker: Boolean(worker),
      workerDisabled,
      inProcess: Boolean(inProcessHost),
      awaitingStopAck: pendingStopRevision !== null
    })
  };
}

const defaultCoordinator = createWatcherCoordinator();

function createWatcherHost(config = {}, handlers = {}, deps = {}) {
  const useInProcess = deps.inProcess ?? inProcessRequested(deps.env || process.env);
  if (useInProcess) return createInProcessWatcherHost(config, handlers);
  const coordinator = deps.coordinator || defaultCoordinator;
  return coordinator.acquire(config, handlers);
}

module.exports = {
  createInProcessWatcherHost,
  createWatcherCoordinator,
  createWatcherHost,
  inProcessRequested
};
