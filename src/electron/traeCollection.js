'use strict';

// Trae CN collection lane (Electron main process). Owns the collect schedule,
// the key-extraction action, and the status object shown in Settings →
// Collection. The heavy lifting (decrypt, parse, aggregate) lives in
// shared/traeUsage.js; this file is scheduling + state only, with every
// effect injectable for tests.

const path = require('node:path');
const fs = require('node:fs');
const {
  TRAE_CLIENT,
  applyTraeCollectionHistory,
  applyTraeCollectionUsage,
  buildTraeHistoryGraph,
  buildTraePeriodsNormalized,
  localDayKeyOf,
  localMonthKeyOf,
  traeDataPaths,
  traeSourceSignature
} = require('../shared/traeUsage');
const { collectTraeSnapshotAsync } = require('../shared/traeCollectHost');
const { extractTraeKeyFromProcess } = require('../shared/traeKeyScanner');

const TRAE_COLLECTION_STARTUP_DELAY_MS = 90_000;
const TRAE_COLLECTION_MIN_INTERVAL_MS = 60_000;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
// The targeted B-tree reader made each collect cheap enough to run on every
// database write, so in live mode a directory watch drives collection within
// seconds of Trae writing a turn, and this timer is only a backstop for
// missed events (and the sole driver in smart/interval modes).
const TRAE_LIVE_INTERVAL_MS = 2 * 60 * 1000;
const TRAE_SMART_INTERVAL_MS = 10 * 60 * 1000;
// Watch-triggered collection fires after the database has been quiet this
// long (chat_turn rows are UPDATE-backfilled when a turn completes, so the
// quiet edge of a streaming burst is the useful moment), but never later
// than MAX_WAIT after the burst began, and never more often than MIN_GAP.
// The numbers match the shared collector's watch debounce (1.5s): Trae keeps
// writing database.db/-wal for many seconds after a turn finishes (checkpoints,
// session bookkeeping), so a longer quiet window just slid to the cap and made
// every completed turn feel 20-30s late. The targeted read is cheap enough
// (~170ms, right-edge pages only) that collecting on every quiet edge costs
// nothing, and the incremental reader refreshes overlap rows in place, so an
// early collect inside a burst is corrected by the next one.
const TRAE_WATCH_QUIET_MS = 1_500;
const TRAE_WATCH_MAX_WAIT_MS = 8_000;
const TRAE_WATCH_MIN_GAP_MS = 4_000;
// fs.watch on Windows is lossy under sustained writes (coalesced events,
// dropped notifications) — the live lane also polls the cheap 2-stat
// signature on this cadence so a missed event costs seconds, never minutes.
// The watch stays the low-latency path; this is the reliability floor.
const TRAE_WATCH_POLL_MS = 2_000;

function normalizeTraeIntervalMs(value, fallback = DEFAULT_INTERVAL_MS) {
  const number = Number(value);
  return Number.isFinite(number) && number >= TRAE_COLLECTION_MIN_INTERVAL_MS
    ? Math.trunc(number)
    : fallback;
}

