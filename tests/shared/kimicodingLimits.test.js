'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  KIMICODING_USAGES_URL,
  kimicodingToken,
  parseKimicodingUsage,
  fetchKimicodingLimits
} = require('../../src/shared/kimicodingLimits');

test('kimicodingToken reads explicit key before env, and supports both env aliases', () => {
  assert.equal(
    kimicodingToken({ KIMI_CODING_API_KEY: 'env-key' }, '  "explicit-key"  '),
    'explicit-key'
  );
  assert.equal(kimicodingToken({ KIMI_CODING_API_KEY: '  "env-key"  ' }), 'env-key');
  assert.equal(kimicodingToken({ KIMI_FOR_CODING_API_KEY: 'alias-key' }), 'alias-key');
  assert.equal(kimicodingToken({}), '');
});

test('parseKimicodingUsage accepts snake_case / *Value detail and window field aliases', () => {
  // Real-world APIs in this codebase frequently mix camelCase and snake_case
  // (Qoder's usedValue/limitValue, z.ai's currentValue, etc). Kimi Coding's
  // detail/window field names are unconfirmed, so both entries here use
  // plausible alternate spellings instead of the exact kimi-code.ts names.
  const usage = parseKimicodingUsage({
    limits: [
      { detail: { used_value: 30, limit_value: 100 }, window: { window_duration: 300, time_unit: 'TIME_UNIT_MINUTE' } },
      { detail: { usedAmount: 40, totalValue: 200 }, window: { duration: 7, unit: 'TIME_UNIT_DAY' } }
    ]
  });

  assert.equal(usage.windows.length, 2);
  const session = usage.windows.find((w) => w.kind === 'session');
  const weekly = usage.windows.find((w) => w.kind === 'weekly');
  assert.ok(session);
  assert.equal(session.usedPercent, 30);
  assert.equal(session.windowMinutes, 300);
  assert.ok(weekly);
  assert.equal(weekly.usedPercent, 20);
});

test('parseKimicodingUsage derives used% from limit+remaining when used is absent', () => {
  const usage = parseKimicodingUsage({
    limits: [
      { detail: { limit: 100, remaining: 70 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } },
      { detail: { limit: 200, remaining: 160 }, window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' } }
    ]
  });

  assert.equal(usage.windows.length, 2);
  const session = usage.windows.find((w) => w.kind === 'session');
  const weekly = usage.windows.find((w) => w.kind === 'weekly');
  assert.equal(session.usedPercent, 30);
  assert.equal(weekly.usedPercent, 20);
});

test('parseKimicodingUsage reads the limits array under alternate top-level keys', () => {
  const usage = parseKimicodingUsage({
    rate_limits: [
      { detail: { used: 30, limit: 100 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } },
      { detail: { used: 40, limit: 200 }, window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' } }
    ]
  });

  assert.equal(usage.windows.length, 2);
});

test('parseKimicodingUsage unwraps a data envelope like Qoder/other vendors use', () => {
  const usage = parseKimicodingUsage({
    data: {
      limits: [
        { detail: { used: 30, limit: 100 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } },
        { detail: { used: 40, limit: 200 }, window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' } }
      ]
    }
  });

  assert.equal(usage.windows.length, 2);
});

test('parseKimicodingUsage classifies limits[] windows by duration/timeUnit', () => {
  const usage = parseKimicodingUsage({
    limits: [
      { detail: { used: 10, limit: 100, remaining: 90 }, window: { duration: 5, timeUnit: 'HOUR' } },
      { detail: { used: 40, limit: 200, remaining: 160 }, window: { duration: 7, timeUnit: 'DAY' } }
    ]
  });

  assert.equal(usage.windows.length, 2);
  const session = usage.windows.find((w) => w.kind === 'session');
  const weekly = usage.windows.find((w) => w.kind === 'weekly');
  assert.ok(session);
  assert.equal(session.usedPercent, 10);
  assert.ok(weekly);
  assert.equal(weekly.usedPercent, 20);
});

test('parseKimicodingUsage recognizes the real protobuf-style TIME_UNIT_* enum values', () => {
  // The real Kimi Coding Plan API reports the 5-hour rolling window as
  // duration=300, timeUnit="TIME_UNIT_MINUTE" (not "HOUR"), and the weekly
  // window as timeUnit="TIME_UNIT_DAY". These must classify correctly instead
  // of falling through to the unparseable-pair fallback.
  const usage = parseKimicodingUsage({
    limits: [
      { detail: { used: 30, limit: 100, remaining: 70 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } },
      { detail: { used: 40, limit: 200, remaining: 160 }, window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' } }
    ]
  });

  assert.equal(usage.windows.length, 2);
  const session = usage.windows.find((w) => w.kind === 'session');
  const weekly = usage.windows.find((w) => w.kind === 'weekly');
  assert.ok(session);
  assert.equal(session.usedPercent, 30);
  assert.equal(session.windowMinutes, 300);
  assert.ok(weekly);
  assert.equal(weekly.usedPercent, 20);
});

test('parseKimicodingUsage always emits a distinct session and weekly window from exactly two limits[] entries, even when duration/timeUnit is unparseable', () => {
  // Kimi Coding Plan always reports exactly these two windows. If window shape
  // parsing fails and both entries would otherwise collide on the same kind,
  // the smaller window (by used%-independent size) must still win "session".
  const usage = parseKimicodingUsage({
    limits: [
      { detail: { used: 10, limit: 100, remaining: 90 }, window: { duration: 5, timeUnit: 'UNKNOWN_UNIT' } },
      { detail: { used: 40, limit: 200, remaining: 160 }, window: { duration: 7, timeUnit: 'UNKNOWN_UNIT' } }
    ]
  });

  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].kind, 'session');
  assert.equal(usage.windows[0].usedPercent, 10);
  assert.equal(usage.windows[1].kind, 'weekly');
  assert.equal(usage.windows[1].usedPercent, 20);
});

test('parseKimicodingUsage orders a colliding pair by window size when both entries parse to the same kind', () => {
  const usage = parseKimicodingUsage({
    limits: [
      // Both would classify as "session" under the raw per-entry rule (durations
      // well under the 6-hour cutoff), but as a pair they must still resolve to
      // one session + one weekly window rather than losing one entirely.
      { detail: { used: 40, limit: 200, remaining: 160 }, window: { duration: 4, timeUnit: 'HOUR' } },
      { detail: { used: 10, limit: 100, remaining: 90 }, window: { duration: 2, timeUnit: 'HOUR' } }
    ]
  });

  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].kind, 'session');
  assert.equal(usage.windows[0].usedPercent, 10);
  assert.equal(usage.windows[1].kind, 'weekly');
  assert.equal(usage.windows[1].usedPercent, 20);
});

