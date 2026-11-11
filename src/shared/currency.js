'use strict';

(function exposeCurrency(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCurrency = api;
})(typeof window !== 'undefined' ? window : null, function createCurrencyApi() {
  // Keep USD first, followed by currency codes in alphabetical order.
  const CURRENCY_RATES = Object.freeze({
    USD: Object.freeze({ code: 'USD', symbol: '$', rate: 1, fractionDigits: 2 }),
    AUD: Object.freeze({ code: 'AUD', symbol: 'A$', rate: 1.44, fractionDigits: 2 }),
    BRL: Object.freeze({ code: 'BRL', symbol: 'R$', rate: 5.51, fractionDigits: 2 }),
    CAD: Object.freeze({ code: 'CAD', symbol: 'CA$', rate: 1.41, fractionDigits: 2 }),
    CHF: Object.freeze({ code: 'CHF', symbol: 'CHF ', rate: 0.82, fractionDigits: 2 }),
    CNY: Object.freeze({ code: 'CNY', symbol: '¥', rate: 6.8, fractionDigits: 2 }),
    EUR: Object.freeze({ code: 'EUR', symbol: '€', rate: 0.89, fractionDigits: 2 }),
    GBP: Object.freeze({ code: 'GBP', symbol: '£', rate: 0.74, fractionDigits: 2 }),
    HKD: Object.freeze({ code: 'HKD', symbol: 'HK$', rate: 7.8, fractionDigits: 2 }),
    INR: Object.freeze({ code: 'INR', symbol: '₹', rate: 93.62, fractionDigits: 2 }),
    JPY: Object.freeze({ code: 'JPY', symbol: 'JP¥', rate: 158, fractionDigits: 0 }),
    KRW: Object.freeze({ code: 'KRW', symbol: '₩', rate: 1380, fractionDigits: 0 }),
    SGD: Object.freeze({ code: 'SGD', symbol: 'S$', rate: 1.28, fractionDigits: 2 }),
    TWD: Object.freeze({ code: 'TWD', symbol: 'NT$', rate: 31.5, fractionDigits: 2 })
  });
  const CURRENCY_CODES = Object.freeze(Object.keys(CURRENCY_RATES));

  function defaultRateMap() {
    const map = {};
    for (const code of CURRENCY_CODES) map[code] = CURRENCY_RATES[code].rate;
    return map;
  }

  // Process-scoped overlay; main and each renderer configure their own copy.
  let activeRates = defaultRateMap();

  function isValidRate(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0;
  }

  function configureRates(map) {
    const next = defaultRateMap();
    if (map && typeof map === 'object') {
      for (const code of CURRENCY_CODES) {
        if (isValidRate(map[code])) next[code] = Number(map[code]);
      }
    }
    activeRates = next;
  }

  // Precedence: override > fetched > built-in floor.
  function resolveEffectiveRates(fetched = {}, overrides = {}) {
    const out = {};
    for (const code of CURRENCY_CODES) {
      if (isValidRate(overrides?.[code])) out[code] = Number(overrides[code]);
      else if (isValidRate(fetched?.[code])) out[code] = Number(fetched[code]);
      else out[code] = CURRENCY_RATES[code].rate;
    }
    return out;
  }

  function normalizeCurrency(value, fallback = 'USD') {
    const code = String(value || '').trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(CURRENCY_RATES, code)) return code;
    const fallbackCode = String(fallback || '').trim().toUpperCase();
    return Object.prototype.hasOwnProperty.call(CURRENCY_RATES, fallbackCode) ? fallbackCode : 'USD';
  }

  function convertUsd(value, currency = 'USD') {
    const amount = Number(value || 0);
    const code = normalizeCurrency(currency);
    return Number((amount * activeRates[code]).toFixed(6));
  }

  function currencyFractionDigits(currency) {
    return CURRENCY_RATES[normalizeCurrency(currency)].fractionDigits;
  }

  function fractionDigitsFor(amount, currency) {
    const code = normalizeCurrency(currency);
    if (CURRENCY_RATES[code].fractionDigits === 0) return 0;
    if (code === 'USD') return Math.abs(amount) >= 10 ? 2 : 4;
    return Math.abs(amount) >= 1 ? 2 : 4;
  }

  function formatCurrencyFromUsd(value, currency = 'USD') {
    const code = normalizeCurrency(currency);
    const amount = convertUsd(value, code);
    const digits = fractionDigitsFor(amount, code);
    return `${CURRENCY_RATES[code].symbol}${amount.toFixed(digits)}`;
  }

  return {
    CURRENCY_CODES,
    CURRENCY_RATES,
    convertUsd,
    formatCurrencyFromUsd,
    currencyFractionDigits,
    normalizeCurrency,
    configureRates,
    resolveEffectiveRates
  };
});
