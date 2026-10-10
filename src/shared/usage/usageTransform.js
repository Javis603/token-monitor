'use strict';

const fs = require('node:fs');
const { applyArchivedClientUsage, applyDailyHistoryAllTimeFloor } = require('./clientUsageArchive');
const {
  allTimeCumulativeFromArchive,
  dailyHistoryArchivePath,
  readDailyHistoryArchive
} = require('../dailyHistoryArchive');
const {
  applySessionUsageArchive,
  normalizeSessionUsageArchive,
  sessionUsageArchiveDate
} = require('./sessionUsageArchive');
const { readSessionUsageArchiveSnapshot } = require('./sessionUsageArchiveStore');
const { applyProjectRollups } = require('../usage');

// Every setting project() and transform() read. A transform running on another
// thread is handed exactly these (see usageTransformSettings).
const USAGE_TRANSFORM_SETTING_KEYS = Object.freeze([
  'archivedClientUsage',
  'clients',
  'projectsEnabled',
  'sessionUsageArchiveEnabled'
]);

function usageTransformSettings(settings = {}) {
  const picked = {};
  for (const key of USAGE_TRANSFORM_SETTING_KEYS) {
    if (settings?.[key] !== undefined) picked[key] = settings[key];
  }
  return picked;
}

// Reduces the daily history archive to the per-client allTime floor
// (applyDailyHistoryAllTimeFloor's input). The reduction walks every retained
// day, so it is cached against the archive file's mtime: project() runs on every
// tick while the archive only changes on a graph tick, and a watch tick must not
// pay to re-read a year of history it did not touch.
//
// Reading the archive off disk is opt-in: pass `dailyHistoryArchive` (true for
// the default path, or archive options / a custom loader). A transform built
// without it — the default for tests and any caller that does not maintain the
// archive — never touches the filesystem and applies no floor.
function createDailyHistoryFloorReader(options = {}) {
  if (typeof options.loadDailyHistoryFloor === 'function') return options.loadDailyHistoryFloor;
  const config = options.dailyHistoryArchive;
  if (!config) return () => ({});
  const archiveOptions = config === true ? {} : config;
  const read = options.readDailyHistoryArchive || readDailyHistoryArchive;
  let cache = { mtimeMs: undefined, floor: {} };
  return function loadDailyHistoryFloor() {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(dailyHistoryArchivePath(archiveOptions)).mtimeMs;
    } catch (error) {
      // No archive on disk means no floor to apply; a transient stat failure
      // recomputes rather than trusting a possibly stale cache.
      if (error?.code === 'ENOENT') return {};
      mtimeMs = undefined;
    }
    if (mtimeMs !== undefined && cache.mtimeMs === mtimeMs) return cache.floor;
    let floor;
    try {
      floor = allTimeCumulativeFromArchive(read(archiveOptions));
    } catch (_) {
      // A read that fails after the stat succeeded is transient: apply no floor
      // this tick, but do not cache the empty result, so the next call retries
      // even though the file mtime has not changed.
      return {};
    }
    cache = { mtimeMs, floor };
    return floor;
  };
}

// The widget's usage transform: every collected summary passes through here on
// its way to DeviceState. It owns the in-memory session archive and reads the
// settings it depends on through `getSettings()` at call time, so it holds no
// reference into the main process and can run wherever the collector runs.
function createUsageTransform(options = {}) {
  const store = options.store;
  const getSettings = options.getSettings || (() => ({}));
  const isExternalAgentActive = options.isExternalAgentActive || (() => false);
  const readSnapshot = options.readSnapshot || readSessionUsageArchiveSnapshot;
  const onCaptureFailure = options.onCaptureFailure || (() => {});
  const log = options.log || ((message) => console.log(message));
  const loadDailyHistoryFloor = createDailyHistoryFloorReader(options);
  let sessionArchive = null;
  let lastUpdate = {
    at: null,
    durationMs: null,
    failureCode: null
  };

  function ensureLoaded() {
    if (sessionArchive) return sessionArchive;
    try {
      // The headless agent owns migration and pruning while its PID is active.
      // Anchor projection must not turn Electron into a second archive writer.
      sessionArchive = isExternalAgentActive()
        ? readSnapshot()
        : store.read();
    } catch (error) {
      log(`[session-archive] read failed: ${error.message}`);
      sessionArchive = normalizeSessionUsageArchive({});
    }
    return sessionArchive;
  }

  function capture(summary, now) {
    const startedAt = Date.now();
    const finish = (failureCode = null) => {
      lastUpdate = {
        at: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt),
        failureCode
      };
    };
    try {
      const result = store.capture(summary, now);
      sessionArchive = result.archive;
      if (result.error) throw result.error;
    } catch (error) {
      finish('archive-write-failed');
      onCaptureFailure(error);
      log(`[session-archive] write failed: ${error.message}`);
      return sessionArchive || ensureLoaded();
    }
    finish();
    return sessionArchive;
  }

  // Read-only projection of both archives onto a summary. Un-tracked clients and
  // retained sessions add to the period totals, not just to the breakdowns, so
  // anything rendered without this reads low. Takes the session archive as an
  // argument because capturing into it is a separate decision, see below.
  function project(summary, archive, now) {
    const settings = getSettings() || {};
    const withArchivedClients = applyArchivedClientUsage(summary, settings.archivedClientUsage, {
      activeClients: settings.clients,
      now
    });
    // sessionUsageArchiveEnabled also governs whether the daily history archive
    // is maintained (see runtimeConfig.js / agent.js), so the same switch gates
    // its allTime floor: with the archive off there is nothing on disk to raise
    // the total to, and reading a stale file would resurrect what the user chose
    // to stop retaining.
    let visibleSummary;
    if (settings.sessionUsageArchiveEnabled === false) {
      visibleSummary = withArchivedClients;
    } else {
      const withSessions = applySessionUsageArchive(withArchivedClients, archive, {
        now,
        canonical: true,
        canonicalSummary: true,
        mutate: true
      });
      visibleSummary = applyDailyHistoryAllTimeFloor(withSessions, loadDailyHistoryFloor());
    }
    return settings.projectsEnabled === false ? visibleSummary : applyProjectRollups(visibleSummary);
  }

  function transform(summary) {
    const now = sessionUsageArchiveDate(summary);
    if (getSettings()?.sessionUsageArchiveEnabled === false) return project(summary, null, now);
    if (isExternalAgentActive()) {
      try {
        sessionArchive = store.refresh(now);
      } catch (error) {
        log(`[session-archive] refresh failed: ${error.message}`);
        sessionArchive = sessionArchive || normalizeSessionUsageArchive({});
      }
      return project(summary, sessionArchive, now);
    }
    return project(summary, capture(summary, now), now);
  }

  return {
    ensureLoaded,
    project,
    transform,
    // Drops the in-memory copy, so the next use reads the store again.
    forget() {
      sessionArchive = null;
    },
    // For a store that was just cleared: the empty archive is what it now holds.
    reset() {
      sessionArchive = normalizeSessionUsageArchive({});
    },
    getState() {
      return {
        loaded: sessionArchive !== null,
        sessionCount: sessionArchive !== null ? Object.keys(sessionArchive?.sessions || {}).length : null,
        lastUpdate
      };
    }
  };
}

module.exports = {
  USAGE_TRANSFORM_SETTING_KEYS,
  createDailyHistoryFloorReader,
  createUsageTransform,
  usageTransformSettings
};
