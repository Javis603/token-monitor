'use strict';

// Runs the Trae CN collect off the main thread. The decrypt + read is ~2s of
// synchronous CPU and 400MB of IO; doing it on the Electron main thread froze
// the widget on every collect. This mirrors sessionDetailResolver's one-shot
// worker pattern (workerData -> synchronous work -> postMessage -> exit).
//
// A worker that fails for a *mechanical* reason (spawn, timeout, non-zero exit
// with no message) falls back to the in-process path, which is slower but still
// correct. A business error the worker reported (a TRAE_* code) is surfaced
// as-is — re-running it in-process would only fail the same way and pay the
// 2s cost twice.

const { Worker } = require('node:worker_threads');

const { collectTraeSnapshot } = require('./traeUsage');

const TRAE_COLLECT_WORKER_TIMEOUT_MS = 60_000;

function workerError(payload) {
  const error = new Error(payload?.message || 'Trae collect worker failed');
  if (payload?.name) error.name = payload.name;
  if (payload?.code) error.code = payload.code;
  if (payload?.stack) error.stack = payload.stack;
  return error;
}

function runTraeCollectWorker(args = {}, deps = {}) {
  const WorkerClass = deps.Worker || Worker;
  const workerPath = deps.workerPath || require.resolve('./traeCollectWorker');
  const configuredTimeoutMs = Number(deps.timeoutMs ?? TRAE_COLLECT_WORKER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? Math.trunc(configuredTimeoutMs)
    : TRAE_COLLECT_WORKER_TIMEOUT_MS;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;

  return new Promise((resolve, reject) => {
    let worker;
    try {
      // workerData is structured-cloned, and functions are not cloneable — a
      // callback like onProgress in the args threw DataCloneError right here,
      // which the host records as a mechanical failure and permanently
      // disables the worker over, silently pinning every later collect to the
      // Electron main thread. Strip non-cloneable entries so the collect
      // actually runs off-thread; progress callbacks only fire on the
      // in-process fallback path.
      const cloneableArgs = {};
      for (const [key, value] of Object.entries(args)) {
        if (typeof value !== 'function') cloneableArgs[key] = value;
      }
      worker = new WorkerClass(workerPath, { workerData: cloneableArgs });
    } catch (error) {
      error.traeWorkerMechanical = true;
      reject(error);
      return;
    }
    let settled = false;
    let timer = null;

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      callback(value);
    }

    function terminateWorker() {
      try {
        worker.terminate()?.catch?.(() => {});
      } catch (_) {}
    }

    timer = setTimer(() => {
      const error = new Error(`Trae collect worker timed out after ${timeoutMs}ms`);
      error.code = 'TRAE_WORKER_TIMEOUT';
      error.traeWorkerMechanical = true;
      finish(reject, error);
      terminateWorker();
    }, timeoutMs);

    worker.once('message', (message) => {
      if (message?.ok) finish(resolve, message.result);
      else finish(reject, workerError(message?.error));
    });
    worker.once('messageerror', (error) => {
      error.traeWorkerMechanical = true;
      finish(reject, error);
      terminateWorker();
    });
    worker.once('error', (error) => {
      error.traeWorkerMechanical = true;
      finish(reject, error);
      terminateWorker();
    });
    worker.once('exit', (code) => {
      if (settled) return;
      const error = new Error(`Trae collect worker exited with code ${code}`);
      error.code = 'TRAE_WORKER_EXIT';
      error.traeWorkerMechanical = true;
      finish(reject, error);
    });
  });
}

// One worker failure per host is enough to conclude this environment cannot run
// the collect off-thread; later collects go straight in-process rather than
// paying a spawn-and-timeout each time. createTraeCollection() builds one host
// per process, so this state is naturally process-scoped.
function createTraeCollectHost(deps = {}) {
  const env = deps.env || process.env;
  const inProcessRequested = ['1', 'true', 'yes', 'on']
    .includes(String(env.TOKEN_MONITOR_TRAE_IN_PROCESS ?? '').trim().toLowerCase());
  let disabled = inProcessRequested;

  const host = async function collectTraeSnapshotAsync(args = {}) {
    if (disabled) {
      return collectTraeSnapshot(args);
    }
    try {
      return await runTraeCollectWorker(args, deps);
    } catch (error) {
      if (!error?.traeWorkerMechanical) throw error;
      disabled = true;
      return collectTraeSnapshot(args);
    }
  };
  host.inspect = () => ({ disabled });
  return host;
}

const defaultHost = createTraeCollectHost();

module.exports = {
  TRAE_COLLECT_WORKER_TIMEOUT_MS,
  collectTraeSnapshotAsync: (args) => defaultHost(args),
  createTraeCollectHost,
  runTraeCollectWorker
};
