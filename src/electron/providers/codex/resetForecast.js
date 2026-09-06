'use strict';

const { appVersion } = require('../../../shared/appVersion');

const CODEX_RESET_FORECAST_PAGE_URL = 'https://codex-resets.com/';
const CODEX_RESET_FORECAST_URL = 'https://codex-resets.com/api/v1/status';
const DEFAULT_CACHE_MS = 15 * 60 * 1000;
const DEFAULT_ERROR_CACHE_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 6 * 1000;
const USER_AGENT = `TokenMonitor/${appVersion()} (+https://github.com/Javis603/token-monitor)`;

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function objectValue(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {};
}

function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) return null;
  const number = typeof value === 'number' ? value : Number(value.trim());
  return Number.isFinite(number) ? number : null;
}

function finitePercent(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

function finiteRatioPercent(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= 1 ? number * 100 : null;
}

function optionalBoolean(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value).trim().toLowerCase();
  if (['true', 'active', 'open', 'yes'].includes(normalized)) return true;
  if (['false', 'inactive', 'closed', 'no'].includes(normalized)) return false;
  return null;
}

function isoDate(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function dateMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function forecastAtTime(forecast, nowMs) {
  if (forecast?.status !== 'active') return forecast;
  const expiresAtMs = dateMs(forecast.expiresAt);
  const expired = expiresAtMs !== null && expiresAtMs <= nowMs;
  return expired ? { ...forecast, status: 'inactive' } : forecast;
}

function cacheDurationForForecast(forecast, nowMs, maximumMs) {
  if (forecast?.status !== 'active') return maximumMs;
  const expiresAtMs = dateMs(forecast.expiresAt);
  if (expiresAtMs === null) return maximumMs;
  return Math.min(maximumMs, Math.max(0, expiresAtMs - nowMs));
}

function normalizeCodexResetForecast(payload, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  const checkedAtMs = Date.parse(checkedAt);
  const nowMs = Number.isFinite(options.nowMs)
    ? Number(options.nowMs)
    : (Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now());
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'unavailable', checkedAt, pageUrl: CODEX_RESET_FORECAST_PAGE_URL };
  }

  const data = objectValue(payload.data, payload);
  const explicitlyNoActiveWatch = [data, payload].some((container) => (
    Object.hasOwn(container, 'activeWatch') && container.activeWatch === null
  ) || (
    Object.hasOwn(container, 'active_watch') && container.active_watch === null
  ));
  const watch = objectValue(
    data.activeWatch,
    data.active_watch,
    data.watch,
    data.resetWatch,
    data.reset_watch,
    data.forecast,
    data.prediction,
    payload.activeWatch,
    payload.active_watch,
    payload.forecast,
    payload.prediction
  );
  const forecast = objectValue(watch.forecast, watch.prediction, watch);
  const source = objectValue(
    watch.source,
    watch.signal,
    watch.sourcePost,
    watch.source_post,
    watch.sourceTweet,
    watch.source_tweet,
    forecast.source,
    data.source
  );
  const explicitlyActive = optionalBoolean(firstDefined(
    watch.active,
    watch.isActive,
    watch.is_active,
    watch.status,
    forecast.active
  ));
  const chancePercent = finitePercent(firstDefined(
    forecast.resetChancePercent,
    forecast.reset_chance_percent,
    forecast.chancePercent,
    forecast.chance_percent,
    forecast.probabilityPercent,
    forecast.probability_percent,
    forecast.percentage
  )) ?? finiteRatioPercent(firstDefined(
    forecast.probability,
    forecast.probability48h,
    forecast.probability_48h,
    forecast.chance,
    forecast.confidence,
    forecast.score,
    data.forecastProbability,
    data.forecast_probability
  ));
  const predictedAt = isoDate(firstDefined(
    forecast.predictedAt,
    forecast.predicted_at,
    forecast.expectedAt,
    forecast.expected_at,
    forecast.targetAt,
    forecast.target_at,
    forecast.predictedFor,
    forecast.predicted_for,
    forecast.expectedResetAt,
    forecast.expected_reset_at,
    forecast.deadline,
    forecast.until,
    forecast.by
  ));
  const expiresAt = isoDate(firstDefined(
    forecast.validUntil,
    forecast.valid_until,
    forecast.expiresAt,
    forecast.expires_at,
    watch.validUntil,
    watch.valid_until,
    watch.expiresAt,
    watch.expires_at
  ));
  const observedAt = isoDate(firstDefined(
    source.observedAt,
    source.observed_at,
    source.createdAt,
    source.created_at,
    source.publishedAt,
    source.published_at,
    source.postedAt,
    source.posted_at,
    source.timestamp,
    watch.observedAt,
    watch.observed_at,
    forecast.observedAt,
    forecast.observed_at
  ));
  const latestReset = firstDefined(
    data.latestReset,
    data.latest_reset,
    data.latestResetAt,
    data.latest_reset_at,
    data.lastReset,
    data.last_reset,
    data.lastResetAt,
    data.last_reset_at,
    payload.latestReset,
    payload.latest_reset,
    payload.lastReset,
    payload.last_reset
  );
  const latestResetRecord = objectValue(latestReset);
  const latestResetAt = isoDate(firstDefined(
    typeof latestReset === 'object' ? undefined : latestReset,
    latestResetRecord.resetAt,
    latestResetRecord.reset_at,
    latestResetRecord.occurredAt,
    latestResetRecord.occurred_at,
    latestResetRecord.announcedAt,
    latestResetRecord.announced_at,
    latestResetRecord.createdAt,
    latestResetRecord.created_at,
    latestResetRecord.timestamp,
    latestResetRecord.date,
    latestResetRecord.at
  ));
  const latestResetTypeValue = String(firstDefined(
    latestResetRecord.resetType,
    latestResetRecord.reset_type
  ) || '').trim().toLowerCase();
  const latestResetType = ['banked', 'regular'].includes(latestResetTypeValue)
    ? latestResetTypeValue
    : '';
  const sourceAuthor = String(firstDefined(
    source.authorHandle,
    source.author_handle,
    typeof source.author === 'string' ? source.author : undefined,
    source.handle,
    source.username
  ) || '').trim().slice(0, 80);
  const hasPrediction = chancePercent !== null || Boolean(predictedAt);
  const recognized = explicitlyNoActiveWatch || explicitlyActive !== null || hasPrediction;
  if (!recognized) {
    return {
      status: 'unavailable',
      observedAt,
      sourceAuthor,
      latestResetAt,
      latestResetType,
      checkedAt,
      pageUrl: CODEX_RESET_FORECAST_PAGE_URL
    };
  }
  const active = explicitlyNoActiveWatch
    ? false
    : (explicitlyActive === null ? hasPrediction : explicitlyActive);

  return forecastAtTime({
    status: active ? 'active' : 'inactive',
    chancePercent,
    predictedAt,
    expiresAt,
    observedAt,
    sourceAuthor,
    latestResetAt,
    latestResetType,
    checkedAt,
    pageUrl: CODEX_RESET_FORECAST_PAGE_URL
  }, nowMs);
}

