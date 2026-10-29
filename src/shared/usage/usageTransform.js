'use strict';

const { applyArchivedClientUsage } = require('./clientUsageArchive');
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
    const withArchivedClients = applyArchivedClientUsage(summary, settings.archivedClientUsage, {
      activeClients: settings.clients,
      now
    });
    const visibleSummary = settings.sessionUsageArchiveEnabled === false
      ? withArchivedClients
      : applySessionUsageArchive(withArchivedClients, archive, {
          now,
          canonical: true,
          canonicalSummary: true,
          mutate: true
        });
    delete visibleSummary.sessionUsageArchiveFullScan;
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
