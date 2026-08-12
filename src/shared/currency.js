'use strict';

(function exposeCurrency(root, factory) {
  const compactTokens = typeof module === 'object' && module.exports
    ? require('./compactTokens')
    : root?.TokenMonitorCompactTokens;
  const api = factory(compactTokens);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCurrency = api;
})(typeof window !== 'undefined' ? window : null, function createCurrencyApi(compactTokens) {
  const CURRENCY_RATES = Object.freeze({
    USD: Object.freeze({ code: 'USD', symbol: '$', rate: 1 }),
    TWD: Object.freeze({ code: 'TWD', symbol: 'NT$', rate: 31.5 }),
    HKD: Object.freeze({ code: 'HKD', symbol: 'HK$', rate: 7.8 }),
    CNY: Object.freeze({ code: 'CNY', symbol: '¥', rate: 6.8 })
  });
  const CURRENCY_CODES = Object.freeze(Object.keys(CURRENCY_RATES));
  const COMPACT_CURRENCY_UNITS = Object.freeze([
    Object.freeze({ divisor: 1e12, suffix: 'T' }),
    Object.freeze({ divisor: 1e9, suffix: 'B' }),
    Object.freeze({ divisor: 1e6, suffix: 'M' }),
    Object.freeze({ divisor: 1e3, suffix: 'K' })
  ]);

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

  function fractionDigitsFor(amount, currency) {
    if (normalizeCurrency(currency) === 'USD') return Math.abs(amount) >= 10 ? 2 : 4;
    return Math.abs(amount) >= 1 ? 2 : 4;
  }

  function normalizeFractionDigits(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(0, Math.min(4, Math.round(number)));
  }

  function compactCurrencyAmount(amount, fractionDigits, options = {}) {
    if (compactTokens?.formatCompactValue) {
      return compactTokens.formatCompactValue(
        amount,
        options.compactTokenUnits,
        options.locale || options.language || 'en',
        { fractionDigits, keepTrailingZeros: true }
      );
    }
    const roundedMagnitude = Math.abs(Number(amount.toFixed(fractionDigits)));
    let unitIndex = COMPACT_CURRENCY_UNITS.findIndex((entry) => roundedMagnitude >= entry.divisor);
    if (unitIndex < 0) return amount.toFixed(fractionDigits);
    let display = (amount / COMPACT_CURRENCY_UNITS[unitIndex].divisor).toFixed(fractionDigits);
    if (Math.abs(Number(display)) >= 1000 && unitIndex > 0) {
      unitIndex -= 1;
      display = (amount / COMPACT_CURRENCY_UNITS[unitIndex].divisor).toFixed(fractionDigits);
    }
    return `${display}${COMPACT_CURRENCY_UNITS[unitIndex].suffix}`;
  }

  function formatCurrencyFromUsd(value, currency = 'USD', options = {}) {
    const code = normalizeCurrency(currency);
    const amount = convertUsd(value, code);
    const displayOptions = options && typeof options === 'object' ? options : {};
    const digits = normalizeFractionDigits(
      displayOptions.fractionDigits,
      fractionDigitsFor(amount, code)
    );
    const number = displayOptions.compact === true
      ? compactCurrencyAmount(amount, digits, displayOptions)
      : amount.toFixed(digits);
    return `${CURRENCY_RATES[code].symbol}${number}`;
  }

  return {
    CURRENCY_CODES,
    CURRENCY_RATES,
    convertUsd,
    formatCurrencyFromUsd,
    normalizeCurrency,
    configureRates,
    resolveEffectiveRates
  };
});
