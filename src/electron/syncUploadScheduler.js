'use strict';

const {
  DEFAULT_SYNC_UPLOAD_INTERVAL_MS,
  SYNC_UPLOAD_INTERVAL_OPTIONS,
  normalizeSyncUploadIntervalMs
} = require('../shared/syncUploadInterval');

function createSyncUploadScheduler(options = {}) {
  const upload = typeof options.upload === 'function' ? options.upload : async () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const onError = typeof options.onError === 'function' ? options.onError : null;
  const intervalMs = normalizeSyncUploadIntervalMs(options.intervalMs);
  let lastUploadAt = null;
  let pendingSummary = null;
  let uploadInFlight = null;
  let timer = null;
  let stopped = false;

  function clearPendingTimer() {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  async function uploadNow(summary) {
    if (uploadInFlight) {
      pendingSummary = summary;
      return;
    }
    const task = Promise.resolve().then(() => upload(summary));
    uploadInFlight = task;
    try {
      await task;
      lastUploadAt = now();
    } finally {
      uploadInFlight = null;
      if (pendingSummary && !stopped) {
        const elapsedMs = lastUploadAt === null ? intervalMs : now() - lastUploadAt;
        schedulePending(intervalMs <= 0 ? 0 : intervalMs - elapsedMs);
      }
    }
  }

  function schedulePending(delayMs) {
    if (timer || stopped) return;
    timer = setTimer(() => {
      timer = null;
      flush().catch((error) => {
        if (onError) onError(error);
      });
    }, Math.max(0, delayMs));
  }

  async function enqueue(summary) {
    if (stopped) return;
    if (intervalMs <= 0 || lastUploadAt === null) {
      clearPendingTimer();
      pendingSummary = null;
      await uploadNow(summary);
      return;
    }
    const elapsedMs = now() - lastUploadAt;
    if (elapsedMs >= intervalMs) {
      clearPendingTimer();
      pendingSummary = null;
      await uploadNow(summary);
      return;
    }
    pendingSummary = summary;
    schedulePending(intervalMs - elapsedMs);
  }

  async function flush() {
    if (stopped) return;
    clearPendingTimer();
    while (uploadInFlight) {
      const activeTask = uploadInFlight;
      try {
        await activeTask;
      } catch (_) {
        // The caller that started the upload owns its error; flush still drains newer data.
      }
      if (stopped) return;
      clearPendingTimer();
    }
    if (!pendingSummary) return;
    const summary = pendingSummary;
    pendingSummary = null;
    await uploadNow(summary);
  }

  function stop() {
    stopped = true;
    pendingSummary = null;
    clearPendingTimer();
  }

  return { enqueue, flush, stop };
}

module.exports = {
  DEFAULT_SYNC_UPLOAD_INTERVAL_MS,
  SYNC_UPLOAD_INTERVAL_OPTIONS,
  createSyncUploadScheduler,
  normalizeSyncUploadIntervalMs
};
