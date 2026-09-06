'use strict';

const DEFAULT_LIMITS_RETRY_BASE_MS = 5_000;
const DEFAULT_LIMITS_RETRY_MAX_MS = 5 * 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const RETRY_AFTER_JITTER_MAX_MS = 5_000;

const RETRYABLE_LIMIT_STATUSES = new Set([
  'timeout',
  'rateLimited',
  'sourceRateLimited',
  'unavailable',
  'error'
]);

function positiveFinite(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function unitRandom(random = Math.random) {
  const value = Number(random());
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(0.999999999, value));
}

function parseRetryAfterHeader(value, nowMs = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Number(raw) * 1000));
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Number(nowMs || 0)));
}

function computeRetryDelayMs(attempt, options = {}) {
  const random = options.random || Math.random;
  const retryAfterMs = Number(options.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    const bounded = Math.min(MAX_RETRY_AFTER_MS, retryAfterMs);
    const jitterCap = Math.min(RETRY_AFTER_JITTER_MAX_MS, bounded * 0.1);
    return Math.ceil(bounded + unitRandom(random) * jitterCap);
  }

  const baseMs = positiveFinite(options.baseMs, DEFAULT_LIMITS_RETRY_BASE_MS);
  const maxMs = positiveFinite(options.maxMs, DEFAULT_LIMITS_RETRY_MAX_MS);
  const exponent = Math.max(0, Math.min(30, Math.floor(Number(attempt) || 1) - 1));
  const cap = Math.min(maxMs, baseMs * (2 ** exponent));
  return Math.ceil((cap / 2) + unitRandom(random) * (cap / 2));
}

function isRetryableLimitStatus(status) {
  return RETRYABLE_LIMIT_STATUSES.has(String(status || ''));
}

module.exports = {
  DEFAULT_LIMITS_RETRY_BASE_MS,
  DEFAULT_LIMITS_RETRY_MAX_MS,
  MAX_RETRY_AFTER_MS,
  RETRYABLE_LIMIT_STATUSES,
  computeRetryDelayMs,
  isRetryableLimitStatus,
  parseRetryAfterHeader
};
