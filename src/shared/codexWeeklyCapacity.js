'use strict';

const ARCHIVE_VERSION = 1;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ACCOUNTS = 20;
const MAX_SEGMENTS_PER_ACCOUNT = 24;
const MAX_SAMPLES_PER_SEGMENT = 200;
const RESET_JITTER_MS = 2 * 60 * 1000;
const MIN_ESTIMATE_PERCENT_SPAN = 1;
const MIN_STABLE_PERCENT_SPAN = 5;
const STABLE_R_SQUARED = 0.98;
const STABLE_NORMALIZED_RMSE = 0.1;

function finite(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value, max = 160) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function iso(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function emptyCodexWeeklyCapacityArchive() {
  return {
    version: ARCHIVE_VERSION,
    accounts: [],
    lastCapture: null
  };
}

function cleanSample(value) {
  const observedAt = iso(value?.observedAt);
  const usedPercent = finite(value?.usedPercent);
  const accountTokens = finite(value?.accountTokens);
  if (!observedAt || usedPercent === null || usedPercent < 0 || usedPercent > 100) return null;
  if (accountTokens === null || accountTokens < 0) return null;
  return { observedAt, usedPercent, accountTokens: Math.round(accountTokens) };
}

function cleanSegment(value) {
  const id = text(value?.id, 120);
  const createdAt = iso(value?.createdAt);
  if (!id || !createdAt) return null;
  const samples = (Array.isArray(value?.samples) ? value.samples : [])
    .map(cleanSample)
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
    .slice(-MAX_SAMPLES_PER_SEGMENT);
  if (samples.length === 0) return null;
  const resetsAt = iso(value?.resetsAt);
  return { id, createdAt, ...(resetsAt ? { resetsAt } : {}), samples };
}

function cleanStream(value) {
  const key = text(value?.key, 200);
  if (!key) return null;
  const segments = (Array.isArray(value?.segments) ? value.segments : [])
    .map(cleanSegment)
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-MAX_SEGMENTS_PER_ACCOUNT);
  if (segments.length === 0) return null;
  const windowMinutes = finite(value?.windowMinutes);
  return {
    key,
    kind: 'weekly',
    ...(windowMinutes !== null && windowMinutes >= 0 ? { windowMinutes: Math.round(windowMinutes) } : {}),
    segments
  };
}

function cleanAccount(value) {
  const accountKey = text(value?.accountKey, 160);
  const attributedTokens = finite(value?.attributedTokens);
  if (!accountKey || attributedTokens === null || attributedTokens < 0) return null;
  const streams = (Array.isArray(value?.streams) ? value.streams : []).map(cleanStream).filter(Boolean);
  return { accountKey, attributedTokens: Math.round(attributedTokens), streams };
}

function normalizeCodexWeeklyCapacityArchive(value, nowMs = Date.now()) {
  const cutoff = Number(nowMs) - RETENTION_MS;
  const normalized = emptyCodexWeeklyCapacityArchive();
  normalized.accounts = (Array.isArray(value?.accounts) ? value.accounts : [])
    .map(cleanAccount)
    .filter(Boolean)
    .map((account) => ({
      ...account,
      streams: account.streams.map((stream) => ({
        ...stream,
        segments: stream.segments
          .map((segment) => ({
            ...segment,
            samples: segment.samples.filter((sample) => Date.parse(sample.observedAt) >= cutoff)
          }))
          .filter((segment) => segment.samples.length > 0)
      })).filter((stream) => stream.segments.length > 0)
    }))
    .slice(-MAX_ACCOUNTS);

  const lastAccountKey = text(value?.lastCapture?.accountKey, 160);
  const globalTokens = finite(value?.lastCapture?.globalTokens);
  const observedAt = iso(value?.lastCapture?.observedAt);
  if (
    lastAccountKey && globalTokens !== null && globalTokens >= 0
    && observedAt && Date.parse(observedAt) >= cutoff
  ) {
    normalized.lastCapture = {
      accountKey: lastAccountKey,
      globalTokens: Math.round(globalTokens),
      observedAt
    };
  }
  return normalized;
}

