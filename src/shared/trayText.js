'use strict';

(function exposeTrayText(root, factory) {
  const currency = (typeof require === 'function')
    ? require('./currency')
    : (root && root.TokenMonitorCurrency);
  const balanceDisplay = (typeof require === 'function')
    ? require('./limitBalanceDisplay')
    : (root && root.TokenMonitorLimitBalanceDisplay);
  const compactTokens = (typeof require === 'function')
    ? require('./compactTokens')
    : (root && root.TokenMonitorCompactTokens);
  const api = factory(currency, balanceDisplay, compactTokens);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorTrayText = api;
})(typeof window !== 'undefined' ? window : null, function createTrayText(currency, balanceDisplay, compactTokens) {
  const { formatCurrencyFromUsd } = currency;
  const BARS_TRAY_ICON_MODES = new Set(['bars', 'barsSession', 'barsWeekly', 'barsAllSessions']);

  function isBarsTrayIconMode(contentMode) {
    return BARS_TRAY_ICON_MODES.has(String(contentMode || ''));
  }

  function isGeneratedTrayIconMode(contentMode) {
    return contentMode === 'limitsAllSessions' || contentMode === 'custom' || isBarsTrayIconMode(contentMode);
  }

  // Only macOS renders a title next to the tray icon; elsewhere the text lives
  // in the tooltip. Both the tray itself and the settings preview read this so
  // the preview cannot promise text the platform will never draw.
  function trayShowsTitle(platform) {
    return platform === 'darwin';
  }

  // Generated tray icons are drawn in a single ink colour picked here rather than
  // at each canvas, so the bars, the session text and the custom layout cannot
  // drift apart. macOS keeps the black: its icons ship as template images and the
  // menubar re-inks them for light and dark itself, so lightening the source would
  // break the inversion. Every other platform hands the bitmap to the shell as-is,
  // which is why a dark taskbar or panel needs light ink — black on black is how
  // the icon went invisible. The light-surface values are the historical black.
  const TRAY_INK_ON_LIGHT_SURFACE = { track: 'rgba(0, 0, 0, 0.32)', fill: 'rgba(0, 0, 0, 1)', text: 'rgba(0, 0, 0, 1)' };
  const TRAY_INK_ON_DARK_SURFACE = { track: 'rgba(255, 255, 255, 0.32)', fill: 'rgba(255, 255, 255, 1)', text: 'rgba(255, 255, 255, 1)' };

  function trayGeneratedIconColors(platform, systemDarkUi = false) {
    if (platform === 'darwin' || systemDarkUi !== true) return { ...TRAY_INK_ON_LIGHT_SURFACE };
    return { ...TRAY_INK_ON_DARK_SURFACE };
  }

  // Most provider marks are authored `fill="currentColor"`, i.e. they expect the
  // host to ink them, and rasterize to flat black in a canvas. macOS re-inks them
  // through the template image, so only the other platforms do it here — but in
  // both directions, not just onto dark: a few marks are authored white and would
  // otherwise vanish on a light taskbar exactly as the black ones did on a dark
  // one. Full-colour brand artwork is never tinted, since flattening it to one
  // ink throws the brand colour away — hence a flat-ink test on the rasterized
  // pixels rather than a list of ids that would drift as icons are added.
  // Returns '' for "draw the artwork as it is".
  function trayProviderGlyphInk(platform, systemDarkUi = false, flatInk = false) {
    if (platform === 'darwin' || flatInk !== true) return '';
    return systemDarkUi === true ? TRAY_INK_ON_DARK_SURFACE.text : TRAY_INK_ON_LIGHT_SURFACE.text;
  }

  function formatCompactNumber(value, options = {}) {
    if (compactTokens?.formatCompactTokens) {
      return compactTokens.formatCompactTokens(
        value,
        options.compactTokenUnits,
        options.locale || options.language || 'en',
        { style: 'tray' }
      );
    }
    const n = Math.round(Number(value) || 0);
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  function topClientFromMetric(values) {
    let top = null;
    let topValue = 0;
    for (const [client, rawValue] of Object.entries(values || {})) {
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (!top || value > topValue) {
        top = client;
        topValue = value;
      }
    }
    return top;
  }

  function pickUsageProviderId(stats, metric = 'tokens', period = 'today', availableIconIds) {
    const values = stats?.periods?.[period] || {};
    const costClient = metric === 'cost' ? topClientFromMetric(values.clientCosts) : null;
    const client = costClient || topClientFromMetric(values.clients);
    if (!client) return null;
    if (!Array.isArray(availableIconIds)) return client;
    return new Set(availableIconIds).has(client) ? client : null;
  }

  function usageSessionActivityTimestampMs(session, source = 'period') {
    const value = source === 'native'
      ? session?.lastMessageAt || session?.createdAt || session?.startedAt
      : session?.lastUsedAt || session?.startedAt || session?.createdAt;
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function pickRecentUsageActivity(stats) {
    let latest = null;
    const considerSessions = (sessions, source) => {
      for (const session of Object.values(sessions || {})) {
        const client = normalizedProviderId(session?.client);
        if (!client) continue;
        const lastUsedMs = usageSessionActivityTimestampMs(session, source);
        if (lastUsedMs <= 0) continue;
        if (!latest || lastUsedMs > latest.lastUsedMs || (
          lastUsedMs === latest.lastUsedMs && client.localeCompare(latest.client) < 0
        )) latest = { client, lastUsedMs };
      }
    };
    for (const period of Object.values(stats?.periods || {})) {
      considerSessions(period?.sessions, 'period');
    }
    // This helper receives one device's presentation source. Reasonix native
    // sessions are intentionally excluded from periods.sessions, so include
    // their trusted activity timestamps without treating telemetry as usage.
    for (const sessions of Object.values(stats?.nativeSessions || {})) {
      considerSessions(sessions, 'native');
    }
    return latest ? { provider: latest.client, timestampMs: latest.lastUsedMs } : null;
  }

  function pickRecentUsageProviderId(stats, availableIconIds) {
    const client = normalizedProviderId(stats?.localRecentUsageActivity?.provider);
    if (!client) return null;
    if (!Array.isArray(availableIconIds)) return client;
    return new Set(availableIconIds).has(client) ? client : null;
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

  // Credits windows carry money, not a wire percentage; derive one so a
  // balance-only provider can still be picked and metered.
  function remainingPercent(window, provider = null) {
    return balanceDisplay.isCreditsWindow(window)
      ? balanceDisplay.creditsMeterPercent(provider, window)
      : limitFillPercent(window?.remainingPercent, window?.usedPercent, false);
  }

  function meteredWindows(provider, kind = '') {
    return (provider?.windows || []).filter((window) => {
      if (!window || window.showMeter === false || (kind && window.kind !== kind)) return false;
      return remainingPercent(window, provider) !== null;
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
      !pick || remainingPercent(window, provider) < remainingPercent(pick, provider) ? window : pick
    ), null);
  }

  function compactLimitSelection(provider) {
    if (!provider || provider.status !== 'ok' || provider.stale) return null;
    const session = preferredWindow(provider, 'session');
    const weekly = preferredWindow(provider, 'weekly');
    const billing = preferredWindow(provider, 'billing');
    const primaryWindow = session || weekly || billing;
    if (!primaryWindow) return null;
    const secondaryWindow = session ? weekly : null;
    return {
      provider: normalizedProviderId(provider.provider),
      providerRecord: provider,
      primaryWindow,
      secondaryWindow,
      // Resolved remaining percentages. Credits windows carry no wire
      // percentage, so consumers must read these instead of re-deriving from
      // the raw window — doing so yields a fabricated 0%.
      primaryPercent: remainingPercent(primaryWindow, provider),
      secondaryPercent: secondaryWindow ? remainingPercent(secondaryWindow, provider) : null
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
            !pick || remainingPercent(window, provider) < remainingPercent(pick, provider) ? window : pick
          ), null);
      if (!selectedWindow) continue;
      const remaining = remainingPercent(selectedWindow, provider);
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
        const showUsed = Boolean(options.showLimitUsed);
        const remaining = remainingPercent(selection.primaryWindow, provider);
        const modePercent = (window) => {
          if (!balanceDisplay.isCreditsWindow(window)) {
            return limitFillPercent(window?.remainingPercent, window?.usedPercent, showUsed);
          }
          const left = remainingPercent(window, provider);
          if (left === null) return null;
          return showUsed ? 100 - left : left;
        };
        const percent = modePercent(selection.primaryWindow);
        const secondaryPercent = modePercent(selection.secondaryWindow);
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
    if (contentMode === 'icon' || contentMode === 'custom') return '';
    if (contentMode === 'limitsAllSessions') return formatConfiguredSessionLimits(stats, options);
    if (isBarsTrayIconMode(contentMode)) {
      // Icon carries all the info; only show text if we have no limit data at all.
      if (pickWorstLimit(stats)) return '';
    }
    const today = stats?.periods?.today || {};
    const allTime = stats?.periods?.allTime || {};
    if (contentMode === 'cost') return formatCurrencyFromUsd(today.costUsd, currencyCode);
    if (contentMode === 'costAll') return formatCurrencyFromUsd(allTime.costUsd, currencyCode);
    if (contentMode === 'tokensAll') return formatCompactNumber(allTime.totalTokens, options);
    if (contentMode === 'bothAll') return `${formatCompactNumber(allTime.totalTokens, options)} · ${formatCurrencyFromUsd(allTime.costUsd, currencyCode)}`;
    if (contentMode === 'both') return `${formatCompactNumber(today.totalTokens, options)} · ${formatCurrencyFromUsd(today.costUsd, currencyCode)}`;
    return formatCompactNumber(today.totalTokens, options);
  }

  return {
    compactLimitSelection,
    formatCompactNumber,
    formatConfiguredSessionLimits,
    formatTrayText,
    isBarsTrayIconMode,
    isGeneratedTrayIconMode,
    pickConfiguredLimitProviders,
    pickConfiguredSessionLimits,
    pickLimitProviderByKindPriority,
    pickUsageProviderId,
    pickRecentUsageActivity,
    pickRecentUsageProviderId,
    pickWorstLimit,
    pickWorstLimitProvider,
    trayGeneratedIconColors,
    trayProviderGlyphInk,
    trayShowsTitle,
    usageSessionActivityTimestampMs
  };
});
