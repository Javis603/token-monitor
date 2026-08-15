'use strict';

const STATE_VERSION = 1;
const MIN_VALID_SAMPLE_COUNT = 3;
const MAX_CYCLES_PER_ACCOUNT = 12;
const MAX_SAMPLES_PER_CYCLE = 200;
const RESET_AT_JITTER_MS = 2 * 60 * 1000;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function emptyState() {
  return { version: STATE_VERSION, activeAccountKey: '', accounts: {} };
}

function normalizeObservation(value) {
  const usedPercent = finiteNumber(value?.usedPercent);
  const costUsd = finiteNumber(value?.costUsd);
  const rawCostUsd = finiteNumber(value?.rawCostUsd);
  const tokens = finiteNumber(value?.tokens);
  const observedAt = isoTimestamp(value?.observedAt);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100
      || costUsd === null || costUsd < 0 || !observedAt) return null;
  const resetCreditsAvailable = finiteNumber(value?.resetCreditsAvailable);
  return {
    usedPercent,
    costUsd,
    rawCostUsd: rawCostUsd === null ? costUsd : Math.max(0, rawCostUsd),
    tokens: tokens === null ? 0 : Math.max(0, Math.round(tokens)),
    observedAt,
    resetCreditsAvailable: resetCreditsAvailable === null
      ? null
      : Math.max(0, Math.round(resetCreditsAvailable))
  };
}

function normalizeJumpSample(value) {
  const jumpObservedAt = isoTimestamp(value?.jumpObservedAt);
  const beforeRemainingPercent = finiteNumber(value?.beforeRemainingPercent);
  const afterRemainingPercent = finiteNumber(value?.afterRemainingPercent);
  const previousCostUsd = finiteNumber(value?.previousCostUsd);
  const currentCostUsd = finiteNumber(value?.currentCostUsd);
  const costDeltaUsd = finiteNumber(value?.costDeltaUsd);
  const percentDelta = finiteNumber(value?.percentDelta);
  if (!jumpObservedAt || beforeRemainingPercent === null || afterRemainingPercent === null
      || previousCostUsd === null || currentCostUsd === null || costDeltaUsd === null
      || percentDelta === null) return null;
  const status = ['anchor', 'valid', 'rejected', 'reset'].includes(value?.status)
    ? value.status
    : 'rejected';
  return {
    sampleVersion: 1,
    id: String(value?.id || `${jumpObservedAt}:${beforeRemainingPercent}:${afterRemainingPercent}`),
    accountKey: String(value?.accountKey || ''),
    quotaCycleId: String(value?.quotaCycleId || ''),
    segmentId: Math.max(1, Math.round(finiteNumber(value?.segmentId) || 1)),
    jumpObservedAt,
    status,
    reason: String(value?.reason || ''),
    beforeRemainingPercent,
    afterRemainingPercent,
    percentDelta,
    previousCostUsd: Math.max(0, previousCostUsd),
    currentCostUsd: Math.max(0, currentCostUsd),
    costDeltaUsd: Math.max(0, costDeltaUsd),
    previousRawCostUsd: Math.max(0, finiteNumber(value?.previousRawCostUsd) ?? previousCostUsd),
    currentRawCostUsd: Math.max(0, finiteNumber(value?.currentRawCostUsd) ?? currentCostUsd),
    rawCostDeltaUsd: Math.max(0, finiteNumber(value?.rawCostDeltaUsd) ?? costDeltaUsd),
    previousTokens: Math.max(0, Math.round(finiteNumber(value?.previousTokens) || 0)),
    currentTokens: Math.max(0, Math.round(finiteNumber(value?.currentTokens) || 0)),
    tokenDelta: Math.max(0, Math.round(finiteNumber(value?.tokenDelta) || 0))
  };
}

function normalizeCycle(value) {
  const resetAt = isoTimestamp(value?.resetAt);
  const latest = normalizeObservation(value?.latest);
  if (!resetAt || !latest) return null;
  return {
    id: String(value?.id || `${resetAt}#${latest.observedAt}`),
    resetAt,
    startedAt: isoTimestamp(value?.startedAt) || latest.observedAt,
    latest,
    anchor: normalizeObservation(value?.anchor),
    deviceObservedCostUsd: Math.max(0, finiteNumber(value?.deviceObservedCostUsd) || 0),
    deviceObservedRawCostUsd: Math.max(0, finiteNumber(value?.deviceObservedRawCostUsd) || 0),
    deviceObservedTokens: Math.max(0, Math.round(finiteNumber(value?.deviceObservedTokens) || 0)),
    deviceObservedPercent: Math.max(0, finiteNumber(value?.deviceObservedPercent) || 0),
    observationStartedAt: isoTimestamp(value?.observationStartedAt) || latest.observedAt,
    observedFromZero: value?.observedFromZero === true,
    segmentId: Math.max(1, Math.round(finiteNumber(value?.segmentId) || 1)),
    samples: (value?.samples || []).map(normalizeJumpSample).filter(Boolean).slice(-MAX_SAMPLES_PER_CYCLE)
  };
}

