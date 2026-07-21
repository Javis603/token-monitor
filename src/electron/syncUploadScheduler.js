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
  let pendingEntry = null;
  let uploadInFlight = null;
  let timer = null;
  let stopped = false;
  let nextRevision = 0;
  let highestRevision = Number.NEGATIVE_INFINITY;

  function clearPendingTimer() {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  async function uploadNow(entry) {
    if (uploadInFlight) {
      if (!pendingEntry || entry.revision >= pendingEntry.revision) pendingEntry = entry;
      return;
    }
    const task = Promise.resolve().then(() => upload(entry.summary));
    uploadInFlight = task;
    try {
      await task;
      lastUploadAt = now();
    } finally {
      uploadInFlight = null;
      if (pendingEntry && !stopped) {
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

  async function enqueue(summary, revision = undefined) {
    if (stopped) return;
    const parsed = Number(revision);
    const resolvedRevision = Number.isFinite(parsed) ? parsed : ++nextRevision;
    nextRevision = Math.max(nextRevision, resolvedRevision);
    if (resolvedRevision < highestRevision) return;
    highestRevision = resolvedRevision;
    const entry = { summary, revision: resolvedRevision };
    if (intervalMs <= 0 || lastUploadAt === null) {
      clearPendingTimer();
      pendingEntry = null;
      await uploadNow(entry);
      return;
    }
    const elapsedMs = now() - lastUploadAt;
    if (elapsedMs >= intervalMs) {
      clearPendingTimer();
      pendingEntry = null;
      await uploadNow(entry);
      return;
    }
    pendingEntry = entry;
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
    if (!pendingEntry) return;
    const entry = pendingEntry;
    pendingEntry = null;
    await uploadNow(entry);
  }

  function stop() {
    stopped = true;
    pendingEntry = null;
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
