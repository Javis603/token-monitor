'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  KIMI_CODE_USAGES_URL,
  kimiToken,
  parseKimiUsage,
  fetchKimiLimits
} = require('../../src/shared/kimiLimits');

test('kimiToken reads explicit key before the CodexBar-compatible environment key', () => {
  assert.equal(
    kimiToken({ KIMI_CODE_API_KEY: 'env-key' }, '  "explicit-key"  '),
    'explicit-key'
  );
  assert.equal(kimiToken({ KIMI_CODE_API_KEY: 'codexbar-key' }), 'codexbar-key');
  assert.equal(kimiToken({}), '');
});

test('parseKimiUsage accepts snake_case / *Value detail and window field aliases', () => {
  // Real-world APIs in this codebase frequently mix camelCase and snake_case
  // (Qoder's usedValue/limitValue, z.ai's currentValue, etc). Kimi's
  // detail/window field names are unconfirmed, so both entries here use
  // plausible alternate spellings instead of the exact kimi-code.ts names.
  const usage = parseKimiUsage({
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

test('parseKimiUsage derives used% from limit+remaining when used is absent', () => {
  const usage = parseKimiUsage({
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

test('parseKimiUsage reads the limits array under alternate top-level keys', () => {
  const usage = parseKimiUsage({
    rate_limits: [
      { detail: { used: 30, limit: 100 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } },
      { detail: { used: 40, limit: 200 }, window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' } }
    ]
  });

  assert.equal(usage.windows.length, 2);
});

test('parseKimiUsage unwraps a data envelope like Qoder/other vendors use', () => {
  const usage = parseKimiUsage({
    data: {
      limits: [
        { detail: { used: 30, limit: 100 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } },
        { detail: { used: 40, limit: 200 }, window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' } }
      ]
    }
  });

  assert.equal(usage.windows.length, 2);
});

test('parseKimiUsage classifies limits[] windows by duration/timeUnit', () => {
  const usage = parseKimiUsage({
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

test('parseKimiUsage recognizes the real protobuf-style TIME_UNIT_* enum values', () => {
  // The real Kimi Code API reports the 5-hour rolling window as
  // duration=300, timeUnit="TIME_UNIT_MINUTE" (not "HOUR"), and the weekly
  // window as timeUnit="TIME_UNIT_DAY". These must classify correctly instead
  // of falling through to the unparseable-pair fallback.
  const usage = parseKimiUsage({
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

test('parseKimiUsage maps the canonical weekly usage plus 5-hour limit response', () => {
  const usage = parseKimiUsage({
    usage: {
      limit: '2048',
      used: '214',
      remaining: '1834',
      resetTime: '2026-07-14T00:00:00Z'
    },
    limits: [
      {
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: {
          limit: '200',
          used: '139',
          remaining: '61',
          resetTime: '2026-07-08T05:00:00Z'
        }
      }
    ]
  });

  assert.equal(usage.windows.length, 2);
  const session = usage.windows.find((w) => w.kind === 'session');
  const weekly = usage.windows.find((w) => w.kind === 'weekly');
  assert.equal(session.usedPercent, 69.5);
  assert.equal(session.resetsAt, '2026-07-08T05:00:00.000Z');
  assert.equal(weekly.usedPercent, (214 / 2048) * 100);
  assert.equal(weekly.resetsAt, '2026-07-14T00:00:00.000Z');
});

test('parseKimiUsage preserves two compatible-proxy limits when units are unparseable', () => {
  const usage = parseKimiUsage({
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

test('parseKimiUsage orders a colliding pair by window size when both entries parse to the same kind', () => {
  const usage = parseKimiUsage({
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

test('parseKimiUsage falls back to the top-level usage block when no matching kind was seen', () => {
  const usage = parseKimiUsage({
    usage: { used: 50, limit: 100, remaining: 50, name: 'Weekly quota', reset_at: '2026-08-01T00:00:00Z' }
  });

  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].kind, 'weekly');
  assert.equal(usage.windows[0].usedPercent, 50);
  assert.equal(usage.windows[0].label, 'Weekly quota');
  assert.equal(usage.windows[0].resetsAt, '2026-08-01T00:00:00.000Z');
});

test('parseKimiUsage skips the top-level usage block once limits[] already covers its kind', () => {
  const usage = parseKimiUsage({
    limits: [
      { detail: { used: 40, limit: 200, remaining: 160 }, window: { duration: 7, timeUnit: 'DAY' } }
    ],
    usage: { used: 50, limit: 100, remaining: 50, name: 'Weekly quota' }
  });

  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].kind, 'weekly');
  assert.equal(usage.windows[0].usedPercent, 20);
});

test('fetchKimiLimits returns notConfigured without an API key', async () => {
  const provider = await fetchKimiLimits({}, { env: {}, now: () => Date.parse('2026-07-08T00:00:00Z') });
  assert.equal(provider.provider, 'kimi');
  assert.equal(provider.source, 'api');
  assert.equal(provider.status, 'notConfigured');
});

test('fetchKimiLimits requests usages with a bearer token and normalizes windows', async () => {
  const requests = [];
  const provider = await fetchKimiLimits(
    { kimiApiKey: 'kimi-key' },
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
  assert.equal(requests[0].url, KIMI_CODE_USAGES_URL);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer kimi-key');
  assert.equal(provider.provider, 'kimi');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'api');
  assert.ok(provider.accountKey.startsWith('sha256:'));
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].kind, 'session');
});

test('fetchKimiLimits maps 401/403 to unauthorized and 429 to sourceRateLimited', async () => {
  const unauthorized = await fetchKimiLimits(
    { kimiApiKey: 'bad-key' },
    { env: {}, now: () => Date.parse('2026-07-08T00:00:00Z'), fetch: async () => ({ ok: false, status: 401 }) }
  );
  assert.equal(unauthorized.status, 'unauthorized');

  const rateLimited = await fetchKimiLimits(
    { kimiApiKey: 'rate-limited-key' },
    { env: {}, now: () => Date.parse('2026-07-08T00:00:00Z'), fetch: async () => ({ ok: false, status: 429 }) }
  );
  assert.equal(rateLimited.status, 'sourceRateLimited');

  const unavailable = await fetchKimiLimits(
    { kimiApiKey: 'server-error-key' },
    { env: {}, now: () => Date.parse('2026-07-08T00:00:00Z'), fetch: async () => ({ ok: false, status: 500 }) }
  );
  assert.equal(unavailable.status, 'unavailable');
});
