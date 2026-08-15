'use strict';

const STATE_VERSION = 2;
const MIN_VALID_SAMPLE_COUNT = 3;
const MAX_CYCLES_PER_ACCOUNT = 12;
const MAX_SAMPLES_PER_CYCLE = 200;
const MAX_SEGMENTS_PER_CYCLE = 32;
const RESET_AT_JITTER_MS = 2 * 60 * 1000;
const EPSILON = 0.000001;

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
  const status = ['anchor', 'valid', 'anomaly', 'rejected', 'reset'].includes(value?.status)
    ? value.status
    : 'rejected';
  const previousRawCostUsd = finiteNumber(value?.previousRawCostUsd) ?? previousCostUsd;
  const currentRawCostUsd = finiteNumber(value?.currentRawCostUsd) ?? currentCostUsd;
  const rawCostDeltaUsd = finiteNumber(value?.rawCostDeltaUsd)
    ?? currentRawCostUsd - previousRawCostUsd;
  const previousTokens = Math.max(0, Math.round(finiteNumber(value?.previousTokens) || 0));
  const currentTokens = Math.max(0, Math.round(finiteNumber(value?.currentTokens) || 0));
  const tokenDelta = finiteNumber(value?.tokenDelta) ?? currentTokens - previousTokens;
  return {
    sampleVersion: 2,
    id: String(value?.id || `${jumpObservedAt}:${beforeRemainingPercent}:${afterRemainingPercent}:${status}`),
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
    costDeltaUsd,
    previousRawCostUsd: Math.max(0, previousRawCostUsd),
    currentRawCostUsd: Math.max(0, currentRawCostUsd),
    rawCostDeltaUsd,
    previousTokens,
    currentTokens,
    tokenDelta: Math.round(tokenDelta)
  };
}

function normalizeSegment(value, fallbackId = 1) {
  const start = normalizeObservation(value?.start);
  const latest = normalizeObservation(value?.latest);
  if (!start || !latest) return null;
  const estimateStart = normalizeObservation(value?.estimateStart);
  const estimateEnd = normalizeObservation(value?.estimateEnd);
  return {
    id: Math.max(1, Math.round(finiteNumber(value?.id) || fallbackId)),
    status: value?.status === 'closed' ? 'closed' : 'active',
    reason: String(value?.reason || ''),
    startedAt: isoTimestamp(value?.startedAt) || start.observedAt,
    endedAt: isoTimestamp(value?.endedAt),
    start,
    latest,
    estimateStart,
    estimateEnd: estimateStart && estimateEnd ? estimateEnd : estimateStart
  };
}

function newSegment(sample, id) {
  return {
    id,
    status: 'active',
    reason: '',
    startedAt: sample.observedAt,
    endedAt: null,
    start: sample,
    latest: sample,
    estimateStart: null,
    estimateEnd: null
  };
}

function segmentEstimate(segment) {
  // Intermediate counter regressions and their later rebound cancel naturally
  // here. Only the two endpoints of one uninterrupted local observation span
  // contribute to the estimate.
  const start = segment?.estimateStart;
  const end = segment?.estimateEnd;
  const spanPercent = start && end ? end.usedPercent - start.usedPercent : 0;
  if (!(spanPercent > EPSILON)) return { costUsd: 0, spanPercent: 0, sampleCount: 0 };
  return {
    costUsd: end.costUsd - start.costUsd,
    spanPercent,
    sampleCount: Math.max(0, Math.round(spanPercent))
  };
}

function baseCycleFields(value) {
  return {
    compactedEstimateCostUsd: finiteNumber(value?.compactedEstimateCostUsd) || 0,
    compactedEstimateSpanPercent: Math.max(0, finiteNumber(value?.compactedEstimateSpanPercent) || 0),
    compactedEstimateSampleCount: Math.max(0, Math.round(finiteNumber(value?.compactedEstimateSampleCount) || 0))
  };
}

