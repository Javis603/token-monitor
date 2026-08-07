'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hashKey } = require('../../src/shared/hashKey');
const { BROWSER_USER_AGENT } = require('../../src/shared/browserUserAgent');

const {
  KIMI_CODE_USAGES_URL,
  KIMI_MEMBERSHIP_STATS_URL,
  KIMI_WEB_USAGES_URL,
  kimiToken,
  kimiWebToken,
  parseKimiUsage,
  parseKimiMembershipStats,
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

test('kimiWebToken accepts an access token or kimi-auth cookie without retaining unrelated cookies', () => {
  assert.equal(kimiWebToken({}, 'Bearer web-token'), 'web-token');
  assert.equal(kimiWebToken({}, 'Cookie: other=x; kimi-auth=jwt.token.value; theme=dark'), 'jwt.token.value');
  assert.equal(kimiWebToken({ KIMI_AUTH_TOKEN: 'env-token' }), 'env-token');
  assert.equal(kimiWebToken({}, 'Cookie: other=x'), '');
});

test('parseKimiMembershipStats returns 5-hour, weekly, and one shared monthly window', () => {
  const usage = parseKimiMembershipStats({
    ratelimitCode5h: { ratio: 0.25, enabled: true, resetTime: '2026-07-19T05:00:00Z' },
    ratelimitCode7d: { ratio: 0.4, enabled: true, resetTime: '2026-07-24T00:00:00Z' },
    subscriptionBalance: {
      feature: 'FEATURE_OMNI',
      type: 'SUBSCRIPTION',
      amountUsedRatio: 0.1612,
      kimiCodeUsedRatio: 0.05,
      expireTime: '2026-08-01T00:00:00Z'
    }
  });

  assert.deepEqual(usage.windows.map((window) => window.kind), ['session', 'weekly', 'billing']);
  assert.equal(usage.windows[0].usedPercent, 25);
  assert.equal(usage.windows[1].usedPercent, 40);
  assert.equal(usage.windows[2].usedPercent, 16.12);
  assert.equal(usage.windows[2].detail, 'Kimi 11.12% · Code 5%');
});

test('parseKimiMembershipStats treats a ratio above 1 as an exhausted window', () => {
  // These fields are ratios, so anything past 1 is over-consumption. Reading an
  // out-of-range value as an already-scaled percentage flipped a spent quota
  // into a nearly full one (the MiMo shape of #292).
  const usage = parseKimiMembershipStats({
    ratelimitCode5h: { ratio: 1.02, enabled: true },
    subscriptionBalance: {
      feature: 'FEATURE_OMNI',
      type: 'SUBSCRIPTION',
      amountUsedRatio: 1.5,
      kimiCodeUsedRatio: 1.2
    }
  });

  assert.deepEqual(usage.windows.map((window) => window.usedPercent), [100, 100]);
  assert.deepEqual(usage.windows.map((window) => window.remainingPercent), [0, 0]);
  // Only the meter saturates. The breakdown keeps both real shares, so the
  // Kimi side isn't erased and Code isn't credited with a spend it never made.
  assert.equal(usage.windows[1].detail, 'Kimi 30% · Code 120%');
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

test('parseKimiUsage prefers the top-level usage detail over a limits[] window of the same kind', () => {
  // The FEATURE_CODING detail on top-level `usage` is the authoritative weekly
  // quota (the number the console shows). A compatible proxy that also reports
  // a 7-day window in limits[] must not displace it — the same precedence rule
  // fixed for the membership merge in #343, applied inside the parser.
  const usage = parseKimiUsage({
    limits: [
      { detail: { used: 40, limit: 200, remaining: 160 }, window: { duration: 7, timeUnit: 'DAY' } }
    ],
    usage: { used: 50, limit: 100, remaining: 50, name: 'Weekly quota' }
  });

  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].kind, 'weekly');
  assert.equal(usage.windows[0].usedPercent, 50);
});

test('parseKimiUsage keeps the top-level detail for weekly when limits[] carries 5h and 7d windows', () => {
  // A compatible proxy may flatten two quota windows into limits[] (a 5-hour
  // rate limit plus a 7-day window) while top-level `usage` still carries the
  // FEATURE_CODING detail. The detail must win the weekly slot and the 7-day
  // limit must be dropped, mirroring CodexBar's usage.detail-as-weekly source.
  const usage = parseKimiUsage({
    usage: { used: 214, limit: 2048, remaining: 1834, name: 'Weekly quota' },
    limits: [
      { detail: { used: 20, limit: 60, remaining: 40 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } },
      { detail: { used: 40, limit: 200, remaining: 160 }, window: { duration: 7, timeUnit: 'DAY' } }
    ]
  });

  assert.equal(usage.windows.length, 2);
  const session = usage.windows.find((w) => w.kind === 'session');
  const weekly = usage.windows.find((w) => w.kind === 'weekly');
  assert.equal(session.usedPercent, (20 / 60) * 100);
  assert.equal(weekly.usedPercent, (214 / 2048) * 100);
  assert.equal(weekly.windowMinutes, 7 * 24 * 60);
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

test('fetchKimiLimits prefers web membership windows when a web token is configured', async () => {
  const requests = [];
  const provider = await fetchKimiLimits(
    { kimiWebAccessToken: 'web-token', kimiApiKey: 'code-key' },
    {
      env: {},
      now: () => Date.parse('2026-07-19T00:00:00Z'),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url) === KIMI_MEMBERSHIP_STATS_URL) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ratelimit_code_5h: { ratio: 0.1, reset_time: '2026-07-19T05:00:00Z' },
              ratelimit_code_7d: { ratio: 0.2, reset_time: '2026-07-24T00:00:00Z' },
              subscription_balance: {
                amount_used_ratio: 0.3,
                kimi_code_used_ratio: 0.12,
                expire_time: '2026-08-01T00:00:00Z'
              }
            })
          };
        }
        assert.equal(String(url), KIMI_WEB_USAGES_URL);
        return { ok: true, status: 200, json: async () => ({ usages: [] }) };
      }
    }
  );

  assert.equal(requests.length, 2);
  assert.equal(requests.some((request) => request.url === KIMI_CODE_USAGES_URL), false);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer web-token');
  assert.equal(requests[0].init.headers.Cookie, 'kimi-auth=web-token');
  // Both web endpoints share the browser-presenting headers (the console
  // rejects undici's default `node` agent); assert on both requests so a future
  // per-endpoint header divergence is caught, not just the first call.
  for (const request of requests) {
    assert.equal(request.init.headers['User-Agent'], BROWSER_USER_AGENT);
    assert.equal(request.init.headers['r-timezone'], Intl.DateTimeFormat().resolvedOptions().timeZone);
  }
  assert.equal(provider.source, 'web');
  assert.equal(provider.status, 'ok');
  assert.deepEqual(provider.windows.map((window) => window.kind), ['session', 'weekly', 'billing']);
});

