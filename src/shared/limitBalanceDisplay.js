'use strict';

(function exposeLimitBalanceDisplay(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitBalanceDisplay = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLimitBalanceDisplayApi() {
  const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' };

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, value));
  }

  function normalizeCurrencyCode(value) {
    const code = String(value || '').trim().toUpperCase();
    return /^[A-Z]{3,8}$/.test(code) ? code : 'USD';
  }

  // The wire-level marker for "this window's headline value is money, not a
  // percentage". Set by the OpenRouter, third-party, DeepSeek and MiMo
  // collectors; every renderer keys off it instead of a provider whitelist.
  function isCreditsWindow(window) {
    return window?.metric === 'credits';
  }

  // The spend meter: money already consumed, the mirror of a `credits` window.
  // A hub older than the `spend` metric drops it during normalization while
  // keeping the window itself, so a metric-less billing window carrying the
  // canonical label is the same thing arriving through one of those. Without
  // the fallback the row vanishes on new widget → old hub → new renderer.
  // Removable once no supported hub predates the metric.
  function spendWindow(provider) {
    const windows = Array.isArray(provider?.windows) ? provider.windows : [];
    return windows.find((window) => window?.metric === 'spend')
      || windows.find((window) => !window?.metric
        && window?.kind === 'billing'
        && window?.label === 'Usage credits')
      || null;
  }

  function creditsAmount(provider, window) {
    const fromWindow = finiteNumber(window?.remaining);
    return fromWindow === null ? finiteNumber(provider?.balance?.amount) : fromWindow;
  }

  function creditsCurrency(provider, window) {
    const fromWindow = String(window?.currency || '').trim();
    if (fromWindow) return normalizeCurrencyCode(fromWindow);
    return normalizeCurrencyCode(provider?.balance?.currency);
  }

  // Top-up balances have no fixed quota denominator. When the provider reports
  // a real percentage (third-party and OpenRouter derive one from an explicit
  // total) use it; otherwise visualize the balance against this month's
  // inferred starting funds: current / (current + observed month spend).
  // Display-only — this number is deliberately never written to the wire.
  function creditsMeterPercent(provider, window) {
    const used = finiteNumber(window?.usedPercent);
    if (used !== null) return clampPercent(100 - used);
    const remaining = finiteNumber(window?.remainingPercent);
    if (remaining !== null) return clampPercent(remaining);
    const amount = creditsAmount(provider, window);
    if (amount === null) return null;
    const funds = Math.max(0, amount);
    // No money left is 0% remaining, even before any spend has been observed.
    // Falling back to "full" here would paint a freshly tracked exhausted
    // account as healthy on Home and in the tray.
    if (funds === 0) return 0;
    const spend = Math.max(0, finiteNumber(provider?.balance?.monthSpend) ?? 0);
    // An untouched positive balance has no observed spend, so it reads as full.
    return clampPercent((funds / (funds + spend)) * 100);
  }

  function formatMoney(value, currency) {
    const number = finiteNumber(value);
    if (number === null) return '';
    const code = normalizeCurrencyCode(currency);
    const symbol = CURRENCY_SYMBOLS[code];
    return symbol ? `${symbol}${number.toFixed(2)}` : `${code} ${number.toFixed(2)}`;
  }

  function formatCompactMoney(value, currency) {
    const number = finiteNumber(value);
    if (number === null) return '';
    if (Math.abs(number) < 100_000) return formatMoney(number, currency);
    const code = normalizeCurrencyCode(currency);
    const prefix = CURRENCY_SYMBOLS[code] || `${code} `;
    return `${prefix}${new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 2
    }).format(number)}`;
  }

  return {
    creditsAmount,
    creditsCurrency,
    creditsMeterPercent,
    formatCompactMoney,
    formatMoney,
    isCreditsWindow,
    spendWindow
  };
});
