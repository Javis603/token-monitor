'use strict';

// The widget's Activity heatmap and Trend page need the complete history, not
// the compact window `/api/stats` carries. Two things make that expensive to
// resolve on every stats push once the extension actually ships:
//
//   - `historyRevision` is a content hash of the whole history, so it moves on
//     essentially every ingest from any device. Keying a cache on it alone turns
//     a remote `client` into a full `GET /api/history` per push, where the
//     payload had previously been fetched only when the dashboard opened. Only
//     that path is remote: `local` and an embedded `host` resolve in process, so
//     the caller sets the freshness floor from `completeHistorySource()` rather
//     than paying a staleness cost where there is nothing to save.
//   - A failed hub request must not reach the snapshot. Empty arrays there blank
//     the heatmap and the Trend page until some later revision happens to
//     succeed, which reads as data loss rather than a transient network error.
//
// So the revision is treated as a freshness *signal* gated by a time floor, and
// the last good history is retained across failures. A remote source also gets
// a source-keyed persisted cache from the caller, because this module-level
// cache disappears when Electron restarts.
//
// Two floors, because the two states are not the same risk. With a cached copy
// to serve, the floor is about freshness and can be long. With none — a cold
// start whose first read failed — there is nothing to show, so waiting out the
// long floor would strand the widget; but leaving that case unbounded lets every
// stats push start another request, and the remote read carries a 15 s timeout,
// so an unreachable hub turns into a continuous queue of them. It gets its own
// short bounded floor instead: quick enough to recover on its own, bounded
// enough that pushes cannot stack requests behind a dead hub.
const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RETRY_INTERVAL_MS = 30_000;
const EMPTY_HISTORY = Object.freeze({ daily: [], monthly: [], summary: {} });

let cachedHistory = null;
// The generation + source pair this cache currently describes. Claimed when a
// fetch starts, not when one succeeds: the first request is in flight for as
// long as a hub round trip takes, and every push arriving in that window would
// otherwise read an unclaimed owner as a change and discard the request it
// should join. Generation is a separate ownership epoch because a fast
// A -> B -> A mode switch returns to the same semantic source key while the
// original A request can still be on the wire.
let activeGeneration = null;
let activeSourceKey = '';
let cachedRevision = '';
let lastAttemptAt = null;
let lastAttemptFailed = false;
let inFlight = null;
let persistedLoad = null;

function log(logger, message) {
  try { logger?.(message); } catch (_) {}
}

function emptyHistory() {
  return { daily: [], monthly: [], summary: {} };
}

function isHistoryDocument(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray(value.daily)
    && Array.isArray(value.monthly)
    && value.summary
    && typeof value.summary === 'object'
    && !Array.isArray(value.summary)
  );
}

// The resolver configuration, without the revision or bearer secret. A change
// here means the cached history describes a different source (another hub, or
// history switched off) and must not be served, however fresh it is. The Hub
// secret gates one shared data store; it does not select a tenant, and including
// it would discard a valid last-good copy on routine credential rotation.
function macWidgetHistorySourceKey(config = {}) {
  return [
    config.mode,
    config.hubMode,
    config.historyEnabled,
    String(config.hubUrl || '').replace(/\/$/, '')
  ].join('|');
}

