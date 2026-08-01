'use strict';

const os = require('node:os');
const { Worker } = require('node:worker_threads');

const { readSessionDetail } = require('./sessionDetail');
const { wslUsageHomes } = require('./wslUsage');

const WSL_JSONL_CLIENTS = new Set(['claude', 'codex']);
const SESSION_DETAIL_WORKER_TIMEOUT_MS = 20_000;

function resolveSessionDetailForPlatform(args = {}, deps = {}) {
  const readDetail = deps.readSessionDetail || readSessionDetail;
  const nativeHome = (deps.homedir || os.homedir)();
  const nativeDetail = readDetail({ ...args, home: nativeHome });
  const platform = deps.platform || process.platform;

  if (nativeDetail.found || platform !== 'win32' || !WSL_JSONL_CLIENTS.has(args.client)) {
    return nativeDetail;
  }

  let wslHomes;
  try {
    wslHomes = (deps.wslUsageHomes || wslUsageHomes)();
  } catch (_) {
    return nativeDetail;
  }

  const searched = new Set([nativeHome]);
  for (const home of wslHomes || []) {
    if (!home || searched.has(home)) continue;
    searched.add(home);
    const detail = readDetail({ ...args, home });
    if (detail.found) return detail;
  }
  return nativeDetail;
}

function workerError(payload) {
  const error = new Error(payload?.message || 'Session detail worker failed');
  if (payload?.name) error.name = payload.name;
  if (payload?.stack) error.stack = payload.stack;
  return error;
}

function runSessionDetailWorker(args = {}, deps = {}) {
  const WorkerClass = deps.Worker || Worker;
  const workerPath = deps.workerPath || require.resolve('./sessionDetailWorker');
  const configuredTimeoutMs = Number(deps.timeoutMs ?? SESSION_DETAIL_WORKER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? Math.trunc(configuredTimeoutMs)
    : SESSION_DETAIL_WORKER_TIMEOUT_MS;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;

  return new Promise((resolve, reject) => {
    const worker = new WorkerClass(workerPath, { workerData: args });
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
        const termination = worker.terminate();
        termination?.catch?.(() => {});
      } catch (_) {}
    }

    timer = setTimer(() => {
      finish(reject, new Error(`Session detail worker timed out after ${timeoutMs}ms`));
      terminateWorker();
    }, timeoutMs);

    worker.once('message', (message) => {
      if (message?.ok) finish(resolve, message.detail);
      else finish(reject, workerError(message?.error));
    });
    worker.once('messageerror', (error) => finish(reject, error));
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => {
      const suffix = code === 0 ? 'without returning a result' : `with code ${code}`;
      finish(reject, new Error(`Session detail worker exited ${suffix}`));
    });
  });
}

function readSessionDetailForPlatform(args = {}, deps = {}) {
  return runSessionDetailWorker(args, deps);
}

module.exports = {
  readSessionDetailForPlatform,
  resolveSessionDetailForPlatform,
  runSessionDetailWorker
};