test('parseKimicodingUsage falls back to the top-level usage block when no matching kind was seen', () => {
  const usage = parseKimicodingUsage({
    usage: { used: 50, limit: 100, remaining: 50, name: 'Weekly quota', reset_at: '2026-08-01T00:00:00Z' }
  });

  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].kind, 'weekly');
  assert.equal(usage.windows[0].usedPercent, 50);
  assert.equal(usage.windows[0].label, 'Weekly quota');
  assert.equal(usage.windows[0].resetsAt, '2026-08-01T00:00:00.000Z');
});

test('parseKimicodingUsage skips the top-level usage block once limits[] already covers its kind', () => {
  const usage = parseKimicodingUsage({
    limits: [
      { detail: { used: 40, limit: 200, remaining: 160 }, window: { duration: 7, timeUnit: 'DAY' } }
    ],
    usage: { used: 50, limit: 100, remaining: 50, name: 'Weekly quota' }
  });

  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].kind, 'weekly');
  assert.equal(usage.windows[0].usedPercent, 20);
});

test('fetchKimicodingLimits returns notConfigured without an API key', async () => {
  const provider = await fetchKimicodingLimits({}, { env: {}, now: () => Date.parse('2026-07-08T00:00:00Z') });
  assert.equal(provider.provider, 'kimicoding');
  assert.equal(provider.source, 'api');
  assert.equal(provider.status, 'notConfigured');
});

test('fetchKimicodingLimits requests usages with a bearer token and normalizes windows', async () => {
  const requests = [];
  const provider = await fetchKimicodingLimits(
    { kimicodingApiKey: 'kimi-key' },
    {
      env: {},
      now: () => Date.parse('2026-07-08T00:00:00Z'),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            limits: [
              { detail: { used: 10, limit: 100, remaining: 90 }, window: { duration: 5, timeUnit: 'HOUR' } }
            ]
          })
        };
      }
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, KIMICODING_USAGES_URL);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer kimi-key');
  assert.equal(provider.provider, 'kimicoding');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'api');
  assert.ok(provider.accountKey.startsWith('sha256:'));
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].kind, 'session');
});

test('fetchKimicodingLimits maps 401/403 to unauthorized and 429 to sourceRateLimited', async () => {
  const unauthorized = await fetchKimicodingLimits(
    { kimicodingApiKey: 'bad-key' },
    { env: {}, now: () => Date.parse('2026-07-08T00:00:00Z'), fetch: async () => ({ ok: false, status: 401 }) }
  );
  assert.equal(unauthorized.status, 'unauthorized');

  const rateLimited = await fetchKimicodingLimits(
    { kimicodingApiKey: 'rate-limited-key' },
    { env: {}, now: () => Date.parse('2026-07-08T00:00:00Z'), fetch: async () => ({ ok: false, status: 429 }) }
  );
  assert.equal(rateLimited.status, 'sourceRateLimited');

  const unavailable = await fetchKimicodingLimits(
    { kimicodingApiKey: 'server-error-key' },
    { env: {}, now: () => Date.parse('2026-07-08T00:00:00Z'), fetch: async () => ({ ok: false, status: 500 }) }
  );
  assert.equal(unavailable.status, 'unavailable');
});
