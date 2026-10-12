'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  fetchOmniRouteLimits,
  normalizeBaseUrl,
  omnirouteToken,
  parseBudgetWindows
} = require('../../src/shared/providers/omniroute/limits');

const now = Date.parse('2026-10-12T12:00:00Z');

test('OmniRoute token resolves from options and environment variables in order', () => {
  assert.equal(omnirouteToken({}, { omnirouteToken: 'oma_live_opts' }), 'oma_live_opts');
  assert.equal(omnirouteToken({ TOKEN_MONITOR_OMNIROUTE_TOKEN: 'oma_live_env' }, {}), 'oma_live_env');
  assert.equal(omnirouteToken({ OMNIROUTE_TOKEN: 'oma_live_plain' }, {}), 'oma_live_plain');
  assert.equal(omnirouteToken({ OMNIROUTE_API_KEY: 'sk_manage_key' }, {}), 'sk_manage_key');
  assert.equal(omnirouteToken({}, {}), '');
});

test('OmniRoute base URL normalizes paths, allows loopback HTTP, and rejects insecure remote HTTP', () => {
  assert.equal(normalizeBaseUrl(''), 'http://localhost:20128');
  assert.equal(normalizeBaseUrl(null), 'http://localhost:20128');
  assert.equal(normalizeBaseUrl('http://localhost:20128/'), 'http://localhost:20128');
  assert.equal(normalizeBaseUrl('http://localhost:20128/v1/'), 'http://localhost:20128');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:20128/'), 'http://127.0.0.1:20128');
  assert.equal(normalizeBaseUrl('http://[::1]:20128/'), 'http://[::1]:20128');
  assert.equal(normalizeBaseUrl('https://omni.example.com/v1'), 'https://omni.example.com');
  assert.equal(normalizeBaseUrl('https://omni.example.com/'), 'https://omni.example.com');
  assert.equal(normalizeBaseUrl('http://remote-insecure.example.com/'), '');
});

test('parseBudgetWindows handles direct budget and dimensioned quota pools', () => {
  const direct = parseBudgetWindows({
    used: 2.5,
    limit: 10.0,
    remaining: 7.5,
    window: 'month',
    currency: 'USD'
  });
  assert.equal(direct.length, 1);
  assert.equal(direct[0].kind, 'billing');
  assert.equal(direct[0].used, 2.5);
  assert.equal(direct[0].limit, 10.0);
  assert.equal(direct[0].remaining, 7.5);
  assert.equal(direct[0].usedPercent, 25);
  assert.equal(direct[0].remainingPercent, 75);

  const dimensioned = parseBudgetWindows({
    dimensions: [
      { window: '5h', unit: 'tokens', limit: 1000000, consumedTotal: 200000 },
      { window: 'weekly', unit: 'usd', limit: 50, consumedTotal: 10 }
    ]
  });
  assert.equal(dimensioned.length, 2);
  assert.equal(dimensioned[0].kind, 'session');
  assert.equal(dimensioned[0].usedPercent, 20);
  assert.equal(dimensioned[1].kind, 'weekly');
  assert.equal(dimensioned[1].usedPercent, 20);
  assert.equal(dimensioned[1].currency, 'USD');

  assert.deepEqual(parseBudgetWindows(null), []);
  assert.deepEqual(parseBudgetWindows({}), []);

  const missingRemaining = parseBudgetWindows({ limit: 10 });
  assert.equal(missingRemaining.length, 1);
  assert.equal(missingRemaining[0].used, null);
  assert.equal(missingRemaining[0].remaining, null);
  assert.equal(missingRemaining[0].usedPercent, null);
  assert.equal(Number.isNaN(missingRemaining[0].used), false);
});

test('fetchOmniRouteLimits returns notConfigured without credentials', async () => {
  const result = await fetchOmniRouteLimits({}, { env: {}, now: () => now });
  assert.equal(result.status, 'notConfigured');
  assert.deepEqual(result.windows, []);
});

test('fetchOmniRouteLimits fetches /api/usage/budget with Bearer authorization', async () => {
  const requests = [];
  const fetchMock = async (url, options = {}) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      used: 12.0,
      limit: 50.0,
      remaining: 38.0,
      window: 'month',
      currency: 'USD'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await fetchOmniRouteLimits(
    { omnirouteToken: 'oma_live_test_secret', omnirouteBaseUrl: 'https://omni.example.com' },
    { fetch: fetchMock, now: () => now }
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.provider, 'omniroute');
  assert.equal(result.accountLabel, 'OmniRoute');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://omni.example.com/api/usage/budget');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer oma_live_test_secret');
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].usedPercent, 24);
  assert.equal(result.windows[0].remainingPercent, 76);
});

test('fetchOmniRouteLimits falls back to /api/quota/pools when budget route returns 404', async () => {
  const requests = [];
  const fetchMock = async (url) => {
    requests.push(url);
    if (url.includes('/api/usage/budget')) {
      return new Response('Not Found', { status: 404 });
    }
    if (url.includes('/api/quota/pools')) {
      return new Response(JSON.stringify([
        {
          id: 'pool-default',
          name: 'Main Quota Pool',
          limit: 100,
          consumedTotal: 40
        }
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Error', { status: 500 });
  };

  const result = await fetchOmniRouteLimits(
    { omnirouteToken: 'oma_live_test_secret' },
    { fetch: fetchMock, now: () => now }
  );

  assert.equal(result.status, 'ok');
  assert.equal(requests.length, 2);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].label, 'Main Quota Pool');
  assert.equal(result.windows[0].usedPercent, 40);
});

test('fetchOmniRouteLimits handles 401 and 403 authentication rejections cleanly', async () => {
  const fetch401 = async () => new Response('Unauthorized', { status: 401 });
  const unauth = await fetchOmniRouteLimits(
    { omnirouteToken: 'bad_token' },
    { fetch: fetch401, now: () => now }
  );
  assert.equal(unauth.status, 'unauthorized');
  assert.deepEqual(unauth.windows, []);

  const fetch403 = async () => new Response(JSON.stringify({ error: { message: 'Invalid management token' } }), { status: 403 });
  const forbidden = await fetchOmniRouteLimits(
    { omnirouteToken: 'bad_token' },
    { fetch: fetch403, now: () => now }
  );
  assert.equal(forbidden.status, 'unauthorized');
  assert.deepEqual(forbidden.windows, []);
});
