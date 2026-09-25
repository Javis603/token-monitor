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
    return contentMode === 'limitsAllSessions'
      || contentMode === 'liveTokenRate'
      || contentMode === 'custom'
      || isBarsTrayIconMode(contentMode);
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

  function isCanonicalCodexWindow(provider, window) {
    if (normalizedProviderId(provider?.provider) !== 'codex') return true;
    return window?.additional !== true;
  }

  function meteredWindows(provider, kind = '') {
    return (provider?.windows || []).filter((window) => {
      if (
        !window
        || window.showMeter === false
        || (kind && window.kind !== kind)
        || !isCanonicalCodexWindow(provider, window)
      ) return false;
      return remainingPercent(window, provider) !== null;
    });
  }

  function preferredWindow(provider, kind) {
    const windows = meteredWindows(provider, kind);
    if (windows.length < 2) return windows[0] || null;

    // A compact, unlabeled icon cannot explain two pools of the same kind. Prefer
    // the provider's canonical aggregate window instead of silently substituting
    // a scoped/model pool (Claude Fable) or a sub-quota (Cursor API) for it.
    const canonical = windows.find((window) => canonicalWindowLabels(kind).has(String(window.label || '').trim().toLowerCase()));
    if (canonical) return canonical;
    return windows.reduce((pick, window) => (
      !pick || remainingPercent(window, provider) < remainingPercent(pick, provider) ? window : pick
    ), null);
  }

  // Canonical label sets, shared by preferredWindow() and the exhaustion gate.
  // "Monthly" counts as canonical for billing: it is this app's own convention
  // label for the account-level cadence window (Codex, Kimi, OpenCode, …), not
  // a named sub-pool like "MCP" or "Token Spend".
  const CANONICAL_KIND_LABELS = {
    weekly: new Set(['', 'weekly']),
    billing: new Set(['', 'total', 'monthly'])
  };
  const CANONICAL_DEFAULT_LABELS = new Set(['']);

  function canonicalWindowLabels(kind) {
    return CANONICAL_KIND_LABELS[kind] || CANONICAL_DEFAULT_LABELS;
  }

  // Which window of a kind may testify that the account is out of quota.
  // The additional flag marks a provider-declared extra pool (Factory's
  // Core/Premium pools, Codex additional_rate_limits) — it can never testify
  // about the account aggregate, whatever its kind. Among the remaining
  // windows the pick mirrors preferredWindow(), except a lone window is only
  // trusted when its label is canonical for the kind: preferredWindow()
  // returns a sole window without checking labels, so a scoped pool with no
  // aggregate sibling (Claude Fable-only weekly, Cursor Grok Bot) would
  // otherwise look like the account gate it provably is not.
  function gatingWindow(provider, kind) {
    const windows = meteredWindows(provider, kind).filter((window) => window.additional !== true);
    if (windows.length === 0) return null;
    if (windows.length > 1) return preferredWindow(provider, kind);
    return canonicalWindowLabels(kind).has(String(windows[0].label || '').trim().toLowerCase())
      ? windows[0]
      : null;
  }

  function compactLimitSelection(provider) {
    if (!provider || provider.status !== 'ok' || provider.stale) return null;
    const session = preferredWindow(provider, 'session');
    const daily = preferredWindow(provider, 'daily');
    const weekly = preferredWindow(provider, 'weekly');
    const billing = preferredWindow(provider, 'billing');
    const primaryWindow = session || daily || weekly || billing;
    if (!primaryWindow) return null;
    const secondaryWindow = session ? (daily || weekly) : daily ? weekly : null;
    const metered = meteredWindows(provider);
    // An empty pool gates the account no matter which window the headline
    // would otherwise print: a full session bar beside a monthly quota at 0%
    // still means unusable. Any metered window counts, not just the primary and
    // secondary pair, so a monthly-only drain still surfaces. Money windows are
    // the exception: a balance or spend figure at its end (credits, spend) is
    // not proof the account stopped serving — grants can run dry while top-ups
    // still fund requests, and balances often bill past zero — so only plain
    // quota windows may exhaust the headline.
    // Only the canonical window per kind counts: a scoped or model-specific pool
    // (Claude Fable, Cursor API sub-quota) draining to zero says nothing about
    // the rest of the account, which is why preferredWindow() exists. And a
    // legacy spend row arriving through an old hub carries no metric marker, so
    // it has to be excluded by identity, not by the metric flag alone.
    const spend = balanceDisplay.spendWindow(provider);
    const exhaustedWindow = ['session', 'daily', 'weekly', 'billing']
      .map((kind) => gatingWindow(provider, kind))
      .filter((window) => window && !window.metric && window !== spend)
      .find((window) => remainingPercent(window, provider) === 0) || null;
    // The tightest metered pool, whatever its kind. The headline does not
    // report this — a 100% session beside a 9% weekly still reads 100% — but a
    // warn-colour surface needs it so an almost-gated account can flag before
    // the headline flips to 0%.
    const tightestPercent = metered.reduce((low, window) => {
      const remaining = remainingPercent(window, provider);
      return remaining === null ? low : (low === null || remaining < low ? remaining : low);
    }, null);
    return {
      provider: normalizedProviderId(provider.provider),
      providerRecord: provider,
      primaryWindow,
      secondaryWindow,
      exhaustedWindow,
      tightestPercent,
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
        // An exhausted canonical quota gates the account even when it sits
        // outside the primary/secondary pair (monthly billing is never a
        // candidate), so the default pick reports 0% the same way the dock
        // rail does. Kind-pinned picks stay on their own pool: a user who
        // pinned the weekly bar asked for the weekly number, not a verdict.
        : selection.exhaustedWindow || candidates.reduce((pick, window) => (
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
        const candidateRank = ['session', 'daily', 'weekly', 'billing'].indexOf(selection.primaryWindow.kind);
        const pickRank = pick ? ['session', 'daily', 'weekly', 'billing'].indexOf(pick.primaryWindow.kind) : Infinity;
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
    if (contentMode === 'icon' || contentMode === 'liveTokenRate' || contentMode === 'custom') return '';
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