test('fetchKimiLimits fills missing web 5-hour and weekly windows from the Code API', async () => {
  const requests = [];
  const provider = await fetchKimiLimits(
    { kimiWebAccessToken: 'web-token', kimiApiKey: 'code-key' },
    {
      env: {},
      now: () => Date.parse('2026-07-19T00:00:00Z'),
      fetch: async (url) => {
        requests.push(String(url));
        if (String(url) === KIMI_MEMBERSHIP_STATS_URL) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              subscriptionBalance: {
                amountUsedRatio: 0.4,
                kimiCodeUsedRatio: 0.1,
                expireTime: '2026-08-01T00:00:00Z'
              }
            })
          };
        }
        if (String(url) === KIMI_WEB_USAGES_URL) return { ok: false, status: 503 };
        assert.equal(String(url), KIMI_CODE_USAGES_URL);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            usage: { used: 20, limit: 100 },
            limits: [{ detail: { used: 5, limit: 50 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } }]
          })
        };
      }
    }
  );

  assert.deepEqual(requests, [KIMI_MEMBERSHIP_STATS_URL, KIMI_WEB_USAGES_URL, KIMI_CODE_USAGES_URL]);
  assert.equal(provider.source, 'web');
  assert.deepEqual(provider.windows.map((window) => window.kind), ['session', 'weekly', 'billing']);
  assert.equal(provider.windows.find((window) => window.kind === 'billing').usedPercent, 40);
});

test('fetchKimiLimits keeps web 5-hour and weekly windows when monthly enrichment fails', async () => {
  const provider = await fetchKimiLimits(
    { kimiWebAccessToken: 'web-token' },
    {
      env: {},
      now: () => Date.parse('2026-07-19T00:00:00Z'),
      fetch: async (url) => {
        if (String(url) === KIMI_MEMBERSHIP_STATS_URL) return { ok: false, status: 503 };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            usages: [{
              scope: 'FEATURE_CODING',
              detail: { used: 20, limit: 100 },
              limits: [{ detail: { used: 5, limit: 50 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } }]
            }]
          })
        };
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.deepEqual(provider.windows.map((window) => window.kind), ['session', 'weekly']);
});

