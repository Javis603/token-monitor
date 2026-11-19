'use strict';

(function exposeCompactMoney(root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./currency') : root?.TokenMonitorCurrency,
    typeof module === 'object' && module.exports ? require('./compactTokens') : root?.TokenMonitorCompactTokens
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCompactMoney = api;
})(typeof window !== 'undefined' ? window : null, function createCompactMoneyApi(currencyApi, compactTokenApi) {
  function normalizeFractionDigits(value) {
    if (value === null || value === undefined || value === '' || value === 'auto') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(4, Math.round(number))) : null;
  }

  function formatCompactCurrencyFromUsd(
    value,
    currency = 'USD',
    unitSystem = 'western',
    locale = 'en',
    options = {}
  ) {
    const code = currencyApi.normalizeCurrency(currency);
    const amount = Number(currencyApi.convertUsd(value, code));
    const threshold = compactTokenApi.compactTokenUnitThreshold(unitSystem, locale);
    const fractionDigits = normalizeFractionDigits(options.fractionDigits);
    const symbol = currencyApi.CURRENCY_RATES[code]?.symbol || `${code} `;

    if (options.compact === false) {
      return fractionDigits === null
        ? currencyApi.formatCurrencyFromUsd(value, code)
        : `${symbol}${amount.toFixed(fractionDigits)}`;
    }

    // Keep the currency formatter's precision for values that do not need a
    // unit. This matters for small costs such as $0.1250, which would become
    // an incorrect bare "$0" if they went through the token formatter.
    if (!Number.isFinite(amount) || Math.abs(amount) < threshold) {
      return fractionDigits === null
        ? currencyApi.formatCurrencyFromUsd(value, code)
        : `${symbol}${amount.toFixed(fractionDigits)}`;
    }

    return `${symbol}${compactTokenApi.formatCompactValue(amount, unitSystem, locale, {
      fractionDigits,
      keepTrailingZeros: fractionDigits !== null || options.keepTrailingZeros === true
    })}`;
  }

  return { formatCompactCurrencyFromUsd };
});
