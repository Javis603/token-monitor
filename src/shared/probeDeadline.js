'use strict';

class ProbeTimeoutError extends Error {
  constructor(deadlineMs) {
    super(`Provider probe exceeded its ${deadlineMs}ms deadline`);
    this.name = 'ProbeTimeoutError';
    this.code = 'PROBE_TIMEOUT';
    this.status = 'timeout';
    this.deadlineMs = deadlineMs;
  }
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Provider probe aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

async function runWithProbeDeadline(task, options = {}) {
  if (typeof task !== 'function') throw new TypeError('task must be a function');
  const deadlineMs = Number(options.deadlineMs);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new TypeError('Provider probes require a finite positive deadlineMs');
  }
  if (options.signal?.aborted) throw abortError(options.signal);

  const ParentAbortController = options.AbortController || AbortController;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const controller = new ParentAbortController();
  const parentSignal = options.signal;
  let timer = null;
  let removeParentAbort = null;

  const cancellation = new Promise((_, reject) => {
    const cancel = (error) => {
      if (!controller.signal.aborted) controller.abort(error);
      reject(error);
    };

    if (parentSignal) {
      const onParentAbort = () => cancel(abortError(parentSignal));
      if (parentSignal.aborted) {
        onParentAbort();
      } else {
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
        removeParentAbort = () => parentSignal.removeEventListener('abort', onParentAbort);
      }
    }

    timer = setTimer(() => cancel(new ProbeTimeoutError(deadlineMs)), deadlineMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => task({ signal: controller.signal, deadlineMs })),
      cancellation
    ]);
  } finally {
    if (timer !== null) clearTimer(timer);
    removeParentAbort?.();
  }
}

module.exports = {
  ProbeTimeoutError,
  runWithProbeDeadline
};