test('fetchKimiLimits uses the GetUsages detail for weekly, not the membership 7-day ratio', async () => {
  // Canonical shapes: GetUsages carries the FEATURE_CODING weekly used/limit
  // (the number the Kimi console shows) plus the 5-hour limit, while the
  // membership stats carry only the shared monthly pool and a Code 7-day ratio.
  // The weekly slot must come from the GetUsages detail — regression for #343,
  // where merging membership first let ratelimitCode7d overwrite it.
  const provider = await fetchKimiLimits(
    { kimiWebAccessToken: 'web-token' },
    {
      env: {},
      now: () => Date.parse('2026-07-19T00:00:00Z'),
      fetch: async (url) => {
        if (String(url) === KIMI_MEMBERSHIP_STATS_URL) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              subscriptionBalance: { feature: 'FEATURE_OMNI', type: 'SUBSCRIPTION', amountUsedRatio: 0.25 },
              ratelimitCode7d: { ratio: 0.48, enabled: true }
            })
          };
        }
        assert.equal(String(url), KIMI_WEB_USAGES_URL);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            usages: [{
              scope: 'FEATURE_CODING',
              detail: { used: 214, limit: 2048 },
              limits: [{ detail: { used: 20, limit: 60 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } }]
            }]
          })
        };
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.deepEqual(provider.windows.map((window) => window.kind), ['session', 'weekly', 'billing']);
  const weekly = provider.windows.find((window) => window.kind === 'weekly');
  assert.ok(weekly);
  assert.equal(weekly.usedPercent, (214 / 2048) * 100);
  assert.equal(weekly.windowMinutes, 7 * 24 * 60);
  const session = provider.windows.find((window) => window.kind === 'session');
  assert.equal(session.usedPercent, (20 / 60) * 100);
  assert.equal(provider.windows.find((window) => window.kind === 'billing').usedPercent, 25);
});

test('fetchKimiLimits falls back to the membership 7-day ratio when GetUsages lacks a weekly detail', async () => {
  // When the FEATURE_CODING detail carries no usable used/limit, the merged
  // weekly slot fills from ratelimitCode7d instead of disappearing.
  const provider = await fetchKimiLimits(
    { kimiWebAccessToken: 'web-token' },
    {
      env: {},
      now: () => Date.parse('2026-07-19T00:00:00Z'),
      fetch: async (url) => {
        if (String(url) === KIMI_MEMBERSHIP_STATS_URL) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              subscriptionBalance: { feature: 'FEATURE_OMNI', type: 'SUBSCRIPTION', amountUsedRatio: 0.25 },
              ratelimitCode7d: { ratio: 0.48, enabled: true }
            })
          };
        }
        assert.equal(String(url), KIMI_WEB_USAGES_URL);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            usages: [{
              scope: 'FEATURE_CODING',
              detail: { limit: 2048 },
              limits: [{ detail: { used: 20, limit: 60 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } }]
            }]
          })
        };
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.windows.find((window) => window.kind === 'weekly').usedPercent, 48);
});

test('fetchKimiLimits bounds monthly enrichment without delaying web usage windows', async () => {
  let membershipSignal = null;
  const startedAt = Date.now();
  const provider = await fetchKimiLimits(
    { kimiWebAccessToken: 'web-token' },
    {
      env: {},
      kimiMembershipGraceMs: 10,
      now: () => Date.parse('2026-07-19T00:00:00Z'),
      fetch: async (url, init) => {
        if (String(url) === KIMI_MEMBERSHIP_STATS_URL) {
          membershipSignal = init.signal;
          // Deliberately ignore cancellation to prove the total grace budget,
          // rather than transport cooperation, bounds this enrichment.
          return new Promise(() => {});
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            usages: [{
              scope: 'FEATURE_CODING',
              detail: { used: 20, limit: 100 },
              limits: [{ detail: { used: 5, limit: 50 }, window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } }]
            }]
          })
        };
      }
    }
  );

  assert.ok(Date.now() - startedAt < 250);
  assert.equal(membershipSignal?.aborted, true);
  assert.equal(provider.status, 'ok');
  assert.deepEqual(provider.windows.map((window) => window.kind), ['session', 'weekly']);
});

test('fetchKimiLimits keeps the web account identity during a Code API-only fallback tick', async () => {
  const provider = await fetchKimiLimits(
    { kimiWebAccessToken: 'web-token', kimiApiKey: 'code-key' },
    {
      env: {},
      now: () => Date.parse('2026-07-19T00:00:00Z'),
      fetch: async (url) => {
        if (String(url) !== KIMI_CODE_USAGES_URL) return { ok: false, status: 503 };
        return {
          ok: true,
          status: 200,
          json: async () => ({ usage: { used: 20, limit: 100 } })
        };
      }
    }
  );

  assert.equal(provider.source, 'api');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountKey, hashKey('kimi', 'web-token'));
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

test('fetchKimiLimits physically aborts a hung request within its configured bound', async () => {
  let signal;
  const provider = await fetchKimiLimits(
    { kimiApiKey: 'hung-key' },
    {
      env: {},
      kimiFetchTimeoutMs: 5,
      fetch: async (_url, init) => {
        signal = init.signal;
        return new Promise(() => {});
      }
    }
  );

  assert.equal(provider.status, 'unavailable');
  assert.equal(signal.aborted, true);
});
