'use strict';

(function exposeCompactMoney(root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./currency') : root?.TokenMonitorCurrency,
    typeof module === 'object' && module.exports ? require('./compactTokens') : root?.TokenMonitorCompactTokens
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCompactMoney = api;
})(typeof window !== 'undefined' ? window : null, function createCompactMoneyApi(currencyApi, compactTokenApi) {
  function formatCompactCurrencyFromUsd(value, currency = 'USD', unitSystem = 'western', locale = 'en') {
    const code = currencyApi.normalizeCurrency(currency);
    const amount = currencyApi.convertUsd(value, code);
    const rounded = Math.round(Number(amount || 0));
    const threshold = compactTokenApi.compactTokenUnitThreshold(unitSystem, locale);

    // Keep the currency formatter's precision for values that do not need a
    // unit. This matters for small costs such as $0.1250, which would become
    // an incorrect bare "$0" if they went through the token formatter.
    if (!Number.isFinite(rounded) || Math.abs(rounded) < threshold) {
      return currencyApi.formatCurrencyFromUsd(value, code);
    }

    const symbol = currencyApi.CURRENCY_RATES[code]?.symbol || `${code} `;
    return `${symbol}${compactTokenApi.formatCompactTokens(amount, unitSystem, locale)}`;
  }

  return { formatCompactCurrencyFromUsd };
});
