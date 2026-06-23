'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fetchRates,
  parseUsdRates,
  isCacheStale,
  todayUtc
} = require('../../src/shared/exchangeRates');

function okResponse(json) {
  return { ok: true, status: 200, json: async () => json };
}

const SAMPLE = { date: '2026-06-22', usd: { cny: 6.778, twd: 31.67, hkd: 7.839, jpy: 150 } };

test('parseUsdRates maps known lowercase codes and forces USD=1', () => {
  const rates = parseUsdRates(SAMPLE);
  assert.equal(rates.USD, 1);
  assert.equal(rates.CNY, 6.778);
  assert.equal(rates.TWD, 31.67);
  assert.equal(rates.HKD, 7.839);
  assert.ok(!('JPY' in rates)); // unknown code ignored
});

test('parseUsdRates returns null on missing usd object', () => {
  assert.equal(parseUsdRates({}), null);
  assert.equal(parseUsdRates({ usd: {} }), null); // no usable non-USD rate
});

test('parseUsdRates rejects a partial payload missing supported currencies', () => {
  // Only CNY present — TWD/HKD missing. Must NOT be accepted, otherwise the
  // missing currencies silently fall back to built-in defaults while the cache
  // is marked fresh/"live" for 24h.
  assert.equal(parseUsdRates({ date: '2026-06-22', usd: { cny: 6.778 } }), null);
  assert.equal(parseUsdRates({ usd: { cny: 6.778, twd: 31.67 } }), null); // HKD missing
});

test('fetchRates returns parsed rates from the first working source', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return okResponse(SAMPLE); };
  const result = await fetchRates({ fetchImpl, sources: ['A', 'B'] });
  assert.equal(calls.length, 1);
  assert.equal(result.source, 'A');
  assert.equal(result.date, '2026-06-22');
  assert.equal(result.rates.CNY, 6.778);
});

test('fetchRates falls back to the second source on failure', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'A') return { ok: false, status: 503, json: async () => ({}) };
    return okResponse(SAMPLE);
  };
  const result = await fetchRates({ fetchImpl, sources: ['A', 'B'] });
  assert.deepEqual(calls, ['A', 'B']);
  assert.equal(result.source, 'B');
});

test('fetchRates throws when all sources fail', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  await assert.rejects(fetchRates({ fetchImpl, sources: ['A', 'B'] }));
});

test('isCacheStale: fresh same-day, fresh within 24h, stale otherwise', () => {
  const now = Date.parse('2026-06-22T12:00:00Z');
  assert.equal(isCacheStale({ rates: { CNY: 6.78 }, date: todayUtc(now) }, now), false);
  assert.equal(isCacheStale({ rates: { CNY: 6.78 }, date: '2026-06-21', fetchedAt: now - 3600_000 }, now), false);
  assert.equal(isCacheStale({ rates: { CNY: 6.78 }, date: '2026-06-20', fetchedAt: now - 26 * 3600_000 }, now), true);
  assert.equal(isCacheStale(null, now), true);
  assert.equal(isCacheStale({ date: todayUtc(now) }, now), true); // no rates
});