function normalizeCycleV2(value) {
  const resetAt = isoTimestamp(value?.resetAt);
  const latest = normalizeObservation(value?.latest);
  if (!resetAt || !latest) return null;
  const segments = (value?.segments || []).map((segment, index) => (
    normalizeSegment(segment, index + 1)
  )).filter(Boolean).slice(-MAX_SEGMENTS_PER_CYCLE);
  if (segments.length === 0) segments.push(newSegment(latest, 1));
  if (!segments.some((segment) => segment.status === 'active')) {
    segments.push(newSegment(latest, Math.max(...segments.map((segment) => segment.id)) + 1));
  }
  return {
    id: String(value?.id || `${resetAt}#${latest.observedAt}`),
    resetAt,
    startedAt: isoTimestamp(value?.startedAt) || latest.observedAt,
    latest,
    nextSegmentId: Math.max(
      Math.round(finiteNumber(value?.nextSegmentId) || 1),
      ...segments.map((segment) => segment.id + 1)
    ),
    ...baseCycleFields(value),
    segments: segments.slice(-MAX_SEGMENTS_PER_CYCLE),
    samples: (value?.samples || []).map(normalizeJumpSample).filter(Boolean).slice(-MAX_SAMPLES_PER_CYCLE)
  };
}

function migrateCycleV1(value) {
  const resetAt = isoTimestamp(value?.resetAt);
  const latest = normalizeObservation(value?.latest);
  if (!resetAt || !latest) return null;
  const samples = (value?.samples || []).map(normalizeJumpSample).filter(Boolean).slice(-MAX_SAMPLES_PER_CYCLE);
  const valid = samples.filter((sample) => sample.status === 'valid' && Math.abs(sample.percentDelta - 1) < EPSILON);
  const segmentId = Math.max(1, Math.round(finiteNumber(value?.segmentId) || 1)) + 1;
  return {
    id: String(value?.id || `${resetAt}#${latest.observedAt}`),
    resetAt,
    startedAt: isoTimestamp(value?.startedAt) || latest.observedAt,
    latest,
    nextSegmentId: segmentId + 1,
    compactedEstimateCostUsd: valid.reduce((sum, sample) => sum + sample.costDeltaUsd, 0),
    compactedEstimateSpanPercent: valid.length,
    compactedEstimateSampleCount: valid.length,
    segments: [newSegment(latest, segmentId)],
    samples
  };
}