function codexAllTimeTokens(deviceRecord) {
  const allTime = deviceRecord?.periods?.allTime || deviceRecord?.allTime;
  const tokens = finite(allTime?.clients?.codex);
  return tokens !== null && tokens >= 0 ? Math.round(tokens) : null;
}

function liveCodexProvider(deviceRecord) {
  const providers = (deviceRecord?.limits?.providers || []).filter((provider) => (
    provider?.provider === 'codex'
    && provider?.status === 'ok'
    && text(provider?.accountKey, 160)
    && text(provider?.sourceDetail, 32).toLowerCase() !== 'managed'
  ));
  const byAccount = new Map();
  for (const provider of providers) byAccount.set(text(provider.accountKey, 160), provider);
  return byAccount.size === 1 ? byAccount.values().next().value : null;
}

function primaryWeeklyWindow(provider) {
  const candidates = (provider?.windows || []).filter((window) => (
    window?.kind === 'weekly' && finite(window?.usedPercent) !== null
  ));
  return candidates.sort((left, right) => {
    const leftLabel = text(left?.label).toLowerCase();
    const rightLabel = text(right?.label).toLowerCase();
    const leftPrimary = leftLabel ? 1 : 0;
    const rightPrimary = rightLabel ? 1 : 0;
    if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;
    const leftMinutes = finite(left?.windowMinutes);
    const rightMinutes = finite(right?.windowMinutes);
    return Math.abs((leftMinutes ?? 10080) - 10080) - Math.abs((rightMinutes ?? 10080) - 10080);
  })[0] || null;
}

function weeklyStreamKey(window) {
  const minutes = finite(window?.windowMinutes);
  return `weekly|${minutes === null ? '' : Math.round(minutes)}`;
}

function resetChanged(previous, next) {
  const left = Date.parse(previous || '');
  const right = Date.parse(next || '');
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(right - left) > RESET_JITTER_MS;
}

function resetIdentityMatches(previous, next) {
  const left = iso(previous);
  const right = iso(next);
  if (!left || !right) return left === right;
  return !resetChanged(left, right);
}

function segmentId(accountKey, observedAt, index) {
  let hash = 0x811c9dc5;
  const seed = `${accountKey}|${observedAt}|${index}`;
  for (let offset = 0; offset < seed.length; offset += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(offset), 0x01000193) >>> 0;
  }
  return `segment-${hash.toString(16).padStart(8, '0')}`;
}

function ensureAccount(archive, accountKey) {
  let account = archive.accounts.find((entry) => entry.accountKey === accountKey);
  if (!account) {
    account = { accountKey, attributedTokens: 0, streams: [] };
    archive.accounts.push(account);
    archive.accounts = archive.accounts.slice(-MAX_ACCOUNTS);
  }
  return account;
}

function ensureStream(account, window) {
  const key = weeklyStreamKey(window);
  let stream = account.streams.find((entry) => entry.key === key);
  if (!stream) {
    const minutes = finite(window?.windowMinutes);
    stream = {
      key,
      kind: 'weekly',
      ...(minutes !== null && minutes >= 0 ? { windowMinutes: Math.round(minutes) } : {}),
      segments: []
    };
    account.streams.push(stream);
  }
  return stream;
}

function appendCapacitySample(account, window, observedAt, options = {}) {
  const stream = ensureStream(account, window);
  const usedPercent = Math.max(0, Math.min(100, finite(window.usedPercent)));
  const resetsAt = iso(window.resetsAt);
  let segment = stream.segments.at(-1);
  const previous = segment?.samples?.at(-1);
  if (
    !segment
    || options.forceNewSegment === true
    || (previous && usedPercent + 0.001 < previous.usedPercent)
    || resetChanged(segment.resetsAt, resetsAt)
  ) {
    segment = {
      id: segmentId(account.accountKey, observedAt, stream.segments.length),
      createdAt: observedAt,
      ...(resetsAt ? { resetsAt } : {}),
      samples: []
    };
    stream.segments.push(segment);
    stream.segments = stream.segments.slice(-MAX_SEGMENTS_PER_ACCOUNT);
  } else if (resetsAt && !segment.resetsAt) {
    segment.resetsAt = resetsAt;
  }

  const sample = { observedAt, usedPercent, accountTokens: account.attributedTokens };
  const last = segment.samples.at(-1);
  if (last && Math.abs(last.usedPercent - usedPercent) < 0.001) {
    if (sample.accountTokens >= last.accountTokens) segment.samples[segment.samples.length - 1] = sample;
  } else {
    segment.samples.push(sample);
    segment.samples = segment.samples.slice(-MAX_SAMPLES_PER_SEGMENT);
  }
}

