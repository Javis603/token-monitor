'use strict';

function createOrderedSink(options = {}) {
  const send = typeof options.send === 'function' ? options.send : async () => {};
  const onError = typeof options.onError === 'function' ? options.onError : null;
  let nextRevision = 0;
  let highestRevision = Number.NEGATIVE_INFINITY;
  let active = null;
  let pending = null;
  let stopped = false;

  function settle(entry, outcome, error = null) {
    if (!entry || entry.settled) return;
    entry.settled = true;
    if (error) entry.reject(error);
    else entry.resolve(outcome);
  }

  function start(entry) {
    if (stopped) {
      settle(entry, { sent: false, stopped: true, revision: entry.revision });
      return;
    }
    active = entry;
    const task = Promise.resolve().then(() => send(entry.value, entry.revision));
    entry.task = task;
    task.then(
      () => settle(entry, { sent: true, revision: entry.revision }),
      (error) => {
        settle(entry, null, error);
        onError?.(error);
      }
    ).finally(() => {
      if (active === entry) active = null;
      if (!stopped && pending) {
        const next = pending;
        pending = null;
        start(next);
      }
    });
    // A queued drain may have no caller awaiting it. Keep the send failure
    // observable through the entry promise/onError without creating an unhandled rejection.
    task.catch(() => {});
  }

  function enqueue(value, revision = undefined) {
    if (stopped) return Promise.resolve({ sent: false, stopped: true, revision: null });
    const parsed = Number(revision);
    const resolvedRevision = Number.isFinite(parsed) ? parsed : ++nextRevision;
    nextRevision = Math.max(nextRevision, resolvedRevision);
    if (resolvedRevision < highestRevision) {
      return Promise.resolve({ sent: false, superseded: true, revision: resolvedRevision });
    }
    highestRevision = resolvedRevision;

    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const entry = { value, revision: resolvedRevision, resolve, reject, promise, settled: false, task: null };
    if (!active) start(entry);
    else {
      settle(pending, { sent: false, superseded: true, revision: pending?.revision });
      pending = entry;
    }
    return promise;
  }

  async function flush() {
    while (active || pending) {
      const entry = active || pending;
      if (!active && pending) {
        pending = null;
        start(entry);
      }
      try {
        await entry.promise;
      } catch (_) {
        // Continue draining the latest pending record after a failed send.
      }
      if (stopped) return;
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    settle(pending, { sent: false, stopped: true, revision: pending?.revision });
    pending = null;
  }

  return { enqueue, flush, stop };
}

module.exports = {
  createOrderedSink
};