function normalizeState(value) {
  const state = emptyState();
  if (!value || typeof value !== 'object' || ![1, STATE_VERSION].includes(value.version)) return state;
  const cycleNormalizer = value.version === 1 ? migrateCycleV1 : normalizeCycleV2;
  state.activeAccountKey = String(value.activeAccountKey || '');
  for (const [accountKey, entry] of Object.entries(value.accounts || {})) {
    if (!accountKey || !entry || typeof entry !== 'object') continue;
    const cycles = (entry.cycles || []).map(cycleNormalizer).filter(Boolean).slice(-MAX_CYCLES_PER_ACCOUNT);
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

function activeSegment(cycle) {
  return cycle?.segments?.findLast((segment) => segment.status === 'active') || null;
}

function newCycle(resetAt, latest, serial = 1) {
  const cycle = {
    id: `${resetAt}#${latest.observedAt}#${serial}`,
    resetAt,
    startedAt: latest.observedAt,
    latest,
    nextSegmentId: 2,
    compactedEstimateCostUsd: 0,
    compactedEstimateSpanPercent: 0,
    compactedEstimateSampleCount: 0,
    segments: [],
    samples: []
  };
  cycle.segments.push(newSegment(latest, 1));
  return cycle;
}

function timestampDistance(left, right) {
  const leftMs = Date.parse(left || '');
  const rightMs = Date.parse(right || '');
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) ? Math.abs(leftMs - rightMs) : Infinity;
}

function remainingPercent(observation) {
  return 100 - observation.usedPercent;
}

function jumpSample(cycle, accountKey, previous, current, status, reason, segmentId = null) {
  return normalizeJumpSample({
    id: `${cycle.id}:${segmentId || activeSegment(cycle)?.id || 1}:${current.observedAt}:${status}`,
    accountKey,
    quotaCycleId: cycle.id,
    segmentId: segmentId || activeSegment(cycle)?.id || 1,
    jumpObservedAt: current.observedAt,
    status,
    reason,
    beforeRemainingPercent: remainingPercent(previous),
    afterRemainingPercent: remainingPercent(current),
    percentDelta: current.usedPercent - previous.usedPercent,
    previousCostUsd: previous.costUsd,
    currentCostUsd: current.costUsd,
    costDeltaUsd: current.costUsd - previous.costUsd,
    previousRawCostUsd: previous.rawCostUsd,
    currentRawCostUsd: current.rawCostUsd,
    rawCostDeltaUsd: current.rawCostUsd - previous.rawCostUsd,
    previousTokens: previous.tokens,
    currentTokens: current.tokens,
    tokenDelta: current.tokens - previous.tokens
  });
}

function appendSample(cycle, sample) {
  if (!sample || cycle.samples.some((entry) => entry.id === sample.id)) return;
  cycle.samples.push(sample);
  while (cycle.samples.length > MAX_SAMPLES_PER_CYCLE) {
    // Boundary records explain how segments were formed, so discard the oldest
    // diagnostic counter regression before sacrificing one of those records.
    const anomalyIndex = cycle.samples.findIndex((entry) => entry.status === 'anomaly');
    cycle.samples.splice(anomalyIndex >= 0 ? anomalyIndex : 0, 1);
  }
}

function compactOldestSegment(cycle) {
  const index = cycle.segments.findIndex((segment) => segment.status === 'closed');
  if (index < 0) return false;
  const [segment] = cycle.segments.splice(index, 1);
  const estimate = segmentEstimate(segment);
  cycle.compactedEstimateCostUsd += estimate.costUsd;
  cycle.compactedEstimateSpanPercent += estimate.spanPercent;
  cycle.compactedEstimateSampleCount += estimate.sampleCount;
  return true;
}

function closeActiveSegment(cycle, reason) {
  const segment = activeSegment(cycle);
  if (!segment) return;
  segment.status = 'closed';
  segment.reason = reason;
  segment.endedAt = segment.latest.observedAt;
}

function startSegment(cycle, sample) {
  while (cycle.segments.length >= MAX_SEGMENTS_PER_CYCLE) {
    if (!compactOldestSegment(cycle)) break;
  }
  const segment = newSegment(sample, cycle.nextSegmentId);
  cycle.nextSegmentId += 1;
  cycle.segments.push(segment);
  return segment;
}

function estimateFromCycle(cycle, options = {}) {
  const minSampleCount = Math.max(1, Math.round(
    finiteNumber(options.minSampleCount) ?? MIN_VALID_SAMPLE_COUNT
  ));
  let observedCostUsd = finiteNumber(cycle?.compactedEstimateCostUsd) || 0;
  let spanPercent = Math.max(0, finiteNumber(cycle?.compactedEstimateSpanPercent) || 0);
  let sampleCount = Math.max(0, Math.round(finiteNumber(cycle?.compactedEstimateSampleCount) || 0));
  for (const segment of cycle?.segments || []) {
    const estimate = segmentEstimate(segment);
    observedCostUsd += estimate.costUsd;
    spanPercent += estimate.spanPercent;
    sampleCount += estimate.sampleCount;
  }
  const base = {
    status: spanPercent >= minSampleCount && observedCostUsd > 0 ? 'ready' : 'collecting',
    resetAt: cycle?.resetAt || null,
    sampleCount,
    requiredSampleCount: minSampleCount,
    spanPercent,
    observedCostUsd,
    segmentCount: (cycle?.segments || []).length
  };
  if (base.status !== 'ready') return base;
  return {
    ...base,
    estimatedUsd: observedCostUsd * 100 / spanPercent,
    basis: 'segmentEndpointNet'
  };
}

function observeCodexWeeklyQuota(stateValue, observation, options = {}) {
  const state = normalizeState(stateValue);
  const accountKey = String(observation?.accountKey || '').trim();
  const resetAt = isoTimestamp(observation?.resetAt);
  const sample = normalizeObservation(observation);
  if (!accountKey || !resetAt || !sample) return { state, estimate: null, changed: false };

  const previousActiveKey = state.activeAccountKey;
  if (previousActiveKey && previousActiveKey !== accountKey) {
    const previousCycle = currentCycle(state.accounts[previousActiveKey]);
    if (previousCycle) closeActiveSegment(previousCycle, 'accountSwitched');
  }
  state.activeAccountKey = accountKey;

  let account = state.accounts[accountKey];
  if (!account) {
    const cycle = newCycle(resetAt, sample);
    state.accounts[accountKey] = { currentCycleId: cycle.id, cycles: [cycle] };
    return { state, estimate: estimateFromCycle(cycle, options), changed: true };
  }

  let cycle = currentCycle(account);
  const resetCreditConsumed = cycle.latest.resetCreditsAvailable !== null
    && sample.resetCreditsAvailable !== null
    && sample.resetCreditsAvailable < cycle.latest.resetCreditsAvailable;
  const naturalReset = timestampDistance(cycle.resetAt, resetAt) > RESET_AT_JITTER_MS;
  const percentageReset = sample.usedPercent < cycle.latest.usedPercent - EPSILON;
  if (resetCreditConsumed || naturalReset || percentageReset) {
    const reason = resetCreditConsumed ? 'resetCreditConsumed' : naturalReset ? 'resetAtChanged' : 'percentageIncreased';
    appendSample(cycle, jumpSample(cycle, accountKey, cycle.latest, sample, 'reset', reason));
    closeActiveSegment(cycle, reason);
    const next = newCycle(resetAt, sample, account.cycles.length + 1);
    account.cycles.push(next);
    account.cycles = account.cycles.slice(-MAX_CYCLES_PER_ACCOUNT);
    account.currentCycleId = next.id;
    return { state, estimate: estimateFromCycle(next, options), changed: true };
  }

  const accountChanged = previousActiveKey !== accountKey;
  if (accountChanged) {
    startSegment(cycle, sample);
    cycle.latest = sample;
    return { state, estimate: estimateFromCycle(cycle, options), changed: true };
  }

  const previous = cycle.latest;
  const unchanged = sample.usedPercent === previous.usedPercent
    && sample.costUsd === previous.costUsd
    && sample.rawCostUsd === previous.rawCostUsd
    && sample.tokens === previous.tokens
    && sample.resetCreditsAvailable === previous.resetCreditsAvailable;
  if (unchanged) return { state, estimate: estimateFromCycle(cycle, options), changed: false };

  const percentDelta = sample.usedPercent - previous.usedPercent;
  const segment = activeSegment(cycle) || startSegment(cycle, previous);
  if (percentDelta > 1 + EPSILON) {
    appendSample(cycle, jumpSample(cycle, accountKey, previous, sample, 'rejected', 'nonUnitPercentJump', segment.id));
    closeActiveSegment(cycle, 'nonUnitPercentJump');
    startSegment(cycle, sample);
    cycle.latest = sample;
    return { state, estimate: estimateFromCycle(cycle, options), changed: true };
  }

  const costDelta = sample.costUsd - previous.costUsd;
  const tokenDelta = sample.tokens - previous.tokens;
  if (costDelta < -EPSILON || tokenDelta < 0) {
    appendSample(cycle, jumpSample(cycle, accountKey, previous, sample, 'anomaly', 'counterRegression', segment.id));
  }

  segment.latest = sample;

  if (percentDelta > EPSILON) {
    if (!segment.estimateStart) {
      const reason = previous.usedPercent === 0 && sample.usedPercent >= 1
        ? 'initialRoundedBucket'
        : 'initialBoundary';
      appendSample(cycle, jumpSample(cycle, accountKey, previous, sample, 'anchor', reason, segment.id));
      segment.estimateStart = sample;
      segment.estimateEnd = sample;
    } else {
      appendSample(cycle, jumpSample(cycle, accountKey, previous, sample, 'valid', '', segment.id));
      segment.estimateEnd = sample;
    }
  }

  cycle.latest = sample;
  return { state, estimate: estimateFromCycle(cycle, options), changed: true };
}

function officialCodexUsage(record) {
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
  MAX_CYCLES_PER_ACCOUNT,
  MAX_SAMPLES_PER_CYCLE,
  MAX_SEGMENTS_PER_CYCLE,
  MIN_VALID_SAMPLE_COUNT,
  STATE_VERSION,
  emptyState,
  estimateFromCycle,
  extractCodexWeeklyObservation,
  normalizeState,
  observeCodexWeeklyQuota,
  officialCodexUsage
};
