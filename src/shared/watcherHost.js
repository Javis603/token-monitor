'use strict';

// Where the file watcher physically runs.
//
// chokidar's close() is synchronous on the calling thread and superlinear in
// watched-directory count (measured on a real tree: ~1.1s for 548 dirs, ~12s
// for 1820). Every tracked-client change rewrites the watch roots, so on the
// owning thread that teardown froze the widget for about a second per toggle.
//
// One worker at a time per coordinator. A collector restart terminates that
// worker and waits for its exit before applying the latest replacement config.
// This preserves the invariant the synchronous close used to provide — the old
// watcher is fully gone before a new one starts — while also releasing the
// worker's V8/libuv/native allocation high-water. Spawning the replacement
// before exit would overlap two descriptor sets, and on Linux the inotify budget
// is per-user and shared with editors, so the overlap could trip the exhaustion
// fallback, which is deliberately sticky for the process.
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
  // A worker thread keeps its V8/libuv/native allocator inside the Electron
  // browser process. Reusing it after closing a large chokidar tree leaves that
  // tree's allocation high-water charged to the app even though its descriptors
  // are gone, so every real owner change recycles the isolation boundary.

  let worker = null;
  let workerDisabled = false;
  // A rejected terminate does not prove the old native descriptors were
  // released. Once that happens, every later in-process owner must stay on
  // polling for the rest of this coordinator's lifetime.
  let forcePollingFallback = false;
  // Per instance rather than one coordinator-wide flag: a flag would let a
  // terminate we asked for mask a genuine failure of the worker that replaced it.
  const expectedExits = new WeakSet();
  // Why the failure is remembered rather than acted on: 'error' says the thread
  // threw and is being torn down, 'exit' says it has actually stopped. Only the
  // second proves its descriptors are gone, and starting a replacement watcher
  // in between is the overlap the normal and watchdog paths both avoid.
  const workerFailures = new WeakMap();
  let revision = 0;
  // Set while a thread is on its way out. `worker = null` happens synchronously
  // but terminate() only settles once the thread has actually exited, so this
  // gate, not the null, is what keeps a replacement from starting inside that
  // window and putting two descriptor sets back in flight.
  let terminating = null;
  let current = null;
  let inProcessHost = null;

  function fallbackConfig(config) {
    return forcePollingFallback ? { ...config, usePolling: true } : config;
  }

  function restoreCurrentWatcher() {
    if (!current) return;
    const active = ensureWorker();
    if (!active) return;
    active.postMessage({ type: 'configure', revision: current.revision, config: current.config });
  }

  // `restore` separates the two reasons we ever terminate. The quit path is
  // done with watching entirely; a wedged teardown is not, and the collector
  // that replaced the stopped one still expects a live watcher.
  function forceTerminate({ restore = false } = {}) {
    if (!worker) return;
    const dying = worker;
    worker = null;
    expectedExits.add(dying);
    const gate = Promise.resolve(dying.terminate());
    terminating = gate;
    gate.then(
      () => {
        if (terminating !== gate) return;
        terminating = null;
        // Latest-wins: whatever the owner is by now is what gets applied.
        if (restore) restoreCurrentWatcher();
      },
      (error) => {
        if (terminating !== gate) return;
        terminating = null;
        // The thread never confirmed it exited, so its descriptors cannot be
        // assumed released. Watching on this thread is worse for latency but
        // it is the one path that does not depend on that thread.
        if (restore) {
          forcePollingFallback = true;
          fallBackToInProcess(error);
        }
      }
    );
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
    if (!current) return;
    current.handlers.onHostFallback?.(error);
    // A rejected terminate does not prove the old worker released its native
    // descriptors. Polling is the only safe fallback on that path; ordinary
    // startup/crash failures still retain the configured native mode because
    // their exit event already confirmed release.
    inProcessHost = createInProcessWatcherHost(fallbackConfig(current.config), current.handlers);
  }

  function onMessage(message) {
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
        workerFailures.set(spawned, error);
      });
      spawned.on('exit', (code) => {
        if (expectedExits.has(spawned)) return;
        // An exit we did not ask for means the watcher is gone; a Worker that
        // fails to load its module lands here rather than throwing above, and
        // a thread that threw arrives carrying the error it reported first.
        const cause = workerFailures.get(spawned)
          || new Error(`watch worker exited unexpectedly (code ${code})`);
        workerFailures.delete(spawned);
        fallBackToInProcess(cause, spawned);
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
    if (inProcessHost) {
      inProcessHost.close();
      inProcessHost = null;
    }
    if (workerDisabled) {
      inProcessHost = createInProcessWatcherHost(fallbackConfig(config), handlers);
      return makeHandle(owned, 'in-process');
    }

    if (terminating) {
      // A thread is still exiting. `current` is already updated and the gate
      // applies the newest owner when it clears, so this stays latest-wins
      // rather than queueing a spawn behind every intervening change.
      return makeHandle(owned, 'worker');
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
        // Confirm the old thread has exited before restoreCurrentWatcher()
        // applies whichever owner is newest by then. This both bounds native
        // watcher memory and preserves the no-overlapping-descriptors invariant.
        forceTerminate({ restore: true });
      }
    };
  }

  return {
    acquire,
    // Test seam: asserts on which host actually served the last acquire.
    inspect: () => ({
      hasWorker: Boolean(worker),
      workerDisabled,
      forcePollingFallback,
      inProcess: Boolean(inProcessHost),
      terminating: terminating !== null
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
