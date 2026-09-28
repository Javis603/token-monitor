'use strict';

const { abortReason } = require('../../abortSignal');

// Tokscale reports can implicitly sync Cursor, so every Cursor subprocess and
// local credentials mutation started by this process shares one FIFO lane.
let cursorLifecycleActive = false;
const cursorLifecycleQueue = [];

function runNextCursorLifecycleEntry() {
  const next = cursorLifecycleQueue.shift();
  if (next) next.run();
  else cursorLifecycleActive = false;
}

function withCursorLifecycle(operation, { signal } = {}) {
  if (typeof operation !== 'function') {
    throw new TypeError('withCursorLifecycle: operation must be a function');
  }
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal, 'Cursor lifecycle wait aborted'));
  }

  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    const entry = {
      run() {
        if (settled) return;
        started = true;
        cursorLifecycleActive = true;
        signal?.removeEventListener('abort', onAbort);
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
      }
    };

    function finish(settle, value) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      settle(value);
      runNextCursorLifecycleEntry();
    }

    function onAbort() {
      if (started || settled) return;
      const index = cursorLifecycleQueue.indexOf(entry);
      if (index >= 0) cursorLifecycleQueue.splice(index, 1);
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal, 'Cursor lifecycle wait aborted'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (cursorLifecycleActive) cursorLifecycleQueue.push(entry);
    else entry.run();
  });
}

module.exports = { withCursorLifecycle };