function normalizeState(value) {
  const state = emptyState();
  if (!value || typeof value !== 'object' || value.version !== STATE_VERSION) return state;
  state.activeAccountKey = String(value.activeAccountKey || '');
  for (const [accountKey, entry] of Object.entries(value.accounts || {})) {
    if (!accountKey || !entry || typeof entry !== 'object') continue;
    const cycles = (entry.cycles || []).map(normalizeCycle).filter(Boolean).slice(-MAX_CYCLES_PER_ACCOUNT);
    if (cycles.length === 0) continue;
    const requested = String(entry.currentCycleId || '');
    const current = cycles.find((cycle) => cycle.id === requested) || cycles.at(-1);
    state.accounts[accountKey] = { currentCycleId: current.id, cycles };
  }
  return state;
}

function currentCycle(account) {
  return account?.cycles?.find((cycle) => cycle.id === account.currentCycleId)
    || account?.cycles?.at(-1)
    || null;
}

function newCycle(resetAt, latest, serial = 1) {
  return {
    id: `${resetAt}#${latest.observedAt}#${serial}`,
    resetAt,
    startedAt: latest.observedAt,
    latest,
    anchor: null,
    deviceObservedCostUsd: 0,
    deviceObservedRawCostUsd: 0,
    deviceObservedTokens: 0,
    deviceObservedPercent: 0,
    observationStartedAt: latest.observedAt,
    observedFromZero: latest.usedPercent === 0,
    segmentId: 1,
    samples: []
  };
}

function timestampDistance(left, right) {
  const leftMs = Date.parse(left || '');
  const rightMs = Date.parse(right || '');
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) ? Math.abs(leftMs - rightMs) : Infinity;
}

function remainingPercent(observation) {
  return 100 - observation.usedPercent;
}

function jumpSample(cycle, accountKey, previous, current, status, reason) {
  const previousCostUsd = previous.costUsd;
  const currentCostUsd = current.costUsd;
  const previousRawCostUsd = previous.rawCostUsd;
  const currentRawCostUsd = current.rawCostUsd;
  const previousTokens = previous.tokens;
  const currentTokens = current.tokens;
  return normalizeJumpSample({
    id: `${cycle.id}:${cycle.segmentId}:${current.observedAt}:${status}`,
    accountKey,
    quotaCycleId: cycle.id,
    segmentId: cycle.segmentId,
    jumpObservedAt: current.observedAt,
    status,
    reason,
    beforeRemainingPercent: remainingPercent(previous),
    afterRemainingPercent: remainingPercent(current),
    percentDelta: current.usedPercent - previous.usedPercent,
    previousCostUsd,
    currentCostUsd,
    costDeltaUsd: Math.max(0, currentCostUsd - previousCostUsd),
    previousRawCostUsd,
    currentRawCostUsd,
    rawCostDeltaUsd: Math.max(0, currentRawCostUsd - previousRawCostUsd),
    previousTokens,
    currentTokens,
    tokenDelta: Math.max(0, currentTokens - previousTokens)
  });
}

function appendSample(cycle, sample) {
  if (!sample || cycle.samples.some((entry) => entry.id === sample.id)) return;
  cycle.samples.push(sample);
  cycle.samples = cycle.samples.slice(-MAX_SAMPLES_PER_CYCLE);
}

function estimateFromCycle(cycle, options = {}) {
  const minSampleCount = Math.max(1, Math.round(
    finiteNumber(options.minSampleCount) ?? MIN_VALID_SAMPLE_COUNT
  ));
  const samples = (cycle?.samples || []).filter((sample) => (
    sample.status === 'valid' && Math.abs(sample.percentDelta - 1) < 0.000001
  ));
  const observedCostUsd = samples.reduce((sum, sample) => sum + sample.costDeltaUsd, 0);
  const base = {
    status: samples.length >= minSampleCount ? 'ready' : 'collecting',
    resetAt: cycle?.resetAt || null,
    sampleCount: samples.length,
    requiredSampleCount: minSampleCount,
    spanPercent: samples.length,
    observedCostUsd,
    deviceObservedCostUsd: Math.max(0, finiteNumber(cycle?.deviceObservedCostUsd) || 0),
    deviceObservedRawCostUsd: Math.max(0, finiteNumber(cycle?.deviceObservedRawCostUsd) || 0),
    deviceObservedTokens: Math.max(0, Math.round(finiteNumber(cycle?.deviceObservedTokens) || 0)),
    deviceObservedPercent: Math.max(0, finiteNumber(cycle?.deviceObservedPercent) || 0),
    observationStartedAt: cycle?.observationStartedAt || null,
    observedFromZero: cycle?.observedFromZero === true
  };
  if (samples.length < minSampleCount || observedCostUsd <= 0) return base;
  return {
    ...base,
    estimatedUsd: observedCostUsd * 100 / samples.length,
    basis: 'unitIntervalMean'
  };
}

