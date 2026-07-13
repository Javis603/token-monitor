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

  function csvValues(value) {
    return Array.isArray(value) ? value : String(value || '').split(',');
  }

  function normalizedProviderId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function limitFillPercent(remainingPercent, usedPercent, showUsed) {
    const remaining = remainingPercent === null || remainingPercent === undefined || remainingPercent === ''
      ? NaN : Number(remainingPercent);
    const used = usedPercent === null || usedPercent === undefined || usedPercent === ''
      ? NaN : Number(usedPercent);
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

  function remainingPercent(window) {
    return limitFillPercent(window?.remainingPercent, window?.usedPercent, false);
  }

  function meteredWindows(provider, kind = '') {
    return (provider?.windows || []).filter((window) => {
      if (!window || window.showMeter === false || (kind && window.kind !== kind)) return false;
      return remainingPercent(window) !== null;
    });
  }

  function preferredWindow(provider, kind) {
    const windows = meteredWindows(provider, kind);
    if (windows.length < 2) return windows[0] || null;

    // A compact, unlabeled icon cannot explain two pools of the same kind. Prefer
    // the provider's canonical aggregate window instead of silently substituting
    // a scoped/model pool (Claude Fable) or a sub-quota (Cursor API) for it.
    const canonicalLabels = kind === 'weekly' ? new Set(['', 'weekly'])
      : kind === 'billing' ? new Set(['', 'total'])
        : new Set(['']);
    const canonical = windows.find((window) => canonicalLabels.has(String(window.label || '').trim().toLowerCase()));
    if (canonical) return canonical;
    return windows.reduce((pick, window) => (
      !pick || remainingPercent(window) < remainingPercent(pick) ? window : pick
    ), null);
  }

  function compactLimitSelection(provider) {
    if (!provider || provider.status !== 'ok' || provider.stale) return null;
    const session = preferredWindow(provider, 'session');
    const weekly = preferredWindow(provider, 'weekly');
    const billing = preferredWindow(provider, 'billing');
    const primaryWindow = session || weekly || billing;
    if (!primaryWindow) return null;
    return {
      provider: normalizedProviderId(provider.provider),
      providerRecord: provider,
      primaryWindow,
      secondaryWindow: session ? weekly : null
    };
  }

  function pickWorstLimitProvider(stats, options = {}) {
    const requestedKind = String(options.kind || '').trim().toLowerCase();
    let worst = null;
    for (const provider of stats?.limits?.providers || []) {
      const selection = compactLimitSelection(provider);
      if (!selection) continue;
      const candidates = [selection.primaryWindow, selection.secondaryWindow].filter(Boolean);
      const selectedWindow = requestedKind
        ? preferredWindow(selection.providerRecord, requestedKind)
        : candidates.reduce((pick, window) => (
            !pick || remainingPercent(window) < remainingPercent(pick) ? window : pick
          ), null);
      if (!selectedWindow) continue;
      const remaining = remainingPercent(selectedWindow);
      if (!worst || remaining < worst.remaining) worst = { ...selection, selectedWindow, remaining };
    }
    return worst;
  }

  function pickWorstLimit(stats) {
    const pick = pickWorstLimitProvider(stats);
    return pick ? { remaining: pick.remaining, provider: pick.provider } : null;
  }

  function pickLimitProviderByKindPriority(stats, kinds = []) {
    for (const kind of kinds) {
      const pick = pickWorstLimitProvider(stats, { kind });
      if (pick) return pick;
    }
    return null;
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
    const enabled = options.limitProviders === undefined || options.limitProviders === null
      ? null : new Set(enabledRaw);
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

  function pickConfiguredLimitProviders(stats, options = {}) {
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
        const selection = compactLimitSelection(provider);
        if (!selection) continue;
        const remaining = remainingPercent(selection.primaryWindow);
        const percent = limitFillPercent(
          selection.primaryWindow.remainingPercent,
          selection.primaryWindow.usedPercent,
          Boolean(options.showLimitUsed)
        );
        const secondaryPercent = limitFillPercent(
          selection.secondaryWindow?.remainingPercent,
          selection.secondaryWindow?.usedPercent,
          Boolean(options.showLimitUsed)
        );
        const candidate = {
          ...selection,
          selectedWindow: selection.primaryWindow,
          remaining,
          percent,
          secondaryPercent,
          // Keep the old field available to internal callers while the mode id
          // remains a compatibility surface.
          weeklyPercent: selection.secondaryWindow?.kind === 'weekly' ? secondaryPercent : null
        };
        const candidateRank = ['session', 'weekly', 'billing'].indexOf(selection.primaryWindow.kind);
        const pickRank = pick ? ['session', 'weekly', 'billing'].indexOf(pick.primaryWindow.kind) : Infinity;
        if (!pick || candidateRank < pickRank || (candidateRank === pickRank && remaining < pick.remaining)) pick = candidate;
      }
      if (!pick) continue;
      picks.push(pick);
      if (picks.length === 2) break;
    }
    return picks;
  }

  function pickConfiguredSessionLimits(stats, options = {}) {
    return pickConfiguredLimitProviders(stats, options);
  }

  function formatConfiguredSessionLimits(stats, options = {}) {
    const picks = pickConfiguredLimitProviders(stats, options);
    if (picks.length === 0) return '';
    if (picks.length === 1) {
      return [formatPercent(picks[0].percent), formatPercent(picks[0].secondaryPercent)]
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

  return {
    compactLimitSelection,
    formatCompactNumber,
    formatConfiguredSessionLimits,
    pickConfiguredLimitProviders,
    pickConfiguredSessionLimits,
    pickLimitProviderByKindPriority,
    pickWorstLimit,
    pickWorstLimitProvider,
    formatTrayText
  };
});
