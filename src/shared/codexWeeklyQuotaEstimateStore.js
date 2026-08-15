'use strict';

const path = require('node:path');
const { readJson, sharedDataDir, writeJsonAtomic } = require('./config');
const {
  emptyState,
  extractCodexWeeklyObservation,
  normalizeState,
  observeCodexWeeklyQuota
} = require('./codexWeeklyQuotaEstimate');

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
      return {
        estimate: result.estimate,
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
