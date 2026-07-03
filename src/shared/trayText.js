'use strict';

(function exposeTrayText(root, factory) {
  const currency = (typeof require === 'function')
    ? require('./currency')
    : (root && root.TokenMonitorCurrency);
  const api = factory(currency);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorTrayText = api;
})(typeof window !== 'undefined' ? window : null, function createTrayText(currency) {
  const { formatCurrencyFromUsd } = currency;

  function formatCompactNumber(value) {
    const n = Math.round(Number(value) || 0);
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  function providerLimitOk(provider) {
    return Boolean(provider && provider.status === 'ok' && !provider.stale);
  }

  function limitWindowEligible(window) {
    return Boolean(window && window.showMeter !== false && Number.isFinite(Number(window.remainingPercent)));
  }

  function pickWorstBarPair(stats, windowFilter = null) {
    const providers = stats?.limits?.providers || [];
    let best = null;
    for (const provider of providers) {
      if (!providerLimitOk(provider)) continue;
      const matching = (provider.windows || [])
        .filter(limitWindowEligible)
        .filter((window) => !windowFilter || windowFilter(window))
        .sort((a, b) => Number(a.remainingPercent) - Number(b.remainingPercent));
      if (!matching.length) continue;
      const primary = matching[0];
      if (!best || Number(primary.remainingPercent) < Number(best.firstWindow.remainingPercent)) {
        best = {
          provider,
          firstWindow: matching[0],
          secondWindow: matching[1] || null
        };
      }
    }
    return best;
  }

  function pickBarPairForTrayMode(stats, contentMode = 'bars') {
    if (contentMode === 'barsSession') {
      return pickWorstBarPair(stats, (window) => window.kind === 'session')
        || pickWorstBarPair(stats, (window) => window.kind === 'billing')
        || pickWorstBarPair(stats, null);
    }
    if (contentMode === 'barsWeekly') {
      return pickWorstBarPair(stats, (window) => window.kind === 'weekly')
        || pickWorstBarPair(stats, null);
    }
    if (contentMode === 'barsAllSessions') {
      return pickWorstBarPair(stats, (window) => window.kind === 'session');
    }
    if (contentMode === 'bars') {
      return pickWorstBarPair(stats, null);
    }
    return null;
  }

  function pickWorstLimit(stats) {
    return pickWorstLimitForMode(stats, 'bars');
  }

  function pickWorstLimitForMode(stats, contentMode = 'bars') {
    const pair = pickBarPairForTrayMode(stats, contentMode);
    if (!pair?.firstWindow) return null;
    return {
      remaining: Number(pair.firstWindow.remainingPercent),
      provider: pair.provider.provider
    };
  }

  function formatTrayText(stats, contentMode = 'tokens', currencyCode = 'USD') {
    if (contentMode === 'icon') return '';
    if (contentMode === 'bars' || contentMode === 'barsSession' || contentMode === 'barsWeekly' || contentMode === 'barsAllSessions') {
      const worst = pickWorstLimitForMode(stats, contentMode);
      if (worst) return `${Math.round(worst.remaining)}%`;
      return '—';
    }
    const today = stats?.periods?.today || {};
    const allTime = stats?.periods?.allTime || {};
    if (contentMode === 'cost') return formatCurrencyFromUsd(today.costUsd, currencyCode);
    if (contentMode === 'costAll') return formatCurrencyFromUsd(allTime.costUsd, currencyCode);
    if (contentMode === 'tokensAll') return formatCompactNumber(allTime.totalTokens);
    if (contentMode === 'bothAll') return `${formatCompactNumber(allTime.totalTokens)} · ${formatCurrencyFromUsd(allTime.costUsd, currencyCode)}`;
    if (contentMode === 'both') return `${formatCompactNumber(today.totalTokens)} · ${formatCurrencyFromUsd(today.costUsd, currencyCode)}`;
    return formatCompactNumber(today.totalTokens);
  }

  return {
    formatCompactNumber,
    limitWindowEligible,
    pickWorstBarPair,
    pickBarPairForTrayMode,
    pickWorstLimit,
    pickWorstLimitForMode,
    formatTrayText
  };
});