function createTraeCollection(options = {}) {
  const getSettings = options.getSettings || (() => ({}));
  const updateSettings = options.updateSettings || (() => {});
  const pushStatus = options.pushStatus || (() => {});
  const log = options.log || (() => {});
  // Fired after a collect lands a fresh snapshot. The shared collector rebuilds
  // the merged summary only on its own ticks, and its watch never covers the
  // Trae data directory, so without this nudge the totals would lag until
  // another client's activity or the shared interval fallback (up to 30 min).
  const nudgeCollector = options.nudgeCollector || (() => {});
  const deps = options.deps || {};
  const nowMs = () => (deps.now ? deps.now() : Date.now());
  const extractKey = deps.extractTraeKeyFromProcess || extractTraeKeyFromProcess;
  const collectSnapshot = deps.collectTraeSnapshot || collectTraeSnapshotAsync;
  const buildPeriods = deps.buildTraePeriodsNormalized || buildTraePeriodsNormalized;
  const buildGraph = deps.buildTraeHistoryGraph || buildTraeHistoryGraph;
  const sourceSignature = deps.traeSourceSignature
    || ((db) => traeSourceSignature(db, deps.fs || fs));
  const fsApi = deps.fsApi || fs;
  const setWatchTimer = deps.setWatchTimer || setTimeout;
  const clearWatchTimer = deps.clearWatchTimer || clearTimeout;
  const setPollTimer = deps.setPollTimer || setTimeout;
  const clearPollTimer = deps.clearPollTimer || clearTimeout;

  let timer = null;
  let timerStartedAt = 0;
  let collecting = false;
  let extracting = false;
  let snapshot = null;
  // Live-watch lane state (live collection mode only). Timestamps use null —
  // not 0 — as the unset sentinel so a monotonic clock starting near zero is
  // still a valid point in time.
  let watchWatcher = null;
  let watchQuietTimer = null;
  let watchFirstEventAt = null;
  let lastWatchCollectAt = null;
  let watchSkipLogged = false;
  // Signature-polling heartbeat (live mode): fires collectNow('watch') on a
  // fixed cadence; the P1 check inside absorbs unchanged-database ticks.
  let pollTimer = null;
  let pollActive = false;
  // P2 incremental state: the whole-table high-water id and the accumulated
  // rows keyed by messageId (which carries the id, so re-read overlap rows
  // refresh in place instead of double-counting).
  let lastMaxId = 0;
  const accumulatedRows = new Map();
  let lastSourceSignature = null;
  let lastAttemptAt = null;
  let lastSuccessAt = null;
  let lastError = null;
  let lastErrorCode = null;
  let lastExtractError = null;
  let lastExtractErrorCode = null;

  function supported() {
    return (deps.platform || process.platform) === 'win32';
  }

  function dbPath() {
    return deps.dbPath || traeDataPaths().dbPaths[0] || '';
  }

  // Trae follows the global Collection cadence (设置 → 采集频率): live drives
  // collection from a directory watch (this timer is its backstop), smart
  // keeps its 10-minute pace, and interval modes use the user's choice.
  function intervalMs() {
    const settings = getSettings() || {};
    if (settings.collectionMode === 'smart') return TRAE_SMART_INTERVAL_MS;
    if (settings.collectionMode === 'interval') {
      return normalizeTraeIntervalMs(settings.collectionIntervalMs);
    }
    return TRAE_LIVE_INTERVAL_MS;
  }

  function watchActiveMode() {
    const mode = (getSettings() || {}).collectionMode;
    return mode !== 'smart' && mode !== 'interval';
  }

  function enabled() {
    return getSettings()?.traeCollectionEnabled !== false;
  }

  function keyPresent() {
    return Boolean(String(getSettings()?.traeDbKey || '').trim());
  }

  function status() {
    const isSupported = supported();
    const isEnabled = enabled();
    const hasKey = keyPresent();
    const db = dbPath();
    let dbFound = false;
    try { dbFound = Boolean(db) && fs.existsSync(db); } catch (_) {}
    let state = 'idle';
    if (!isSupported) state = 'unsupported';
    else if (!isEnabled) state = 'disabled';
    else if (extracting) state = 'extracting';
    else if (collecting) state = 'collecting';
    else if (!hasKey) state = 'needsKey';
    else if (lastErrorCode) state = lastErrorCode === 'TRAE_KEY_INVALID' ? 'keyInvalid' : 'error';
    else if (lastSuccessAt) state = 'ok';
    const usage = { today: 0, month: 0, allTime: 0, models: [] };
    if (snapshot?.periods) {
      const count = (period) => Math.max(0, Math.round(Number(period?.clients?.[TRAE_CLIENT] || 0)));
      usage.today = count(snapshot.periods.today);
      usage.month = count(snapshot.periods.month);
      usage.allTime = count(snapshot.periods.allTime);
    }
    return {
      supported: isSupported,
      enabled: isEnabled,
      platform: deps.platform || process.platform,
      dbPath: db || '',
      dbFound,
      keyPresent: hasKey,
      state,
      errorCode: lastErrorCode,
      lastError,
      lastExtractErrorCode,
      lastExtractError,
      lastAttemptAt,
      lastSuccessAt,
      nextCollectAt: timer ? new Date(timerStartedAt + intervalMs()).toISOString() : null,
      intervalMs: intervalMs(),
      watchActive: Boolean(watchWatcher),
      lastActivityAt: snapshot?.lastActivityAt || null,
      usage,
      rowCount: snapshot?.rowCount || 0,
      capturedAt: snapshot?.capturedAt || null
    };
  }

  function emit() {
    pushStatus(status());
  }

  function disarm() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      timerStartedAt = 0;
    }
  }

  // ---- Live watch lane (live collection mode only) -----------------------
  // The Trae ai-agent directory is watched for database.db / -wal writes; a
  // quiet-window debounce turns bursts (streaming turns write continuously)
  // into one collect shortly after the last write.

  function isWatchedName(filename) {
    // Windows directory watches may report the full path, a relative path,
    // or a bare basename; normalize before comparing.
    const base = String(filename || '').replace(/\\/g, '/').split('/').pop();
    return base === 'database.db' || base === 'database.db-wal';
  }

  function teardownWatcher() {
    if (watchQuietTimer) {
      clearWatchTimer(watchQuietTimer);
      watchQuietTimer = null;
    }
    watchFirstEventAt = null;
    if (watchWatcher) {
      try { watchWatcher.close(); } catch (_) {}
      watchWatcher = null;
    }
  }

  function fireWatchCollect() {
    watchQuietTimer = null;
    watchFirstEventAt = null;
    const gap = lastWatchCollectAt === null ? Infinity : nowMs() - lastWatchCollectAt;
    if (gap < TRAE_WATCH_MIN_GAP_MS) {
      // Slide to the end of the min gap instead of stacking collects.
      watchQuietTimer = setWatchTimer(fireWatchCollect, TRAE_WATCH_MIN_GAP_MS - gap);
      if (typeof watchQuietTimer.unref === 'function') watchQuietTimer.unref();
      return;
    }
    lastWatchCollectAt = nowMs();
    collectNow('watch').catch((error) => log(`[trae-collection] watch collect failed: ${error.message}`));
  }

  function scheduleWatchCollect() {
    if (!watchWatcher) return;
    const now = nowMs();
    if (watchFirstEventAt === null) watchFirstEventAt = now;
    // Quiet window, capped so a burst that never pauses still collects.
    const sinceFirst = now - watchFirstEventAt;
    const delay = Math.max(0, Math.min(TRAE_WATCH_QUIET_MS, TRAE_WATCH_MAX_WAIT_MS - sinceFirst));
    if (watchQuietTimer) clearWatchTimer(watchQuietTimer);
    watchQuietTimer = setWatchTimer(fireWatchCollect, delay);
    if (typeof watchQuietTimer.unref === 'function') watchQuietTimer.unref();
  }

  function setupWatcher() {
    if (!watchActiveMode() || watchWatcher || !supported()) return;
    const db = dbPath();
    const dir = db ? path.dirname(db) : '';
    if (!dir) return;
    try {
      if (!fsApi.existsSync(dir)) {
        if (!watchSkipLogged) {
          watchSkipLogged = true;
          log(`[trae-collection] live watch skipped, directory not found: ${dir}`);
        }
        return;
      }
      // persistent watchers: a non-persistent handle stops receiving events
      // the moment nothing else keeps the event loop polling, which made the
      // live lane silently miss every write in an otherwise-idle app.
      watchWatcher = fsApi.watch(dir, { persistent: true }, (event, filename) => {
        if (process.env.TOKEN_MONITOR_TRAE_WATCH_DEBUG) {
          log(`[trae-collection] watch event: ${event} filename=${JSON.stringify(filename)} type=${typeof filename}`);
        }
        // Windows directory watches omit the filename on coalesced/high-rate
        // events; a missing name conservatively counts as a relevant write
        // (the P1 signature check absorbs the no-op cases).
        if (!String(filename || '').trim() || isWatchedName(String(filename))) scheduleWatchCollect();
      });
      watchWatcher.on('error', (error) => {
        log(`[trae-collection] live watch error: ${error.message}`);
        teardownWatcher();
      });
      watchSkipLogged = false;
      log(`[trae-collection] live watch: monitoring ${dir} for database.db/-wal writes`);
    } catch (error) {
      watchWatcher = null;
      log(`[trae-collection] cannot watch ${dir}: ${error.message}`);
    }
  }

  function refreshScheduling(startDelayMs) {
    if (!supported() || !enabled() || !keyPresent()) {
      disarm();
      teardownWatcher();
      stopPolling();
      return;
    }
    arm(startDelayMs);
    if (watchActiveMode()) {
      setupWatcher();
      startPolling();
    } else {
      teardownWatcher();
      stopPolling();
    }
  }

  function startPolling() {
    pollActive = true;
    schedulePoll();
  }

  function stopPolling() {
    pollActive = false;
    if (pollTimer) {
      try { clearPollTimer(pollTimer); } catch (_) {}
      pollTimer = null;
    }
  }

  function schedulePoll() {
    if (!pollActive || pollTimer) return;
    pollTimer = setPollTimer(pollOnce, TRAE_WATCH_POLL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function pollOnce() {
    pollTimer = null;
    if (!pollActive) return;
    // Share the watch lane's min-gap rule so a watch collect and a poll
    // cannot stack back-to-back; the gap here is a slide, never a skip.
    const gap = lastWatchCollectAt === null ? Infinity : nowMs() - lastWatchCollectAt;
    if (gap < TRAE_WATCH_MIN_GAP_MS) {
      pollTimer = setPollTimer(pollOnce, TRAE_WATCH_MIN_GAP_MS - gap);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
      return;
    }
    collectNow('watch').catch((error) => log(`[trae-collection] watch collect failed: ${error.message}`));
    schedulePoll();
  }

  function arm(delayMs) {
    disarm();
    if (!supported() || !enabled() || !keyPresent()) return;
    const delay = Math.max(TRAE_COLLECTION_MIN_INTERVAL_MS, Number(delayMs) || intervalMs());
    timerStartedAt = nowMs();
    timer = setTimeout(() => {
      timer = null;
      collectNow('interval').catch((error) => log(`[trae-collection] interval collect failed: ${error.message}`));
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // Sync throws and async rejections both funnel into the log: a broken nudge
  // must never surface as a failed collect.
  function nudgeCollectorSafely() {
    try {
      Promise.resolve(nudgeCollector()).catch((error) => log(`[trae-collection] collector nudge failed: ${error.message}`));
    } catch (error) {
      log(`[trae-collection] collector nudge failed: ${error.message}`);
    }
  }

  async function collectNow(reason = 'manual') {
    if (!supported()) return status();
    if (collecting) return status();
    const settings = getSettings() || {};
    if (!enabled()) return status();
    const encKey = String(settings.traeDbKey || '').trim();
    if (!encKey) {
      lastErrorCode = 'TRAE_KEY_MISSING';
      lastError = 'trae: no database key saved yet';
      emit();
      return status();
    }
    const db = dbPath();
    // P1: an unchanged database (main file AND WAL) means no new turn can
    // exist — reuse the cached snapshot without touching the 400MB decrypt.
    const signature = sourceSignature(db);
    if (snapshot && signature && signature === lastSourceSignature) {
      // Log only the low-frequency backstop: watch-path skips are frequent and
      // would bury the one line that says the timer lane is healthy.
      if (reason === 'interval') {
        log(`[trae-collection] interval collect skipped, database unchanged since ${lastSuccessAt || 'never'}`);
      }
      arm(intervalMs());
      emit();
      return status();
    }
    collecting = true;
    lastAttemptAt = new Date(nowMs()).toISOString();
    emit();
    try {
      const collectedAt = new Date(nowMs());
      const workDir = options.workDir || path.join(options.userDataPath || '.', 'trae-collection');
      const collectArgs = {
        dbPath: db,
        encKey,
        workDir,
        sinceId: lastMaxId || undefined,
        onProgress: (progress) => log(`[trae-collection] decrypt ${progress.page}/${progress.totalPages} pages`)
      };
      let result = await collectSnapshot(collectArgs);
      // chat_turn rebuilt under us (clear/recreate keeps a small MAX(id)): the
      // accumulated rows are stale, redo once as a full read.
      if (lastMaxId && Number.isFinite(result.maxId) && result.maxId < lastMaxId) {
        log('[trae-collection] rowid regressed, falling back to a full read');
        accumulatedRows.clear();
        lastMaxId = 0;
        result = await collectSnapshot({ ...collectArgs, sinceId: undefined });
      }
      for (const row of result.rows) accumulatedRows.set(row.messageId, row);
      const rows = [...accumulatedRows.values()];
      if (Number.isFinite(result.maxId) && result.maxId > lastMaxId) lastMaxId = result.maxId;
      // The newest actual turn in the data — what "last activity" should mean.
      // capturedAt is only the collect time and moves on every tick, so it
      // must never back the UI's last-activity display.
      let lastActivityAt = 0;
      for (const row of rows) {
        const at = Number(row.createdAt) || 0;
        if (at > lastActivityAt) lastActivityAt = at;
      }
      snapshot = {
        periods: buildPeriods({ now: collectedAt, rows }),
        graph: buildGraph({ rows }),
        capturedAt: collectedAt.toISOString(),
        lastActivityAt: lastActivityAt || null,
        day: localDayKeyOf(collectedAt),
        month: localMonthKeyOf(collectedAt),
        rowCount: rows.length
      };
      lastSourceSignature = signature;
      lastSuccessAt = new Date(nowMs()).toISOString();
      lastError = null;
      lastErrorCode = null;
      const walSuffix = result.walPages ? ` +${result.walPages} WAL pages` : '';
      const mode = result.targeted
        ? `targeted read, ${result.pages} pages (~${Math.max(1, Math.round((result.bytes || 0) / 1024))}KB)${walSuffix}`
        : `full decrypt, ${result.pages} pages${walSuffix}`;
      log(`[trae-collection] collected ${result.rows.length} new rows (${rows.length} total, ${mode}) for ${reason}`);
      if (result.targetedFallback) {
        log(`[trae-collection] targeted read fell back to full decrypt: ${result.targetedFallback.code}: ${result.targetedFallback.message}`);
      }
      nudgeCollectorSafely();
    } catch (error) {
      lastError = error.message;
      lastErrorCode = error.code || 'TRAE_COLLECT_FAILED';
      log(`[trae-collection] collect failed: ${error.message}`);
    } finally {
      collecting = false;
      arm(intervalMs());
      emit();
    }
    return status();
  }

  async function extractAndSaveKey() {
    if (!supported()) {
      lastExtractErrorCode = 'TRAE_NOT_WINDOWS';
      lastExtractError = 'trae: key extraction requires Windows';
      emit();
      return { ok: false, error: lastExtractError, code: lastExtractErrorCode };
    }
    if (extracting || collecting) {
      return { ok: false, error: 'trae: another key extraction or collection is running', code: 'TRAE_BUSY' };
    }
    extracting = true;
    lastExtractError = null;
    lastExtractErrorCode = null;
    emit();
    try {
      const found = extractKey({ dbPath: dbPath() });
      await updateSettings({ traeDbKey: found.encKey });
      log(`[trae-collection] key extracted from pid ${found.pid}`);
    } catch (error) {
      lastExtractError = error.message;
      lastExtractErrorCode = error.code || 'TRAE_EXTRACT_FAILED';
      log(`[trae-collection] key extraction failed: ${error.message}`);
      return { ok: false, error: error.message, code: lastExtractErrorCode };
    } finally {
      extracting = false;
      emit();
    }
    // Key just arrived: collect immediately instead of waiting for the timer.
    const result = await collectNow('after-extract');
    return { ok: true, status: result };
  }

  // Settings may have toggled enabled/interval/mode or removed the key.
  function onSettingsChanged() {
    if (!enabled() || !keyPresent()) {
      disarm();
      teardownWatcher();
      stopPolling();
      if (!keyPresent()) {
        snapshot = null;
        // A new key means a different (or reset) database; the incremental
        // cursor and accumulated rows from the old one are meaningless.
        lastMaxId = 0;
        accumulatedRows.clear();
        lastSourceSignature = null;
      }
    } else {
      refreshScheduling();
    }
    emit();
  }

  function start() {
    refreshScheduling(TRAE_COLLECTION_STARTUP_DELAY_MS);
  }

  function stop() {
    disarm();
    teardownWatcher();
    stopPolling();
  }

  // Post-collector transform seam: adds the last collected Trae CN snapshot to
  // a fresh collector summary. Per-tick summaries are fresh objects, so adding
  // the same snapshot to every tick is additive rather than cumulative.
  function applyToSummary(summary, meta = {}) {
    if (!summary || !enabled() || !supported() || !snapshot) return summary;
    const now = summary.updatedAt ? new Date(summary.updatedAt) : new Date(nowMs());
    applyTraeCollectionUsage(summary, snapshot, { now });
    // History is only merged into ticks that actually carry one, so a history-
    // less tick cannot stomp a fuller history carried forward by the runtime.
    if (meta.preview !== true && summary.history && typeof summary.history === 'object' && snapshot.graph) {
      applyTraeCollectionHistory(summary, snapshot.graph, {
        todayKey: localDayKeyOf(now),
        capDays: meta.capDays
      });
    }
    return summary;
  }

  emit();
  return {
    applyToSummary,
    collectNow,
    extractAndSaveKey,
    onSettingsChanged,
    start,
    status,
    stop
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  TRAE_COLLECTION_STARTUP_DELAY_MS,
  createTraeCollection,
  normalizeTraeIntervalMs
};
