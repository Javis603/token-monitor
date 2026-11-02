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
  'manualUsageBases',
  'projectsEnabled',
  'sessionUsageArchiveEnabled'
]);

// TokenLedger: a fixed, user-declared offset for tools whose historical usage
// predates local tracking (rolling logs, desktop clients without token
// detail, other machines). Applied to allTime only, after every other
// projection step, so the anchored delta math stays exact — a constant offset
// cancels in deltas and never compounds, because project() starts from the
// raw collector summary.
//
// A base is either flat ({tool, tokens}) or per-model ({tool, models:
// [{model, tokens, output?, cacheRead?, cacheWrite?, cost?}]}) so declared
// history can carry real model and component attribution (outputs, cache
// reads/writes, cost) instead of degrading into Unclassified. Per-model
// component sums fold into the period's component fields and maps.
function applyManualUsageBases(summary, bases) {
  if (!Array.isArray(bases) || bases.length === 0) return summary;
  // Collector summaries carry periods at the top level (allTime/today/month);
  // normalized device records nest them under .periods. Handle both shapes.
  const allTime = summary?.allTime || summary?.periods?.allTime;
  if (!allTime || typeof allTime !== 'object') return summary;
  for (const base of bases) {
    const tool = String(base?.tool || '').trim();
    if (!tool) continue;
    let flatTokens = Math.max(0, Math.trunc(Number(base?.tokens) || 0));
    const modelEntries = [];
    if (Array.isArray(base?.models)) {
      for (const entry of base.models) {
        const model = String(entry?.model || '').trim();
        const parts = {
          tokens: Math.max(0, Math.trunc(Number(entry?.tokens) || 0)),
          output: Math.max(0, Math.trunc(Number(entry?.output) || 0)),
          cacheRead: Math.max(0, Math.trunc(Number(entry?.cacheRead) || 0)),
          cacheWrite: Math.max(0, Math.trunc(Number(entry?.cacheWrite) || 0)),
          cost: Number(entry?.cost) || 0
        };
        if (model && Object.values(parts).some((v) => v > 0)) {
          modelEntries.push({ model, ...parts });
        }
      }
      if (modelEntries.length > 0) flatTokens = 0;
    }
    const total = modelEntries.length > 0
      ? modelEntries.reduce((sum, e) => sum + e.tokens, 0)
      : flatTokens;
    if (total === 0) continue;
    allTime.totalTokens = (allTime.totalTokens || 0) + total;
    // The per-client token map is `clients` (normalizePeriod's shape) — not
    // clientTokens. Writing the wrong key here is what previously made the
    // bases show up as Unclassified rows in the Tools view.
    const clients = allTime.clients || (allTime.clients = {});
    clients[tool] = (clients[tool] || 0) + total;
    if (modelEntries.length === 0) continue;
    const models = allTime.models || (allTime.models = {});
    const clientModels = allTime.clientModels || (allTime.clientModels = {});
    const perClient = clientModels[tool] || (clientModels[tool] = {});
    // Component sums fold into the period fields and the per-client maps.
    let sumOutput = 0;
    let sumCacheRead = 0;
    let sumCacheWrite = 0;
    let sumCost = 0;
    for (const { model, tokens, output, cacheRead, cacheWrite, cost } of modelEntries) {
      if (tokens > 0) {
        models[model] = (models[model] || 0) + tokens;
        perClient[model] = (perClient[model] || 0) + tokens;
      }
      if (output > 0) {
        const map = allTime.modelOutputs || (allTime.modelOutputs = {});
        map[model] = (map[model] || 0) + output;
        sumOutput += output;
      }
      if (cacheRead > 0) {
        const map = allTime.modelCacheReads || (allTime.modelCacheReads = {});
        map[model] = (map[model] || 0) + cacheRead;
        sumCacheRead += cacheRead;
      }
      if (cacheWrite > 0) {
        const map = allTime.modelCacheWrites || (allTime.modelCacheWrites = {});
        map[model] = (map[model] || 0) + cacheWrite;
        sumCacheWrite += cacheWrite;
      }
      if (cost > 0) {
        const map = allTime.modelCosts || (allTime.modelCosts = {});
        map[model] = (map[model] || 0) + cost;
        sumCost += cost;
      }
    }
    if (sumOutput > 0) {
      allTime.outputTokens = (allTime.outputTokens || 0) + sumOutput;
      const cm = allTime.clientOutputs || (allTime.clientOutputs = {});
      cm[tool] = (cm[tool] || 0) + sumOutput;
    }
    if (sumCacheRead > 0) {
      allTime.cacheReadTokens = (allTime.cacheReadTokens || 0) + sumCacheRead;
      const cm = allTime.clientCacheReads || (allTime.clientCacheReads = {});
      cm[tool] = (cm[tool] || 0) + sumCacheRead;
    }
    if (sumCacheWrite > 0) {
      allTime.cacheWriteTokens = (allTime.cacheWriteTokens || 0) + sumCacheWrite;
      const cm = allTime.clientCacheWrites || (allTime.clientCacheWrites = {});
      cm[tool] = (cm[tool] || 0) + sumCacheWrite;
    }
    if (sumCost > 0) {
      allTime.costUsd = (allTime.costUsd || 0) + sumCost;
      const cm = allTime.clientCosts || (allTime.clientCosts = {});
      cm[tool] = (cm[tool] || 0) + sumCost;
    }
  }
  return summary;
}

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
  // TokenLedger: optional summary extra attached after projection so worker
  // and in-process paths enrich identically. Must be fail-soft by contract.
  const attachCredits = options.attachCredits || null;
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
      now,
      shareSessions: true
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
    const rolledUp = settings.projectsEnabled === false ? visibleSummary : applyProjectRollups(visibleSummary);
    const withBases = applyManualUsageBases(rolledUp, settings.manualUsageBases);
    return attachCredits ? attachCredits(withBases) : withBases;
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
