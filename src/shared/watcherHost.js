'use strict';

// Where the file watcher physically runs.
//
// chokidar's close() is synchronous and superlinear in watched directory count
// (measured on a real tree: ~1.1s for 548 dirs, ~12s for 1820). Every tracked-
// client change rebuilds the watch roots, so on the main thread that teardown
// froze the widget for about a second per toggle. Moving only the watcher to a
// worker thread drops the owning thread's worst stall to well under a frame
// while the worker still pays the same close cost.
//
// unwatch() is not an alternative: it stops event delivery but retains the
// descriptors (verified: 2613 fds before and after), so incremental root
// updates would leak toward EMFILE and trip the sticky polling fallback.
//
// The in-process implementation is kept as a real fallback and is what the
// collector's watch-behaviour tests drive, since the reaction logic they cover
// is identical on both paths.

// require.resolve rather than a path join, so the lookup keeps working inside
// an asar archive — same as sessionDetailResolver.js does for its worker.
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

function createWorkerWatcherHost(config = {}, handlers = {}, deps = {}) {
  const { Worker } = deps.workerThreads || require('node:worker_threads');
  const worker = new Worker(deps.workerPath || WORKER_PATH, {
    workerData: {
      dirs: config.dirs,
      clients: config.clients,
      usePolling: config.usePolling === true
    }
  });
  // Nothing here should keep the process alive: the collector's own timers
  // decide that, and a watcher that outlived them would hold quit open.
  worker.unref();
  let closing = false;
  let graceTimer = null;

  const done = () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    void worker.terminate();
  };

  worker.on('message', (message) => {
    if (message?.type === 'event') {
      if (!closing) handlers.onEvent?.(message.event, message.filePath);
      return;
    }
    if (message?.type === 'error') {
      if (closing) return;
      // Rebuild an Error so `code` reaches the descriptor-exhaustion check the
      // same way chokidar's own error object would.
      const error = new Error(message.message || 'watcher error');
      if (message.code) error.code = message.code;
      handlers.onError?.(error);
      return;
    }
    if (message?.type === 'ready') {
      if (!closing) handlers.onReady?.();
      return;
    }
    if (message?.type === 'closed') done();
  });
  // A worker that dies on its own (failed spawn, thrown module) must not leave
  // the collector believing it is watching.
  worker.on('error', (error) => {
    if (closing) return;
    handlers.onError?.(error);
  });

  return {
    kind: 'worker',
    close({ skipClose = false } = {}) {
      if (closing) return;
      closing = true;
      // Quit path: descriptors go with the process, so skip the slow teardown
      // entirely rather than waiting for a thread we are about to lose.
      if (skipClose) {
        void worker.terminate();
        return;
      }
      // Returns immediately. The worker pays chokidar's teardown on its own
      // thread and reports back; the grace timer only covers a worker that
      // never answers, so descriptors cannot be pinned forever.
      try {
        worker.postMessage({ type: 'close' });
      } catch (_) {
        done();
        return;
      }
      graceTimer = setTimeout(done, CLOSE_REPORT_GRACE_MS);
      if (typeof graceTimer.unref === 'function') graceTimer.unref();
    }
  };
}

function createWatcherHost(config = {}, handlers = {}, deps = {}) {
  const useInProcess = deps.inProcess ?? inProcessRequested(deps.env || process.env);
  if (useInProcess) return createInProcessWatcherHost(config, handlers);
  try {
    return createWorkerWatcherHost(config, handlers, deps);
  } catch (error) {
    // Worker threads are unavailable or the module failed to spawn. Watching on
    // the owning thread is worse for latency but still correct, and it is what
    // this code did before workers existed.
    handlers.onHostFallback?.(error);
    return createInProcessWatcherHost(config, handlers);
  }
}

module.exports = {
  createInProcessWatcherHost,
  createWatcherHost,
  createWorkerWatcherHost,
  inProcessRequested
};
