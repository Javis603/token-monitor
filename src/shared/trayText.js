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

  function pickWorstLimit(stats) {
    const providers = stats?.limits?.providers || [];
    let worst = null;
    for (const provider of providers) {
      if (provider.status !== 'ok' || provider.stale) continue;
      for (const window of provider.windows || []) {
        const remaining = Number(window.remainingPercent);
        if (!Number.isFinite(remaining)) continue;
        if (!worst || remaining < worst.remaining) {
          worst = { remaining, provider: provider.provider };
        }
      }
    }
    return worst;
  }

  function csvValues(value) {
    return Array.isArray(value) ? value : String(value || '').split(',');
  }

  function normalizedProviderId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function limitFillPercent(remainingPercent, usedPercent, showUsed) {
    const remaining = Number(remainingPercent);
    const used = Number(usedPercent);
    if (showUsed) {
      if (Number.isFinite(remaining)) return 100 - remaining;
      if (Number.isFinite(used)) return used;
      return null;
    }
    if (Number.isFinite(remaining)) return remaining;
    if (Number.isFinite(used)) return 100 - used;
    return null;
  }

  function formatPercent(value) {
    if (value === null || value === undefined || value === '') return '';
    const number = Number(value);
    return Number.isFinite(number) ? `${Math.round(Math.max(0, Math.min(100, number)))}%` : '';
  }

  function providerOrderFromStats(providers) {
    const seen = new Set();
    const order = [];
    for (const provider of providers || []) {
      const id = normalizedProviderId(provider?.provider);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
    return order;
  }

  function configuredProviderOrder(providers, options = {}) {
    const statsOrder = providerOrderFromStats(providers);
    const statsIds = new Set(statsOrder);
    const enabledRaw = csvValues(options.limitProviders).map(normalizedProviderId).filter(Boolean);
    const enabled = enabledRaw.length ? new Set(enabledRaw) : null;
    const seen = new Set();
    const order = [];
    for (const id of csvValues(options.limitProviderOrder).map(normalizedProviderId)) {
      if (!id || !statsIds.has(id) || seen.has(id) || (enabled && !enabled.has(id))) continue;
      seen.add(id);
      order.push(id);
    }
    for (const id of statsOrder) {
      if (seen.has(id) || (enabled && !enabled.has(id))) continue;
      seen.add(id);
      order.push(id);
    }
    return order;
  }

  function pickConfiguredSessionLimits(stats, options = {}) {
    const providers = Array.isArray(stats?.limits?.providers) ? stats.limits.providers : [];
    const byId = new Map();
    for (const provider of providers) {
      const id = normalizedProviderId(provider?.provider);
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(provider);
    }

    const picks = [];
    for (const id of configuredProviderOrder(providers, options)) {
      let pick = null;
      for (const provider of byId.get(id) || []) {
        if (!provider || provider.status !== 'ok' || provider.stale) continue;
        const session = (provider.windows || []).find((window) => window?.kind === 'session');
        const weekly = (provider.windows || []).find((window) => window?.kind === 'weekly');
        const remaining = limitFillPercent(session?.remainingPercent, session?.usedPercent, false);
        const percent = limitFillPercent(session?.remainingPercent, session?.usedPercent, Boolean(options.showLimitUsed));
        if (!session || remaining === null || percent === null) continue;
        const weeklyPercent = limitFillPercent(weekly?.remainingPercent, weekly?.usedPercent, Boolean(options.showLimitUsed));
        if (!pick || remaining < pick.remaining) pick = { provider: id, remaining, percent, weeklyPercent };
      }
      if (!pick) continue;
      picks.push(pick);
      if (picks.length === 2) break;
    }
    return picks;
  }

  function formatConfiguredSessionLimits(stats, options = {}) {
    const picks = pickConfiguredSessionLimits(stats, options);
    if (picks.length === 0) return '';
    if (picks.length === 1) {
      return [formatPercent(picks[0].percent), formatPercent(picks[0].weeklyPercent)]
        .filter(Boolean)
        .join(' · ');
    }
    return picks.map((pick) => formatPercent(pick.percent)).filter(Boolean).join(' · ');
  }

  function formatTrayText(stats, contentMode = 'tokens', currencyCode = 'USD', options = {}) {
    if (contentMode === 'icon') return '';
    if (contentMode === 'limitsAllSessions') return formatConfiguredSessionLimits(stats, options);
    if (contentMode === 'bars' || contentMode === 'barsSession' || contentMode === 'barsWeekly' || contentMode === 'barsAllSessions') {
      // Icon carries all the info; only show text if we have no limit data at all.
      if (pickWorstLimit(stats)) return '';
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

  return { formatCompactNumber, pickConfiguredSessionLimits, pickWorstLimit, formatTrayText };
});