function recordReset(cycle, accountKey, sample, reason) {
  const reset = jumpSample(cycle, accountKey, cycle.latest, sample, 'reset', reason);
  appendSample(cycle, reset);
}

function observeCodexWeeklyQuota(stateValue, observation, options = {}) {
  const state = normalizeState(stateValue);
  const accountKey = String(observation?.accountKey || '').trim();
  const resetAt = isoTimestamp(observation?.resetAt);
  const sample = normalizeObservation(observation);
  if (!accountKey || !resetAt || !sample) return { state, estimate: null, changed: false };

  const previousActiveKey = state.activeAccountKey;
  if (previousActiveKey && previousActiveKey !== accountKey) {
    const previousAccount = state.accounts[previousActiveKey];
    const previousCycle = currentCycle(previousAccount);
    if (previousCycle) {
      previousCycle.anchor = null;
      previousCycle.segmentId += 1;
    }
  }
  state.activeAccountKey = accountKey;

  let account = state.accounts[accountKey];
  if (!account) {
    const cycle = newCycle(resetAt, sample);
    state.accounts[accountKey] = { currentCycleId: cycle.id, cycles: [cycle] };
    return { state, estimate: estimateFromCycle(cycle, options), changed: true };
  }

  let cycle = currentCycle(account);
  const accountChanged = previousActiveKey !== accountKey;
  if (accountChanged) {
    cycle.anchor = null;
    cycle.segmentId += 1;
  }

  const resetCreditConsumed = cycle.latest.resetCreditsAvailable !== null
    && sample.resetCreditsAvailable !== null
    && sample.resetCreditsAvailable < cycle.latest.resetCreditsAvailable;
  const naturalReset = timestampDistance(cycle.resetAt, resetAt) > RESET_AT_JITTER_MS;
  const percentageReset = sample.usedPercent < cycle.latest.usedPercent - 0.000001;
  if (resetCreditConsumed || naturalReset || percentageReset) {
    const reason = resetCreditConsumed ? 'resetCreditConsumed' : naturalReset ? 'resetAtChanged' : 'percentageIncreased';
    recordReset(cycle, accountKey, sample, reason);
    const next = newCycle(resetAt, sample, account.cycles.length + 1);
    account.cycles.push(next);
    account.cycles = account.cycles.slice(-MAX_CYCLES_PER_ACCOUNT);
    account.currentCycleId = next.id;
    return { state, estimate: estimateFromCycle(next, options), changed: true };
  }

  if (accountChanged) {
    cycle.latest = sample;
    cycle.anchor = null;
    return { state, estimate: estimateFromCycle(cycle, options), changed: true };
  }

  if (sample.costUsd < cycle.latest.costUsd || sample.tokens < cycle.latest.tokens) {
    cycle.latest = sample;
    cycle.anchor = null;
    cycle.segmentId += 1;
    return { state, estimate: estimateFromCycle(cycle, options), changed: true };
  }

  // The local all-time counter has no account id. Attribute only intervals
  // observed while this account remains active; account-switch gaps are
  // deliberately discarded by the branch above.
  cycle.deviceObservedCostUsd += Math.max(0, sample.costUsd - cycle.latest.costUsd);
  cycle.deviceObservedRawCostUsd += Math.max(0, sample.rawCostUsd - cycle.latest.rawCostUsd);
  cycle.deviceObservedTokens += Math.max(0, sample.tokens - cycle.latest.tokens);
  cycle.deviceObservedPercent += Math.max(0, sample.usedPercent - cycle.latest.usedPercent);

  const percentDelta = sample.usedPercent - cycle.latest.usedPercent;
  if (percentDelta > 0.000001) {
    if (!cycle.anchor) {
      const reason = cycle.latest.usedPercent === 0 && sample.usedPercent >= 1
        ? 'initialRoundedBucket'
        : 'initialBoundary';
      appendSample(cycle, jumpSample(cycle, accountKey, cycle.latest, sample, 'anchor', reason));
      cycle.anchor = sample;
    } else if (Math.abs(percentDelta - 1) < 0.000001) {
      appendSample(cycle, jumpSample(cycle, accountKey, cycle.anchor, sample, 'valid', ''));
      cycle.anchor = sample;
    } else {
      appendSample(cycle, jumpSample(cycle, accountKey, cycle.anchor, sample, 'rejected', 'nonUnitPercentJump'));
      cycle.segmentId += 1;
      cycle.anchor = sample;
    }
  }

  const unchanged = sample.usedPercent === cycle.latest.usedPercent
    && sample.costUsd === cycle.latest.costUsd
    && sample.rawCostUsd === cycle.latest.rawCostUsd
    && sample.tokens === cycle.latest.tokens
    && sample.resetCreditsAvailable === cycle.latest.resetCreditsAvailable;
  cycle.latest = sample;
  return { state, estimate: estimateFromCycle(cycle, options), changed: !unchanged };
}

