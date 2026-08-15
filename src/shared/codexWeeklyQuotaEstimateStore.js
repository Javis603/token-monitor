'use strict';

const path = require('node:path');
const { readJson, sharedDataDir, writeJsonAtomic } = require('./config');
const {
  emptyState,
  extractCodexWeeklyObservation,
  normalizeState,
  observeCodexWeeklyQuota
} = require('./codexWeeklyQuotaEstimate');
const { officialCodexQuotaUsageSince } = require('./codexQuotaCost');

function defaultFilePath() {
  return path.join(sharedDataDir(), 'codex-weekly-quota-samples.json');
}

function createCodexWeeklyQuotaEstimateStore(options = {}) {
  const filePath = options.filePath || defaultFilePath();
  const read = options.readJson || readJson;
  const write = options.writeJsonAtomic || writeJsonAtomic;
  let state;

  function ensureLoaded() {
    if (!state) state = normalizeState(read(filePath, emptyState()));
    return state;
  }

  return {
    filePath,
    observe(stats, observeOptions = {}) {
      const extracted = extractCodexWeeklyObservation(stats, observeOptions.now, observeOptions);
      if (!extracted.observation) {
        return {
          estimate: extracted.accountKey ? { status: 'collecting', reason: extracted.reason } : null,
          reason: extracted.reason,
          accountKey: extracted.accountKey || '',
          changed: false
        };
      }
      const result = observeCodexWeeklyQuota(ensureLoaded(), extracted.observation, observeOptions);
      state = result.state;
      if (result.changed) write(filePath, state);
      const period = extracted.localRecord?.periods?.allTime || extracted.localRecord?.allTime;
      const historyUsage = Number(extracted.localRecord?.sessionDetailsOmitted?.allTime) > 0
        ? { costUsd: null, reason: 'historyIncomplete' }
        : (options.historicalUsage || officialCodexQuotaUsageSince)(
            period,
            result.estimate?.historySince,
            { homeDir: observeOptions.homeDir }
          );
      return {
        estimate: result.estimate ? {
          ...result.estimate,
          currentDeviceUsageUsd: historyUsage.costUsd,
          currentDeviceUsageSince: result.estimate.historySince,
          currentDeviceUsageReason: historyUsage.reason
        } : null,
        reason: null,
        accountKey: extracted.accountKey,
        changed: result.changed
      };
    },
    snapshot() {
      return structuredClone(ensureLoaded());
    }
  };
}

module.exports = { createCodexWeeklyQuotaEstimateStore, defaultFilePath };
