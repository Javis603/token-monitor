'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_RETRY_AFTER_MS,
  computeRetryDelayMs,
  isRetryableLimitStatus,
  parseRetryAfterHeader
} = require('../../src/shared/limitsRetryPolicy');

test('parseRetryAfterHeader supports delay-seconds and HTTP dates', () => {
  assert.equal(parseRetryAfterHeader('12', 1_000), 12_000);
  assert.equal(
    parseRetryAfterHeader('Wed, 22 Jul 2026 04:00:10 GMT', Date.parse('2026-07-22T04:00:00Z')),
    10_000
  );
  assert.equal(parseRetryAfterHeader('invalid', 1_000), null);
  assert.equal(parseRetryAfterHeader(String((MAX_RETRY_AFTER_MS / 1000) + 60), 1_000), MAX_RETRY_AFTER_MS);
});

test('computeRetryDelayMs applies exponential equal jitter with a maximum', () => {
  assert.equal(computeRetryDelayMs(1, { baseMs: 1_000, maxMs: 4_000, random: () => 0 }), 500);
  assert.equal(computeRetryDelayMs(2, { baseMs: 1_000, maxMs: 4_000, random: () => 0.5 }), 1_500);
  assert.equal(computeRetryDelayMs(9, { baseMs: 1_000, maxMs: 4_000, random: () => 0.999 }), 3_998);
});

test('Retry-After takes precedence and receives only positive bounded jitter', () => {
  assert.equal(computeRetryDelayMs(5, { retryAfterMs: 10_000, random: () => 0 }), 10_000);
  assert.equal(computeRetryDelayMs(1, { retryAfterMs: 10_000, random: () => 0.5 }), 10_500);
  assert.equal(computeRetryDelayMs(1, { retryAfterMs: MAX_RETRY_AFTER_MS * 2, random: () => 0 }), MAX_RETRY_AFTER_MS);
});

test('retryable statuses exclude terminal credential and configuration failures', () => {
  for (const status of ['timeout', 'rateLimited', 'sourceRateLimited', 'unavailable', 'error']) {
    assert.equal(isRetryableLimitStatus(status), true);
  }
  for (const status of ['ok', 'disabled', 'notConfigured', 'unauthorized']) {
    assert.equal(isRetryableLimitStatus(status), false);
  }
});
