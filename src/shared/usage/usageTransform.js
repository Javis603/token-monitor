'use strict';

const { applyArchivedClientUsage } = require('./clientUsageArchive');
const {
  applySessionDayArchive,
  applySessionUsageArchive,
  normalizeSessionUsageArchive,
  sessionUsageArchiveDate
} = require('./sessionUsageArchive');
const { readSessionUsageArchiveSnapshot } = require('./sessionUsageArchiveStore');
const { applyProjectRollups, projectRollupFromSessions } = require('../usage');

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

// Retained legacy data can contain a Month total without exact daily slices.
// Keep publishing the ordinary record if day rows cannot reconstruct its usage.
function dailySessionsCoverSummary(days, summary) {
  const today = summary.periodWindows?.today?.key;
  const windows = {
    ...summary.nativeRangeWindows,
    today: { start: today, end: today },
    month: { start: today?.slice(0, 7) + '-01', end: today }
  };
  // Hub aggregates expose USD to six decimal places. Allow sub-resolution
  // noise from summing the same observations in different orders.
  const costsMatch = (left, right) => Math.abs((left || 0) - (right || 0)) <= 0.0000005;
  for (const [name, window] of Object.entries(windows)) {
    const expected = name === 'today' || name === 'month' ? summary[name] : summary.nativeRanges?.[name];
    if (!expected || !window.end) return false;
    const totals = new Map();
    let tokens = 0;
    let cost = 0;
    for (const [day, period] of Object.entries(days)) {
      if (day < window.start || day > window.end) continue;
      tokens += period.totalTokens;
      cost += period.costUsd || 0;
      for (const [key, row] of Object.entries(period.sessions || {})) {
        const total = totals.get(key) || { tokens: 0, cost: 0 };
        total.tokens += row.totalTokens;
        total.cost += row.costUsd || 0;
        totals.set(key, total);
      }
    }
    const sessions = Object.entries(expected.sessions || {});
    if (tokens !== expected.totalTokens || !costsMatch(cost, expected.costUsd) || totals.size !== sessions.length
      || sessions.some(([key, row]) => {
        const total = totals.get(key);
        return !total || total.tokens !== row.totalTokens || !costsMatch(total.cost, row.costUsd);
      })) return false;
  }
  return true;
}

// The widget's usage transform: every collected summary passes through here on
// its way to DeviceState. It owns the in-memory session archive and reads the
// settings it depends on through `getSettings()` at call time, so it holds no
// reference into the main process and can run wherever the collector runs.
function createUsageTransform(options = {}) {
  const store = options.store;
  const getSettings = options.getSettings || (() => ({}));
  const isExternalAgentActive = options.isExternalAgentActive || (() => false);
  const readSnapshot = options.readSnapshot || store?.snapshot || readSessionUsageArchiveSnapshot;
  const onCaptureFailure = options.onCaptureFailure || (() => {});
  const log = options.log || ((message) => console.log(message));
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
        ? readSnapshot({ strict: true })
        : store.read();
    } catch (error) {
      log(`[session-archive] read failed: ${error.message}`);
      throw error;
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
      if (result.error) throw result.error;
      sessionArchive = result.archive;
    } catch (error) {
      finish('archive-write-failed');
      onCaptureFailure(error);
      log(`[session-archive] write failed: ${error.message}`);
      // A loaded object may be stale or contain an uncommitted mutation. Do
      // not project it as a successful tick; DeviceState keeps its usagePart.
      throw error;
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
    // Past-day sessions are capture input only; no record carries them.
    const { nativeRangeDays: _days, ...published } = summary;
    const withArchivedClients = applyArchivedClientUsage(published, settings.archivedClientUsage, {
      activeClients: settings.clients,
      now,
      shareSessions: true
    });
    const visibleSummary = settings.sessionUsageArchiveEnabled === false
      ? withArchivedClients
      : applySessionDayArchive(applySessionUsageArchive(withArchivedClients, archive, {
          now,
          canonical: true,
          canonicalSummary: true,
          mutate: true
        }), archive, { now, canonical: true, activeClients: settings.clients });
    delete visibleSummary.sessionUsageArchiveFullScan;
    const days = summary.dailySessionPeriods;
    if (days) {
      const windows = Object.fromEntries(Object.keys(days).map(day => [day, { start: day, end: day }]));
      const restored = settings.sessionUsageArchiveEnabled === false ? days
        : applySessionDayArchive({ nativeRanges: days, nativeRangeWindows: windows }, archive, {
          now, canonical: true, activeClients: settings.clients
        }).nativeRanges;
      if (dailySessionsCoverSummary(restored, visibleSummary)) {
        visibleSummary.dailySessionPeriods = Object.fromEntries(Object.entries(restored).map(([day, period]) => [day, {
          ...period,
          projects: settings.projectsEnabled === false ? {} : projectRollupFromSessions(period.sessions)
        }]));
      } else {
        delete visibleSummary.dailySessionPeriods;
      }
    }
    return settings.projectsEnabled === false ? visibleSummary : applyProjectRollups(visibleSummary);
  }

  function transform(summary, _reason, meta = {}) {
    const now = sessionUsageArchiveDate(summary);
    if (getSettings()?.sessionUsageArchiveEnabled === false) return project(summary, null, now);
    if (meta.preview === true) return project(summary, readSnapshot({ strict: true }), now);
    if (isExternalAgentActive()) {
      try {
        sessionArchive = store.refresh(now, { strict: true });
      } catch (error) {
        log(`[session-archive] refresh failed: ${error.message}`);
        throw error;
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
    // Unlike forget(), also drops the store's owning reference and connection.
    // The same transform can safely load again if collection falls back here.
    release() {
      sessionArchive = null;
      store.release();
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
  createUsageTransform,
  usageTransformSettings
};
