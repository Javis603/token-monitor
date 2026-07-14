'use strict';

const SYNC_UPLOAD_INTERVAL_OPTIONS = [0, 10 * 60 * 1000, 20 * 60 * 1000, 30 * 60 * 1000];
const DEFAULT_SYNC_UPLOAD_INTERVAL_MS = 0;

function normalizeSyncUploadIntervalMs(value, fallback = DEFAULT_SYNC_UPLOAD_INTERVAL_MS) {
  const numeric = Number(value);
  if (SYNC_UPLOAD_INTERVAL_OPTIONS.includes(numeric)) return numeric;
  const fallbackNumeric = Number(fallback);
  return SYNC_UPLOAD_INTERVAL_OPTIONS.includes(fallbackNumeric)
    ? fallbackNumeric
    : DEFAULT_SYNC_UPLOAD_INTERVAL_MS;
}

function createSyncUploadScheduler(options = {}) {
  const upload = typeof options.upload === 'function' ? options.upload : async () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const onError = typeof options.onError === 'function' ? options.onError : null;
  const intervalMs = normalizeSyncUploadIntervalMs(options.intervalMs);
  let lastUploadAt = null;
  let pendingSummary = null;
  let timer = null;
  let stopped = false;

  function clearPendingTimer() {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  async function uploadNow(summary) {
    await upload(summary);
    lastUploadAt = now();
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
    if (stopped || !pendingSummary) return;
    clearPendingTimer();
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
