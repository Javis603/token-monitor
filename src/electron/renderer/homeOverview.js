(function exposeHomeOverview(root, factory) {
  const api = factory();
  if (root) root.TokenMonitorHomeOverview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null, function createHomeOverviewApi() {
  const windowPriority = new Map([
    ['session', 0],
    ['weekly', 1],
    ['billing', 2],
    ['monthly', 3]
  ]);

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, value));
  }

  function remainingPercent(window) {
    if (!window || window.showMeter === false) return null;
    const remaining = finiteNumber(window.remainingPercent);
    if (remaining != null) return clampPercent(remaining);
    const used = finiteNumber(window.usedPercent);
    return used == null ? null : clampPercent(100 - used);
  }

  function usedPercent(window) {
    const remaining = remainingPercent(window);
    return remaining == null ? null : 100 - remaining;
  }

  function balanceWindow(balance) {
    if (!balance) return null;
    const amount = Math.max(0, Number(balance?.amount || 0));
    if (!Number.isFinite(amount)) return null;
    const spend = Math.max(0, Number(balance?.monthSpend || 0));
    const total = amount + spend;
    const percent = total > 0 ? (amount / total) * 100 : 100;
    return {
      kind: 'balance',
      label: '',
      remainingPercent: clampPercent(percent),
      amount,
      currency: balance?.currency || ''
    };
  }

  function mimoPlanWindow(balance) {
    if (!balance || balance.planStatus === 'expired') return null;
    const used = finiteNumber(balance.planUsed);
    const limit = finiteNumber(balance.planLimit);
    const percent = finiteNumber(balance.planPercent);
    if (used == null && limit == null && percent == null) return null;
    const usedPercent = percent != null
      ? clampPercent(percent)
      : (used != null && limit != null && limit > 0 ? clampPercent((used / limit) * 100) : null);
    return {
      kind: 'billing',
      label: 'Token Plan',
      usedPercent,
      remainingPercent: usedPercent == null ? null : clampPercent(100 - usedPercent)
    };
  }

  function accountWindows(account) {
    const providerId = String(account?.providerId || '').trim().toLowerCase();
    const windows = Array.isArray(account?.windows) ? [...account.windows] : [];
    if (providerId === 'mimo' && account?.balance?.planStatus === 'expired') {
      const withoutStalePlan = windows.filter((window) => String(window?.kind || '').trim().toLowerCase() !== 'billing');
      withoutStalePlan.push({ kind: 'billing', label: 'Token Plan', showMeter: false, planStatus: 'expired' });
      const balance = balanceWindow(account.balance);
      if (balance) withoutStalePlan.push(balance);
      return withoutStalePlan;
    }
    if (providerId === 'mimo' && !windows.some((window) => String(window?.kind || '').trim().toLowerCase() === 'billing')) {
      const plan = mimoPlanWindow(account.balance);
      if (plan) windows.push(plan);
    }
    if (providerId === 'deepseek' || providerId === 'mimo') {
      const balance = balanceWindow(account.balance);
      if (balance) windows.push(balance);
    }
    return windows;
  }

  function homeLimitAccounts(accounts, limit = 3, { sort = 'remaining' } = {}) {
    return (accounts || [])
      .map((account, index) => {
        const windows = accountWindows(account)
          .map((window, windowIndex) => ({
            kind: String(window.kind || '').trim().toLowerCase(),
            label: window.label || window.kind || '',
            remainingPercent: remainingPercent(window),
            resetsAt: window.resetsAt,
            resetDescription: window.resetDescription || '',
            value: window.value || '',
            planStatus: window.planStatus || '',
            amount: finiteNumber(window.amount),
            currency: window.currency || '',
            index: windowIndex
          }))
          .filter((window) => window.remainingPercent != null || window.planStatus === 'expired' || window.value)
          .sort((a, b) => {
            const aPriority = windowPriority.get(a.kind) ?? 10;
            const bPriority = windowPriority.get(b.kind) ?? 10;
            return aPriority - bPriority || a.index - b.index;
          })
          .slice(0, 2)
          .map(({ index: _index, ...window }) => window);
        if (windows.length === 0) return null;
        return {
          key: account.key || String(index),
          providerId: account.providerId || '',
          name: account.name || '',
          color: account.color || '',
          lowestRemaining: Math.min(...windows.map((window) => window.remainingPercent ?? 100)),
          windows,
          index
        };
      })
      .filter(Boolean)
      .sort((a, b) => sort === 'configured'
        ? a.index - b.index
        : a.lowestRemaining - b.lowestRemaining || a.index - b.index)
      .slice(0, Math.max(0, Number(limit) || 0))
      .map(({ index: _index, ...account }) => account);
  }

  function homeModelRows(rows, totalTokens, limit = 5) {
    const visible = (rows || []).slice(0, Math.max(0, Number(limit) || 0));
    const suppliedTotal = finiteNumber(totalTokens);
    const total = suppliedTotal != null && suppliedTotal > 0
      ? suppliedTotal
      : visible.reduce((sum, row) => sum + Math.max(0, Number(row?.value || 0)), 0);
    return visible.map((row) => ({
      key: row.key || row.name || '',
      name: row.name || '',
      value: Math.max(0, Number(row.value || 0)),
      share: total > 0 ? Math.max(0, Number(row.value || 0)) / total : 0,
      color: row.color || ''
    }));
  }

  function homeToolRows(rows, totalTokens, limit = 5) {
    const visible = (rows || [])
      .map((row) => ({
        key: row?.key || row?.name || '',
        name: row?.name || '',
        value: Math.max(0, Number(row?.value || 0)),
        color: row?.color || ''
      }))
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
      .slice(0, Math.max(0, Number(limit) || 0));
    const suppliedTotal = finiteNumber(totalTokens);
    const total = suppliedTotal != null && suppliedTotal > 0
      ? suppliedTotal
      : visible.reduce((sum, row) => sum + row.value, 0);
    return visible.map((row) => ({
      ...row,
      share: total > 0 ? row.value / total : 0
    }));
  }

  function homeDeviceRows(devices, { localDeviceId = '', period = 'today', limit = 4 } = {}) {
    const localKey = String(localDeviceId || '').trim();
    return (devices || [])
      .map((device, index) => {
        const key = String(device?.deviceId || '').trim() || String(index);
        const value = Math.max(0, Number(device?.periods?.[period]?.totalTokens || device?.[period]?.totalTokens || 0));
        return {
          key,
          name: String(device?.displayName || device?.deviceId || device?.hostname || key).trim(),
          value,
          platform: device?.platform || '',
          isLocal: Boolean(localKey && key === localKey),
          isStale: Boolean(device?.stale),
          index
        };
      })
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value
        || Number(b.isLocal) - Number(a.isLocal)
        || Number(a.isStale) - Number(b.isStale)
        || a.index - b.index)
      .slice(0, Math.max(0, Number(limit) || 0))
      .map(({ index: _index, ...row }) => row);
  }

  function providerEntriesById(providers) {
    const byId = new Map();
    for (const provider of providers || []) {
      const id = String(provider?.provider || '').trim().toLowerCase();
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(provider);
    }
    return byId;
  }

  function homeLimitAccountsForProviders({
    providers = [],
    providerOptions = [],
    enabledProviderIds = [],
    hiddenProviderIds = [],
    colors = {},
    limit = 3,
    sort = 'remaining',
    accountName
  } = {}) {
    const enabled = new Set((enabledProviderIds || []).map((id) => String(id || '').trim().toLowerCase()).filter(Boolean));
    const hidden = new Set((hiddenProviderIds || []).map((id) => String(id || '').trim().toLowerCase()).filter(Boolean));
    const byId = providerEntriesById(providers);
    const accounts = [];
    for (const { id: rawId, label } of providerOptions || []) {
      const id = String(rawId || '').trim().toLowerCase();
      if (!id || hidden.has(id) || (enabled.size > 0 && !enabled.has(id))) continue;
      const providerEntries = byId.get(id) || [];
      providerEntries.forEach((provider, index) => {
        accounts.push({
          key: `${id}:${index}`,
          providerId: id,
          name: typeof accountName === 'function' ? accountName(provider, index, providerEntries) : label,
          color: colors[id] || colors.default || '',
          windows: provider.windows || [],
          balance: provider.balance || null
        });
      });
    }
    return homeLimitAccounts(accounts, limit, { sort });
  }

  function homeTrendSummary(points) {
    const visible = Array.isArray(points) ? points : [];
    const peak = Math.max(0, ...visible.map((point) => Math.max(0, Number(point?.tokens || 0))));
    const dates = visible.length === 0
      ? []
      : [
          visible[0]?.date || '',
          visible[Math.floor((visible.length - 1) / 2)]?.date || '',
          visible[visible.length - 1]?.date || ''
        ];
    return { peak, dates };
  }

  function homeActivityHeatmapLayout() {
    return { cell: 9, gap: 3, radius: 2 };
  }

  function historyHasDays(history) {
    return Array.isArray(history?.daily) && history.daily.length > 0;
  }

  // Which history source the home activity/trends module renders. Prefer the
  // full-year homeHistory (fetched on demand), but fall back to the compact stats
  // preview while it loads — an empty homeHistory must never shadow real preview
  // data (#39: a cold-start fetch that raced the collector cached an empty result).
  function pickHomeHistory(homeHistory, preview) {
    return historyHasDays(homeHistory) ? homeHistory : (preview || { daily: [] });
  }

  // The full-year homeHistory is fetched once per session and then frozen, so its today
  // bucket lags the live headline total as usage accrues within the day (the trends
  // sparkline avoids this via patchTodayBar). Overwrite today's tokens AND cost with the
  // live period totals so the home heatmap/trend agree with the number shown above them
  // — cost matters because dailyWithHeatIntensity colours cells by cost when any exists,
  // so an appended today with cost 0 would render as an empty cell. Append a today row
  // when the frozen snapshot predates today (app opened before midnight). Returns a new
  // array; the input is never mutated.
  function patchDailyToday(daily, todayDate, todayTotal, todayCost) {
    const rows = Array.isArray(daily) ? daily.slice() : [];
    const date = String(todayDate || '').slice(0, 10);
    if (!date) return rows;
    const tokens = finiteNumber(todayTotal) || 0;
    const cost = finiteNumber(todayCost) || 0;
    const idx = rows.findIndex((row) => String(row?.date).slice(0, 10) === date);
    if (idx === -1) {
      rows.push({ date, tokens, cost });
      return rows;
    }
    rows[idx] = Object.assign({}, rows[idx], { tokens, cost });
    return rows;
  }

  // Stable signature of the preview's daily tail. Two previews with the same key
  // describe the same fetch opportunity, so the full history is fetched at most
  // once per distinct preview state — a failed/empty fetch (e.g. a transient
  // /api/history error in hub mode while /api/stats preview has data) can't spin
  // the render→fetch loop, since loadHomeHistory's finally always re-renders Home.
  function historyPreviewKey(preview) {
    const daily = Array.isArray(preview?.daily) ? preview.daily : [];
    if (daily.length === 0) return '';
    const last = daily[daily.length - 1] || {};
    return `${daily.length}:${last.date || ''}:${last.tokens || 0}`;
  }

  // Whether loadHomeHistory should (re)fetch the full history. The first fetch can
  // race the local collector at cold start and return empty; don't let that stick —
  // refetch once the stats preview confirms history exists, but only when the preview
  // has actually changed since the last attempt (so one bad fetch can't loop), stop
  // once we hold the full data, and never poll a genuinely zero-usage account (#39).
  function shouldFetchHomeHistory({ homeHistory, requested, preview, lastPreviewKey } = {}) {
    if (historyHasDays(homeHistory)) return false;
    if (!requested) return true;
    const key = historyPreviewKey(preview);
    if (!key) return false;
    return key !== lastPreviewKey;
  }

  function homeActivityWheelRoute(event) {
    if (event?.shiftKey) return 'activity-horizontal';
    const deltaX = Math.abs(Number(event?.deltaX || 0));
    const deltaY = Math.abs(Number(event?.deltaY || 0));
    return deltaY > deltaX ? 'home-vertical' : 'activity-horizontal';
  }

  function maxScrollLeft(scrollWidth, clientWidth) {
    return Math.max(0, Number(scrollWidth || 0) - Number(clientWidth || 0));
  }

  // Where the activity heatmap should sit: pinned to the newest (right) edge while
  // the user is following the end, otherwise their saved offset clamped to the
  // current overflow. Callers re-run this from a ResizeObserver so the measurement
  // is taken after layout settles, not from a too-early requestAnimationFrame.
  function homeActivityScrollTarget({ scrollWidth, clientWidth, followEnd, savedLeft } = {}) {
    const max = maxScrollLeft(scrollWidth, clientWidth);
    if (followEnd || savedLeft == null) return max;
    const saved = Number(savedLeft);
    if (!Number.isFinite(saved)) return max;
    return Math.max(0, Math.min(max, saved));
  }

  // Turn an observed scroll position into the state we persist. Returns null when
  // the heatmap has not overflowed yet (panel hidden or layout not settled), so a
  // bogus 0 measured too early can never overwrite a real saved/follow-end value.
  function homeActivityScrollRecord({ scrollLeft, scrollWidth, clientWidth, endThreshold = 2 } = {}) {
    const max = maxScrollLeft(scrollWidth, clientWidth);
    if (max <= 0) return null;
    const left = Math.max(0, Math.min(max, Number(scrollLeft || 0)));
    return { scrollLeft: left, followEnd: left >= max - endThreshold };
  }

  return {
    homeLimitAccounts,
    homeLimitAccountsForProviders,
    homeModelRows,
    homeToolRows,
    homeDeviceRows,
    homeTrendSummary,
    pickHomeHistory,
    patchDailyToday,
    historyPreviewKey,
    shouldFetchHomeHistory,
    homeActivityHeatmapLayout,
    homeActivityWheelRoute,
    homeActivityScrollTarget,
    homeActivityScrollRecord,
    remainingPercent,
    usedPercent
  };
});