function observeCodexWeeklyCapacity(archiveValue, deviceRecord, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const observedAt = new Date(nowMs).toISOString();
  const archive = normalizeCodexWeeklyCapacityArchive(archiveValue, nowMs);
  const before = JSON.stringify(archive);
  const provider = liveCodexProvider(deviceRecord);
  const globalTokens = codexAllTimeTokens(deviceRecord);
  if (!provider || globalTokens === null) return { archive, changed: before !== JSON.stringify(archive) };

  const accountKey = text(provider.accountKey, 160);
  const account = ensureAccount(archive, accountKey);
  const previous = archive.lastCapture;
  const continuousAttribution = previous?.accountKey === accountKey && globalTokens >= previous.globalTokens;
  if (continuousAttribution) {
    account.attributedTokens += globalTokens - previous.globalTokens;
  }
  archive.lastCapture = { accountKey, globalTokens, observedAt };

  const weekly = primaryWeeklyWindow(provider);
  if (weekly) appendCapacitySample(account, weekly, observedAt, { forceNewSegment: !continuousAttribution });
  const normalized = normalizeCodexWeeklyCapacityArchive(archive, nowMs);
  return { archive: normalized, changed: before !== JSON.stringify(normalized) };
}

function linearFit(samples) {
  const points = samples.map((sample) => ({ x: sample.usedPercent, y: sample.accountTokens }));
  const xMean = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const yMean = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let covariance = 0;
  let xVariance = 0;
  let yVariance = 0;
  for (const point of points) {
    covariance += (point.x - xMean) * (point.y - yMean);
    xVariance += (point.x - xMean) ** 2;
    yVariance += (point.y - yMean) ** 2;
  }
  if (xVariance <= 0) return null;
  const slope = covariance / xVariance;
  const intercept = yMean - slope * xMean;
  const residuals = points.map((point) => point.y - (intercept + slope * point.x));
  const squaredError = residuals.reduce((sum, residual) => sum + residual ** 2, 0);
  const rmse = Math.sqrt(squaredError / points.length);
  const tokenSpan = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
  const rSquared = yVariance > 0 ? Math.max(0, 1 - squaredError / yVariance) : 0;
  return {
    slope,
    rSquared,
    normalizedRmse: tokenSpan > 0 ? rmse / tokenSpan : null
  };
}

function estimateSegment(segment) {
  const samples = segment?.samples || [];
  const first = samples[0];
  const last = samples.at(-1);
  const usedPercentSpan = first && last ? last.usedPercent - first.usedPercent : 0;
  const base = {
    status: 'collecting',
    sampleCount: samples.length,
    usedPercentSpan: Math.max(0, usedPercentSpan),
    resetsAt: segment?.resetsAt || '',
    observedAt: last?.observedAt || ''
  };
  if (samples.length < 2 || usedPercentSpan < MIN_ESTIMATE_PERCENT_SPAN) return base;

  const hasUnattributedIncrease = samples.some((sample, index) => {
    if (index === 0) return false;
    const previous = samples[index - 1];
    return sample.usedPercent > previous.usedPercent && sample.accountTokens <= previous.accountTokens;
  });
  if (hasUnattributedIncrease) return { ...base, status: 'unavailable', reason: 'unattributed-usage' };

  const fit = linearFit(samples);
  if (!fit || !Number.isFinite(fit.slope) || fit.slope <= 0) {
    return { ...base, status: 'unavailable', reason: 'non-positive-slope' };
  }
  const capacityTokens = fit.slope * 100;
  if (!Number.isFinite(capacityTokens) || capacityTokens <= 0) {
    return { ...base, status: 'unavailable', reason: 'invalid-capacity' };
  }
  const stable = samples.length >= 3
    && usedPercentSpan >= MIN_STABLE_PERCENT_SPAN
    && fit.rSquared >= STABLE_R_SQUARED
    && fit.normalizedRmse !== null
    && fit.normalizedRmse <= STABLE_NORMALIZED_RMSE;
  const unstable = samples.length >= 3 && !stable;
  return {
    ...base,
    status: stable ? 'stable' : unstable ? 'unstable' : 'preliminary',
    capacityTokens: Math.round(capacityTokens),
    observedTokens: Math.max(0, last.accountTokens - first.accountTokens),
    rSquared: fit.rSquared,
    normalizedRmse: fit.normalizedRmse
  };
}

