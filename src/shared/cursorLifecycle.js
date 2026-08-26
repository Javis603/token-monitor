'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abortReason } = require('./abortSignal');

const LOCK_DIR_NAME = '.token-monitor-cursor-lifecycle.lock';
const OWNER_FILE_NAME = 'owner.json';
const DEFAULT_LOCK_POLL_MS = 50;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 10 * 1000;

let cursorLifecycleActive = false;
const cursorLifecycleQueue = [];

function cursorLifecycleLockPath(home = os.homedir()) {
  return path.join(home, '.config', 'tokscale', LOCK_DIR_NAME);
}

function serializeCursorLifecycle(operation) {
  return new Promise((resolve, reject) => {
    const run = () => {
      cursorLifecycleActive = true;
      let result;
      try {
        result = operation();
      } catch (error) {
        finish(reject, error);
        return;
      }
      Promise.resolve(result).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    };
    const finish = (settle, value) => {
      settle(value);
      const next = cursorLifecycleQueue.shift();
      if (next) next();
      else cursorLifecycleActive = false;
    };

    if (cursorLifecycleActive) cursorLifecycleQueue.push(run);
    else run();
  });
}

function readLockOwner(lockPath, fsApi = fs) {
  try {
    const parsed = JSON.parse(fsApi.readFileSync(path.join(lockPath, OWNER_FILE_NAME), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function ownerProcessAlive(owner, processApi = process) {
  const pid = Number(owner?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    processApi.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // EPERM means the process exists but cannot be signalled. Unknown failures
    // are safer to treat as live until the heartbeat becomes stale.
    return true;
  }
}

function lockCanBeReclaimed(lockPath, { fsApi = fs, now = Date.now, staleMs = DEFAULT_LOCK_STALE_MS } = {}) {
  let stat;
  try {
    stat = fsApi.statSync(lockPath);
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  const alive = ownerProcessAlive(readLockOwner(lockPath, fsApi));
  if (alive === false) return true;
  return now() - stat.mtimeMs >= staleMs;
}

function retireLock(lockPath, suffix, fsApi = fs) {
  const retiredPath = `${lockPath}.${suffix}-${crypto.randomUUID()}`;
  try {
    fsApi.renameSync(lockPath, retiredPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  try { fsApi.rmSync(retiredPath, { recursive: true, force: true }); } catch (_) {}
  return true;
}

function createLockRelease(lockPath, token, { fsApi = fs, heartbeatMs = DEFAULT_HEARTBEAT_MS } = {}) {
  const heartbeat = setInterval(() => {
    const owner = readLockOwner(lockPath, fsApi);
    if (owner?.token !== token) {
      clearInterval(heartbeat);
      return;
    }
    try {
      const timestamp = new Date();
      fsApi.utimesSync(lockPath, timestamp, timestamp);
    } catch (_) {
      // Every lifecycle subprocess is bounded well inside the stale interval;
      // a failed heartbeat therefore cannot make a healthy operation stale.
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    if (readLockOwner(lockPath, fsApi)?.token !== token) return;
    retireLock(lockPath, 'released', fsApi);
  };
}

function tryAcquireCursorProcessLock({
  home = os.homedir(),
  fsApi = fs,
  now = Date.now,
  staleMs = DEFAULT_LOCK_STALE_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS
} = {}) {
  const lockPath = cursorLifecycleLockPath(home);
  fsApi.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = crypto.randomUUID();
    try {
      fsApi.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!lockCanBeReclaimed(lockPath, { fsApi, now, staleMs })) return null;
      if (!retireLock(lockPath, 'stale', fsApi)) return null;
      continue;
    }

    try {
      fsApi.writeFileSync(
        path.join(lockPath, OWNER_FILE_NAME),
        JSON.stringify({ pid: process.pid, token, acquiredAt: new Date(now()).toISOString() }),
        { flag: 'wx', mode: 0o600 }
      );
    } catch (error) {
      try { fsApi.rmSync(lockPath, { recursive: true, force: true }); } catch (_) {}
      throw error;
    }
    return createLockRelease(lockPath, token, { fsApi, heartbeatMs });
  }
  return null;
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal, 'Cursor lifecycle wait aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal, 'Cursor lifecycle wait aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function acquireCursorProcessLock(options = {}) {
  if (options.signal?.aborted) {
    return Promise.reject(abortReason(options.signal, 'Cursor lifecycle wait aborted'));
  }
  const immediate = tryAcquireCursorProcessLock(options);
  if (immediate) return immediate;

  const startedAt = (options.now || Date.now)();
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  return (async () => {
    while (true) {
      await waitForRetry(pollMs, options.signal);
      const release = tryAcquireCursorProcessLock(options);
      if (release) return release;
      if ((options.now || Date.now)() - startedAt >= timeoutMs) {
        const error = new Error(`Cursor lifecycle lock timed out after ${timeoutMs}ms`);
        error.code = 'CURSOR_LIFECYCLE_LOCK_TIMEOUT';
        throw error;
      }
    }
  })();
}

function invokeWithRelease(operation, release) {
  let result;
  try {
    result = operation();
  } catch (error) {
    release();
    throw error;
  }
  return Promise.resolve(result).then(
    (value) => { release(); return value; },
    (error) => { release(); throw error; }
  );
}

function withCursorLifecycle(operation, options = {}) {
  if (typeof operation !== 'function') throw new TypeError('withCursorLifecycle: operation must be a function');
  return serializeCursorLifecycle(() => {
    const acquired = acquireCursorProcessLock(options);
    if (typeof acquired === 'function') return invokeWithRelease(operation, acquired);
    return acquired.then((release) => invokeWithRelease(operation, release));
  });
}

module.exports = {
  cursorLifecycleLockPath,
  withCursorLifecycle
};
