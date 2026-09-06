'use strict';

const fs = require('node:fs');

const { aggregateDevices, aggregateHistory, normalizeDeviceRecord } = require('../shared/usage');
const { deviceHistoryRevision, historyPreview, historyRevision } = require('../shared/history');

const DEFAULT_RECONCILE_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 1_000;

function callSafely(callback, value) {
  if (typeof callback !== 'function') return;
  try { callback(value); } catch (_) { /* observers must not stop reconciliation */ }
}

function mergeByDeviceId(records, localRecord) {
  const map = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    const id = String(record.deviceId || record.id || '').trim();
    if (id) map.set(id, record);
  }
  if (localRecord) {
    const id = String(localRecord.deviceId || localRecord.id || '').trim();
    if (id) map.set(id, localRecord);
  }
  return [...map.values()];
}

function defaultWatchFactory(root, onChange, onError) {
  try {
    const watcher = fs.watch(root, { recursive: true }, () => onChange());
    watcher.on('error', onError);
    return watcher;
  } catch (error) {
    onError(error);
    return null;
  }
}

function createIcloudSyncRuntime(options = {}) {
  const store = options.store;
  if (!store || typeof store.discoverDevices !== 'function') {
    throw new TypeError('createIcloudSyncRuntime requires an iCloud sync store');
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : DEFAULT_DEBOUNCE_MS;
  const reconcileMs = Number.isFinite(options.reconcileMs) ? Math.max(0, options.reconcileMs) : DEFAULT_RECONCILE_MS;
  const staleAfterMs = Number.isFinite(options.staleAfterMs) ? Math.max(0, options.staleAfterMs) : 0;
  const watchFactory = options.watchFactory || defaultWatchFactory;
  const aggregateDevicesFn = options.aggregateDevices || aggregateDevices;
  const aggregateHistoryFn = options.aggregateHistory || aggregateHistory;

  let active = false;
  let generation = 0;
  let watcher = null;
  let watcherState = 'inactive';
  let reconcileTimer = null;
  let debounceTimer = null;
  let reconcilePromise = null;
  let reconcileGeneration = null;
  let reconcileAgain = false;
  let localRecord = null;
  let records = [];
  let stats = null;
  let subscriptionDocument = null;
  let lastSubscriptionRevision = null;
  let lastSuccessfulReconciliation = '';
  let lastWriteAt = '';
  let lastErrorCategory = '';
  let lastReconcileErrorCategory = '';
  let lastSubscriptionReconcileErrorCategory = '';
  let reconcileState = 'idle';

  function storeStatus() {
    try { return typeof store.status === 'function' ? store.status() : {}; } catch (_) { return {}; }
  }

  function publicStatus() {
    const source = storeStatus();
    let state = source.state || (source.supported === false ? 'unavailable' : 'waiting');
    if (state === 'available') state = 'available';
    if (!active && state !== 'unsupported') state = 'stopped';
    return {
      state,
      availability: source.available === true ? 'available' : 'unavailable',
      supported: source.supported !== false,
      reason: source.reason || '',
      root: source.root || '[redacted]/Token Monitor/sync-v1',
      deviceCount: records.length,
      lastSuccessfulReconciliation,
      lastWriteAt,
      lastErrorCategory: lastErrorCategory || source.lastErrorCategory || '',
      lastReconcileErrorCategory,
      lastSubscriptionReconcileErrorCategory,
      watcher: watcherState,
      reconciliation: reconcileState,
      subscriptionRevision: lastSubscriptionRevision || ''
    };
  }

  function publishStatus() {
    callSafely(options.onStatus, publicStatus());
  }

  function publishStats() {
    if (!stats) return;
    callSafely(options.onStats, stats);
  }

  function buildStats(nextRecords) {
    const aggregate = aggregateDevicesFn(nextRecords, staleAfterMs, now());
    const historyEnabled = typeof options.historyEnabled === 'function'
      ? options.historyEnabled()
      : options.historyEnabled !== false;
    const history = historyEnabled ? aggregateHistoryFn(nextRecords) : aggregateHistoryFn([]);
    return {
      ...aggregate,
      historyPreview: historyPreview(history),
      historyRevision: historyRevision(history),
      deviceHistoryRevision: deviceHistoryRevision(nextRecords)
    };
  }

  function updateRecords(nextRecords, { publish = true } = {}) {
    records = mergeByDeviceId(nextRecords, localRecord);
    stats = buildStats(records);
    if (publish) publishStats();
    publishStatus();
  }

  function reportError(error, category) {
    lastErrorCategory = category || error?.code || 'icloud-sync-error';
    callSafely(options.onError, { error, category: lastErrorCategory });
    publishStatus();
  }

  function closeWatcher() {
    if (!watcher) return;
    try {
      if (typeof watcher.close === 'function') watcher.close();
    } catch (error) {
      if (active) reportError(error, 'watcher-close-failed');
    }
    watcher = null;
  }

  function scheduleReconcile(reason = 'watch') {
    if (!active) return;
    if (debounceTimer !== null) clearTimeoutFn(debounceTimer);
    const expectedGeneration = generation;
    debounceTimer = setTimeoutFn(() => {
      debounceTimer = null;
      if (!active || expectedGeneration !== generation) return;
      void reconcile(reason);
    }, debounceMs);
  }

  function onWatcherError(error) {
    if (!active) return;
    // Watch descriptors are a shared per-user budget.  Once native watching has
    // failed, keep the process on reconciliation polling instead of repeatedly
    // rediscovering the same exhausted budget.
    watcherState = 'unavailable';
    closeWatcher();
    reportError(error, /ENOSPC|EMFILE|ENFILE/.test(String(error?.code || ''))
      ? 'watcher-descriptor-exhausted'
      : 'watcher-failed');
    scheduleReconcile('watcher-error');
  }

  function startWatcher(expectedGeneration) {
    if (!active || expectedGeneration !== generation) return;
    const source = storeStatus();
    if (source.available !== true || (source.state && source.state !== 'available')) {
      watcherState = 'unavailable';
      return;
    }
    const root = store.paths?.()?.syncRoot;
    if (!root) {
      watcherState = 'unavailable';
      return;
    }
    try {
      watcher = watchFactory(root, () => scheduleReconcile('watch'), onWatcherError);
      watcherState = watcher ? 'active' : 'unavailable';
    } catch (error) {
      if (expectedGeneration !== generation || !active) return;
      onWatcherError(error);
    }
  }

  function startTimer(expectedGeneration) {
    if (reconcileMs <= 0) return;
    reconcileTimer = setIntervalFn(() => {
      if (!active || expectedGeneration !== generation) return;
      void reconcile('periodic');
    }, reconcileMs);
  }

  async function reconcile(_reason = 'manual') {
    if (!active) return stats;
    if (reconcilePromise && reconcileGeneration === generation) {
      reconcileAgain = true;
      return reconcilePromise;
    }
    const expectedGeneration = generation;
    reconcileState = 'running';
    publishStatus();
    let runPromise;
    runPromise = Promise.resolve().then(async () => {
      const discovered = await store.discoverDevices();
      const subscriptions = typeof store.discoverSubscriptions === 'function'
        ? await store.discoverSubscriptions()
        : null;
      if (!active || expectedGeneration !== generation) return;
      if (!watcher && store.status?.()?.available === true) {
        startWatcher(expectedGeneration);
      }
      lastSubscriptionReconcileErrorCategory = subscriptions?.errors?.[0]?.category || '';
      lastReconcileErrorCategory = discovered.errors?.[0]?.category
        || lastSubscriptionReconcileErrorCategory;
      if (lastReconcileErrorCategory) lastErrorCategory = lastReconcileErrorCategory;
      updateRecords(discovered.records, { publish: false });
      const winnerToken = subscriptions?.revisionToken || '';
      if (winnerToken !== lastSubscriptionRevision) {
        lastSubscriptionRevision = winnerToken;
        subscriptionDocument = subscriptions?.winner
          ? { ...subscriptions.winner, revisionToken: winnerToken }
          : null;
        const emptyWinnerIsAuthoritative = !subscriptions?.winner
          && subscriptions?.status?.available === true
          && !(subscriptions.errors?.length);
        if (subscriptions?.winner || emptyWinnerIsAuthoritative) {
          callSafely(options.onSubscriptions, subscriptionDocument);
        }
      }
      lastSuccessfulReconciliation = new Date(now()).toISOString();
      reconcileState = 'idle';
      publishStats();
      publishStatus();
      return stats;
    }).catch((error) => {
      if (active && expectedGeneration === generation) {
        reconcileState = 'idle';
        lastReconcileErrorCategory = error?.code || 'reconcile-failed';
        reportError(error, lastReconcileErrorCategory);
      }
      return stats;
    }).finally(() => {
      // A mode restart may have installed a newer reconciliation while this
      // read was still awaiting the old store. The old promise must not clear
      // or queue work against the new generation's promise.
      if (reconcilePromise !== runPromise) return;
      reconcilePromise = null;
      reconcileGeneration = null;
      if (reconcileAgain && active && expectedGeneration === generation) {
        reconcileAgain = false;
        void reconcile('queued');
      } else {
        reconcileAgain = false;
      }
    });
    reconcilePromise = runPromise;
    reconcileGeneration = expectedGeneration;
    return runPromise;
  }

  async function start() {
    if (active) return publicStatus();
    active = true;
    generation += 1;
    const expectedGeneration = generation;
    reconcileState = 'idle';
    lastErrorCategory = '';
    const source = storeStatus();
    watcherState = source.available ? 'starting' : 'unavailable';
    startWatcher(expectedGeneration);
    startTimer(expectedGeneration);
    publishStatus();
    await reconcile('startup');
    return publicStatus();
  }

  async function stop() {
    active = false;
    generation += 1;
    if (debounceTimer !== null) clearTimeoutFn(debounceTimer);
    if (reconcileTimer !== null) clearIntervalFn(reconcileTimer);
    debounceTimer = null;
    reconcileTimer = null;
    reconcileAgain = false;
    closeWatcher();
    watcherState = 'inactive';
    reconcileState = 'idle';
    // A late sink completion from the stopped generation must not be overlaid
    // on a later start of this runtime. Last-good discovered records remain in
    // `records`; only the in-memory writer overlay belongs to the old lifetime.
    localRecord = null;
    publishStatus();
  }

  async function writeDevice(record) {
    const normalized = normalizeDeviceRecord(record);
    if (!active) return false;
    const expectedGeneration = generation;
    localRecord = normalized;
    try {
      await Promise.resolve(store.writeDevice(record));
      if (!active || expectedGeneration !== generation) return false;
      lastWriteAt = new Date(now()).toISOString();
      lastErrorCategory = '';
      await reconcile('write');
      if (!active || expectedGeneration !== generation) return false;
      return true;
    } catch (error) {
      if (!active || expectedGeneration !== generation) return false;
      reportError(error, error?.code || 'device-write-failed');
      // The just-collected local record remains visible while iCloud is down;
      // a failed write never turns the last good aggregate into zero.
      updateRecords(records, { publish: true });
      return false;
    }
  }

  async function deleteDevice(deviceId) {
    if (!active) {
      const error = new Error('iCloud sync is stopped');
      error.code = 'icloud_stopped';
      throw error;
    }
    const expectedGeneration = generation;
    try {
      const result = await Promise.resolve(store.deleteDevice(deviceId));
      if (!active || expectedGeneration !== generation) {
        const error = new Error('iCloud sync is stopped');
        error.code = 'icloud_stopped';
        throw error;
      }
      if (String(localRecord?.deviceId || '') === String(deviceId)) localRecord = null;
      await reconcile('delete');
      if (!active || expectedGeneration !== generation) {
        const error = new Error('iCloud sync is stopped');
        error.code = 'icloud_stopped';
        throw error;
      }
      return result;
    } catch (error) {
      if (!active || expectedGeneration !== generation) throw error;
      reportError(error, error?.code || 'device-delete-failed');
      throw error;
    }
  }

  async function saveSubscriptions(subscriptions, baseRevision = '') {
    if (!active) {
      const error = new Error('iCloud sync is stopped');
      error.code = 'icloud_stopped';
      throw error;
    }
    const expectedGeneration = generation;
    try {
      const result = await Promise.resolve(store.writeSubscriptions(subscriptions, { baseRevision }));
      if (!active || expectedGeneration !== generation) {
        const error = new Error('iCloud sync is stopped');
        error.code = 'icloud_stopped';
        throw error;
      }
      lastWriteAt = new Date(now()).toISOString();
      lastErrorCategory = '';
      await reconcile('subscription-write');
      if (!active || expectedGeneration !== generation) {
        const error = new Error('iCloud sync is stopped');
        error.code = 'icloud_stopped';
        throw error;
      }
      if (result?.winner) {
        lastSubscriptionRevision = result.revisionToken || '';
        subscriptionDocument = { ...result.winner, revisionToken: result.revisionToken || '' };
        callSafely(options.onSubscriptions, subscriptionDocument);
      }
      return result;
    } catch (error) {
      // A stale edit carries a useful current winner at the storage layer, but
      // the renderer will re-read settings after this IPC rejection. Reconcile
      // first so that re-read is anchored to the same deterministic document
      // rather than the version this writer opened earlier.
      if (!active || expectedGeneration !== generation) throw error;
      if (error?.code === 'stale_write' && active) {
        await reconcile('subscription-stale');
      }
      reportError(error, error?.code || 'subscription-write-failed');
      throw error;
    }
  }

  return {
    deleteDevice,
    getDevices: () => records.slice(),
    getHistory: () => {
      const historyEnabled = typeof options.historyEnabled === 'function'
        ? options.historyEnabled()
        : options.historyEnabled !== false;
      return historyEnabled ? aggregateHistoryFn(records) : aggregateHistoryFn([]);
    },
    getStats: () => stats,
    getStatus: publicStatus,
    getSubscriptions: () => subscriptionDocument,
    reconcile,
    saveSubscriptions,
    start,
    stop,
    writeDevice,
    flush: () => reconcile('flush')
  };
}

module.exports = {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RECONCILE_MS,
  createIcloudSyncRuntime,
  mergeByDeviceId
};