function officialCodexUsage(record) {
  // Aggregated stats expose periods.allTime, while a freshly collected local
  // device record carries allTime at its root. The estimator deliberately uses
  // the local record in sync/host mode, so both wire-contract shapes are valid.
  const period = record?.periods?.allTime || record?.allTime;
  if (!period || Number(record?.sessionDetailsOmitted?.allTime) > 0) {
    return { costUsd: null, rawCostUsd: null, tokens: null, reason: 'sessionCostsIncomplete' };
  }
  let costUsd = 0;
  let rawCostUsd = 0;
  let tokens = 0;
  let found = false;
  for (const session of Object.values(period.sessions || {})) {
    if (String(session?.client || '').trim().toLowerCase() !== 'codex') continue;
    const providers = Object.entries(session.providers || {}).filter(([, value]) => Number(value) > 0);
    if (providers.length !== 1 || String(providers[0][0]).toLowerCase() !== 'openai') continue;
    found = true;
    rawCostUsd += Math.max(0, finiteNumber(session.costUsd) || 0);
    costUsd += Math.max(0, finiteNumber(session.quotaCostUsd) ?? finiteNumber(session.costUsd) ?? 0);
    tokens += Math.max(0, Math.round(finiteNumber(providers[0][1]) || 0));
  }
  if (!found) return { costUsd: null, rawCostUsd: null, tokens: null, reason: 'officialUsageUnavailable' };
  return { costUsd, rawCostUsd, tokens, reason: null };
}

function localRecordForProvider(stats, provider, localDeviceId = '') {
  const wanted = String(localDeviceId || provider?.sourceDeviceId || '').trim().toLowerCase();
  if (Array.isArray(stats?.devices)) {
    if (wanted) {
      return stats.devices.find((device) => String(device?.deviceId || '').trim().toLowerCase() === wanted) || null;
    }
    return stats.devices.length === 1 ? stats.devices[0] : null;
  }
  return stats;
}

function extractCodexWeeklyObservation(stats, now = Date.now(), options = {}) {
  let providers = (stats?.limits?.providers || []).filter((provider) => (
    String(provider?.provider || '').toLowerCase() === 'codex'
      && (provider?.status === 'ok' || provider?.stale === true)
      && (provider.windows || []).some((window) => String(window?.kind || '').toLowerCase() === 'weekly')
  ));
  const localDeviceId = String(options.localDeviceId || '').trim().toLowerCase();
  if (localDeviceId) {
    const local = providers.filter((provider) => String(provider?.sourceDeviceId || '').trim().toLowerCase() === localDeviceId);
    if (local.length > 0) providers = local;
  }
  const live = providers.filter((provider) => ['app', 'cli'].includes(String(provider?.sourceDetail || '').toLowerCase()));
  if (live.length === 1) providers = live;
  if (providers.length !== 1) return { reason: providers.length ? 'multipleAccounts' : 'unavailable' };

  const provider = providers[0];
  const weekly = (provider.windows || []).find((window) => String(window?.kind || '').toLowerCase() === 'weekly');
  const usedPercent = finiteNumber(weekly?.usedPercent);
  const resetAt = isoTimestamp(weekly?.resetsAt);
  const accountKey = String(provider.accountKey || '').trim() || 'single-codex-account';
  const localRecord = localRecordForProvider(stats, provider, localDeviceId);
  const usage = officialCodexUsage(localRecord);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100 || !resetAt || usage.costUsd === null) {
    return { reason: usage.reason || 'unavailable', accountKey };
  }
  return {
    reason: null,
    accountKey,
    observation: {
      accountKey,
      resetAt,
      usedPercent,
      costUsd: usage.costUsd,
      rawCostUsd: usage.rawCostUsd,
      tokens: usage.tokens,
      observedAt: isoTimestamp(stats?.updatedAt) || new Date(now).toISOString(),
      resetCreditsAvailable: finiteNumber(provider?.resetCredits?.availableCount)
    }
  };
}

module.exports = {
  MIN_VALID_SAMPLE_COUNT,
  STATE_VERSION,
  emptyState,
  estimateFromCycle,
  extractCodexWeeklyObservation,
  normalizeState,
  observeCodexWeeklyQuota,
  officialCodexUsage
};
