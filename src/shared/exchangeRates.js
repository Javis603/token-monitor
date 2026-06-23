'use strict';

const { CURRENCY_CODES } = require('./currency');

const SOURCES = [
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
  'https://latest.currency-api.pages.dev/v1/currencies/usd.json'
];

function parseUsdRates(json) {
  const usd = json && typeof json === 'object' ? json.usd : null;
  if (!usd || typeof usd !== 'object') return null;
  const rates = {};
  for (const code of CURRENCY_CODES) {
    if (code === 'USD') { rates.USD = 1; continue; }
    const value = Number(usd[code.toLowerCase()]);
    if (Number.isFinite(value) && value > 0) rates[code] = value;
  }
  // Require EVERY supported currency. A partial payload (e.g. only CNY) would
  // otherwise stop the fallback chain and cache as "live" for 24h while the
  // missing currencies silently use built-in defaults — mislabeled in the UI.
  return CURRENCY_CODES.every((code) => Number.isFinite(rates[code]) && rates[code] > 0) ? rates : null;
}

async function fetchRates({ fetchImpl = globalThis.fetch, timeoutMs = 8000, sources = SOURCES } = {}) {
  let lastErr = null;
  for (const url of sources) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no-response'}`);
      const json = await res.json();
      const rates = parseUsdRates(json);
      if (!rates) throw new Error('unexpected payload');
      const date = typeof json.date === 'string' ? json.date : null;
      return { rates, date, source: url };
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('all exchange-rate sources failed');
}

function todayUtc(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function isCacheStale(cache, now = Date.now()) {
  if (!cache || typeof cache !== 'object') return true;
  if (!cache.rates || typeof cache.rates !== 'object') return true;
  if (cache.date && cache.date === todayUtc(now)) return false;
  const fetchedAt = Number(cache.fetchedAt);
  if (Number.isFinite(fetchedAt) && (now - fetchedAt) < 24 * 60 * 60 * 1000) return false;
  return true;
}

module.exports = { fetchRates, parseUsdRates, isCacheStale, todayUtc, SOURCES };