async function resolveMacWidgetHistory(options = {}) {
  const generation = options.generation;
  const sourceKey = String(options.sourceKey || '');
  const revision = String(options.revision || '').trim();
  const fetchHistory = options.fetchHistory;
  const loadCachedHistory = options.loadCachedHistory;
  const saveCachedHistory = options.saveCachedHistory;
  const logger = options.logger;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const minIntervalMs = Number.isFinite(options.minIntervalMs)
    ? Math.max(0, options.minIntervalMs)
    : DEFAULT_MIN_INTERVAL_MS;
  // Deliberately independent of minIntervalMs: a caller that sets the freshness
  // floor to zero because its source is in-process still must not be able to
  // spin on a failing one.
  const retryIntervalMs = Number.isFinite(options.retryIntervalMs)
    ? Math.max(0, options.retryIntervalMs)
    : DEFAULT_RETRY_INTERVAL_MS;

  if (typeof fetchHistory !== 'function') return cachedHistory || emptyHistory();

  // A different owner invalidates the cache outright: serving another hub's
  // history or a superseded mode generation would be wrong, not merely stale.
  if (generation !== activeGeneration || sourceKey !== activeSourceKey) {
    activeGeneration = generation;
    activeSourceKey = sourceKey;
    cachedHistory = null;
    cachedRevision = '';
    lastAttemptAt = null;
    lastAttemptFailed = false;
    inFlight = null;
    persistedLoad = null;

    if (typeof loadCachedHistory === 'function') {
      let loadPromise;
      loadPromise = Promise.resolve()
        .then(() => loadCachedHistory())
        .then((history) => {
          if (generation !== activeGeneration || sourceKey !== activeSourceKey) return;
          if (isHistoryDocument(history)) cachedHistory = history;
        })
        .catch((error) => {
          log(logger, `[mac-widget] persisted history cache read failed: ${error?.message || error}`);
        })
        .finally(() => {
          if (persistedLoad?.promise === loadPromise) persistedLoad = null;
        });
      persistedLoad = { generation, sourceKey, promise: loadPromise };
    }
  }

  const activePersistedLoad = persistedLoad;
  if (activePersistedLoad && activePersistedLoad.generation === generation && activePersistedLoad.sourceKey === sourceKey) {
    await activePersistedLoad.promise;
    if (generation !== activeGeneration || sourceKey !== activeSourceKey) return emptyHistory();
  }

  // An exact revision hit is served whatever the floors say: it is the answer,
  // not a stale stand-in for one.
  if (cachedHistory && revision && revision === cachedRevision) return cachedHistory;

  // Checked before the floors: a request already on the wire is the answer, just
  // not arrived yet, so joining it beats both starting a second one and handing
  // back a stale stand-in. The revision it was started for only decides how its
  // result gets cached, which is why this matches on the owner alone.
  if (inFlight && inFlight.generation === generation && inFlight.sourceKey === sourceKey) {
    return inFlight.promise;
  }

  const floorMs = cachedHistory
    ? Math.max(minIntervalMs, lastAttemptFailed ? retryIntervalMs : 0)
    : retryIntervalMs;
  const elapsedMs = lastAttemptAt === null ? null : now - lastAttemptAt;
  // A wall-clock rollback makes the previous stamp meaningless. Treat a negative
  // elapsed as due and re-anchor below instead of suppressing refreshes until the
  // clock catches up, matching the collector's other wall-clock throttle.
  if (elapsedMs !== null && elapsedMs >= 0 && elapsedMs < floorMs) {
    return cachedHistory || emptyHistory();
  }

  // Recorded before the request resolves so that a slow or hanging fetch still
  // holds the floor closed against the pushes arriving behind it.
  lastAttemptAt = now;

  const promise = Promise.resolve()
    .then(() => fetchHistory())
    .then(async (history) => {
      if (!history || typeof history !== 'object') throw new Error('history resolver returned no data');
      // An owner change while this was in flight makes the answer belong to a
      // mode lifetime nobody is asking about any more. It can neither populate
      // the active cache nor escape to a caller that may publish it.
      if (generation !== activeGeneration || sourceKey !== activeSourceKey) return emptyHistory();
      cachedHistory = history;
      cachedRevision = revision;
      lastAttemptFailed = false;
      if (typeof saveCachedHistory === 'function') {
        try {
          await saveCachedHistory(history);
        } catch (error) {
          log(logger, `[mac-widget] persisted history cache write failed: ${error?.message || error}`);
        }
      }
      return history;
    })
    .catch((error) => {
      log(logger, `[mac-widget] complete history unavailable: ${error?.message || error}`);
      // A superseded request belongs to its original owner and must not observe
      // the active owner's cache through this module-level state.
      if (generation !== activeGeneration || sourceKey !== activeSourceKey) return emptyHistory();
      lastAttemptFailed = true;
      // Keep whatever last rendered rather than blanking the heatmap. The
      // revision is left untouched so the next attempt past the floor still
      // sees this revision as unfetched.
      return cachedHistory || emptyHistory();
    });

  inFlight = { generation, sourceKey, revision, promise };
  try {
    return await promise;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

function resetMacWidgetHistoryCache() {
  cachedHistory = null;
  activeGeneration = null;
  activeSourceKey = '';
  cachedRevision = '';
  lastAttemptAt = null;
  lastAttemptFailed = false;
  inFlight = null;
  persistedLoad = null;
}

module.exports = {
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_RETRY_INTERVAL_MS,
  EMPTY_HISTORY,
  isHistoryDocument,
  macWidgetHistorySourceKey,
  resetMacWidgetHistoryCache,
  resolveMacWidgetHistory
};