async function fetchJsonWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const init = {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    credentials: 'omit',
    redirect: 'error'
  };
  if (controller) init.signal = controller.signal;
  try {
    const response = await fetchImpl(url, init);
    if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'}`);
    return await response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createCodexResetForecastClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const endpoint = options.endpoint || CODEX_RESET_FORECAST_URL;
  const cacheMs = Number(options.cacheMs || DEFAULT_CACHE_MS);
  const errorCacheMs = Number(options.errorCacheMs || DEFAULT_ERROR_CACHE_MS);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const now = options.now || Date.now;
  let cache = null;
  let cacheUntil = 0;
  let lastGood = null;

  async function getForecast({ force = false } = {}) {
    const currentTime = Number(now());
    if (!force && cache && currentTime < cacheUntil) return cache;
    try {
      const payload = await fetchJsonWithTimeout(fetchImpl, endpoint, timeoutMs);
      const responseTime = Number(now());
      const checkedAt = new Date(responseTime).toISOString();
      const normalized = normalizeCodexResetForecast(payload, { checkedAt, nowMs: responseTime });
      if (normalized.status === 'unavailable') {
        const error = new Error('Unrecognized forecast response');
        error.code = 'INVALID_RESPONSE';
        throw error;
      }
      const successCacheMs = cacheDurationForForecast(normalized, responseTime, cacheMs);
      cache = { ...normalized, retryAfterMs: successCacheMs };
      lastGood = cache;
      cacheUntil = responseTime + successCacheMs;
    } catch (error) {
      const failureTime = Number(now());
      const checkedAt = new Date(failureTime).toISOString();
      const errorKind = error?.code === 'INVALID_RESPONSE' ? 'invalid-response' : 'request';
      const fallback = forecastAtTime(lastGood, failureTime);
      const retryAfterMs = cacheDurationForForecast(fallback, failureTime, errorCacheMs);
      cache = fallback
        ? { ...fallback, stale: true, checkedAt, error: error.message, errorKind, retryAfterMs }
        : {
            status: 'unavailable',
            checkedAt,
            pageUrl: CODEX_RESET_FORECAST_PAGE_URL,
            error: error.message,
            errorKind,
            retryAfterMs
          };
      cacheUntil = failureTime + retryAfterMs;
    }
    return cache;
  }

  return { getForecast };
}

module.exports = {
  CODEX_RESET_FORECAST_PAGE_URL,
  CODEX_RESET_FORECAST_URL,
  createCodexResetForecastClient,
  normalizeCodexResetForecast
};