function weeklyCapacityEstimateForProvider(archiveValue, provider) {
  const accountKey = text(provider?.accountKey, 160);
  const weekly = primaryWeeklyWindow(provider);
  if (!accountKey || !weekly) return null;
  const archive = normalizeCodexWeeklyCapacityArchive(archiveValue);
  const account = archive.accounts.find((entry) => entry.accountKey === accountKey);
  const stream = account?.streams.find((entry) => entry.key === weeklyStreamKey(weekly));
  const segment = stream?.segments?.at(-1);
  if (!segment) return null;
  const providerReset = iso(weekly.resetsAt);
  if (!resetIdentityMatches(segment.resetsAt, providerReset)) return null;
  const estimate = estimateSegment(segment);
  const previousCycle = estimate.status === 'stable'
    ? [...stream.segments.slice(0, -1)].reverse().find((candidate) => {
        const candidateEstimate = estimateSegment(candidate);
        return segment.resetsAt && candidate.resetsAt
          && resetChanged(segment.resetsAt, candidate.resetsAt)
          && candidateEstimate.status === 'stable';
      })
    : null;
  const previousEstimate = previousCycle ? estimateSegment(previousCycle) : null;
  const comparison = Number.isFinite(estimate.capacityTokens) && Number.isFinite(previousEstimate?.capacityTokens)
    ? {
        previousCapacityTokens: previousEstimate.capacityTokens,
        capacityChangePercent: previousEstimate.capacityTokens > 0
          ? (estimate.capacityTokens - previousEstimate.capacityTokens) / previousEstimate.capacityTokens * 100
          : null
      }
    : {};
  return {
    ...estimate,
    ...comparison,
    method: 'local-linear-estimate',
    scope: 'local-device'
  };
}

function attachCodexWeeklyCapacityEstimates(stats, archiveValue, options = {}) {
  if (!stats || typeof stats !== 'object') return stats;
  const decorateProviders = (providers) => {
    let changed = false;
    const next = (providers || []).map((provider) => {
      if (provider?.provider !== 'codex') return provider;
      const estimate = weeklyCapacityEstimateForProvider(archiveValue, provider);
      if (!estimate) return provider;
      changed = true;
      return { ...provider, weeklyCapacityEstimate: estimate };
    });
    return changed ? next : providers;
  };

  let changed = false;
  let limits = stats.limits;
  if (Array.isArray(limits?.providers)) {
    const providers = decorateProviders(limits.providers);
    if (providers !== limits.providers) {
      limits = { ...limits, providers };
      changed = true;
    }
  }

  let devices = stats.devices;
  if (Array.isArray(devices)) {
    const localDeviceId = text(options.localDeviceId, 160);
    devices = devices.map((device) => {
      const isLocal = localDeviceId
        ? device?.deviceId === localDeviceId
        : devices.length === 1;
      if (!isLocal) return device;
      const providers = decorateProviders(device?.limits?.providers);
      if (providers === device?.limits?.providers) return device;
      changed = true;
      return { ...device, limits: { ...device.limits, providers } };
    });
  }
  if (!changed) return stats;
  const projected = { ...stats };
  if (limits !== stats.limits) projected.limits = limits;
  if (devices !== stats.devices) projected.devices = devices;
  return projected;
}

module.exports = {
  ARCHIVE_VERSION,
  attachCodexWeeklyCapacityEstimates,
  emptyCodexWeeklyCapacityArchive,
  estimateSegment,
  normalizeCodexWeeklyCapacityArchive,
  observeCodexWeeklyCapacity,
  primaryWeeklyWindow,
  weeklyCapacityEstimateForProvider
};
