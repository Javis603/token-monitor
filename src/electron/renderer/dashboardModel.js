// @ts-check
'use strict';

(function exposeDashboardModel(root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  /** @type {any} */
  const win = root;
  const api = factory(
    isNode ? require('./usageCharts') : win?.TokenMonitorUsageCharts,
    isNode ? require('../../shared/vendorPresentation') : win?.TokenMonitorVendorPresentation,
    isNode ? require('../../shared/deviceKind') : win?.TokenMonitorDeviceKind,
    isNode ? require('./deviceBreakdown') : win?.TokenMonitorDeviceBreakdown,
    isNode ? require('./projectRows') : win?.TokenMonitorProjectRows,
    isNode ? require('./homeOverview') : win?.TokenMonitorHomeOverview,
    isNode ? require('../../shared/limits/balanceDisplay') : win?.TokenMonitorLimitBalanceDisplay,
    isNode ? require('../../shared/sessionLive') : win?.TokenMonitorSessionLive,
    isNode ? require('../../shared/clientCatalog') : win?.TokenMonitorClientCatalog,
    isNode ? require('./fixedPeriodRanges') : win?.TokenMonitorFixedPeriodRanges,
    isNode ? require('../../shared/limits/providers') : win?.TokenMonitorLimitProviders,
    isNode ? require('./tokenRatePresentation') : win?.TokenMonitorTokenRate,
    isNode ? require('./accountIdentity') : win?.TokenMonitorAccountIdentity
  );
  if (isNode) module.exports = api;
  if (win) win.TokenMonitorDashboardModel = api;
})(typeof window !== 'undefined' ? window : null, /** @param {any} usageCharts @param {any} vendorPresentation @param {any} deviceKindApi @param {any} deviceBreakdown @param {any} projectRowsApi @param {any} homeOverviewApi @param {any} balanceDisplay @param {any} sessionLive @param {any} clientCatalog @param {any} fixedPeriodRanges @param {any} limitProvidersApi @param {any} tokenRateApi @param {any} accountIdentityApi */ function createDashboardModelApi(
  usageCharts,
  vendorPresentation,
  deviceKindApi,
  deviceBreakdown,
  projectRowsApi,
  homeOverviewApi,
  balanceDisplay,
  sessionLive,
  clientCatalog,
  fixedPeriodRanges,
  limitProvidersApi,
  tokenRateApi,
  accountIdentityApi
) {
  /** @param {unknown} value */
  function n(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /** @param {string} client */
  function canonicalClientKey(client) {
    return client === 'antigravity-cli' ? 'antigravity' : String(client || '');
  }

  /** @param {string} id */
  function hasBrandMask(id) {
    return Boolean(id && vendorPresentation?.ROW_ICON_MASKS && Object.prototype.hasOwnProperty.call(vendorPresentation.ROW_ICON_MASKS, id));
  }

  /** @param {string} id */
  function clientDisplayLabel(id) {
    if (!id) return '';
    return vendorPresentation?.VENDOR_LABELS?.[id]
      || clientCatalog?.CLIENT_LABELS?.[id]
      || id;
  }

  /** @param {string} id */
  function clientColor(id) {
    return usageCharts?.clientColors?.[id]
      || usageCharts?.clientColors?.default
      || '#6ab4f0';
  }

  /** @param {string} model */
  function modelColor(model) {
    return usageCharts?.modelColor?.(model) || '#6ab4f0';
  }

  /**
   * Resolves a period object (`today`, `yesterday`, `week`, `last7`, `last30`, `month`, `allTime`)
   * from native `source.periods[periodKey]` when available, or derives fixed ranges via
   * `fixedPeriodRanges.fixedPeriodSnapshot` from `historyDaily`.
   *
   * @param {any} source
   * @param {any[]} historyDaily
   * @param {string} periodKey
   * @param {{ locale?: string, todayKey?: string }} [options]
   */
  function resolvePeriodData(source, historyDaily, periodKey, options = {}) {
    const direct = source?.periods?.[periodKey] || source?.[periodKey];
    if (direct && typeof direct === 'object') return direct;

    const todayKey = options.todayKey || usageCharts?.localDayKey?.() || fixedPeriodRanges?.localDayKey?.() || '';
    const daily = Array.isArray(historyDaily) ? historyDaily : [];

    if (fixedPeriodRanges?.isDerived?.(periodKey) && (daily.length > 0 || source?.periods?.today || source?.today)) {
      const snapshot = fixedPeriodRanges.fixedPeriodSnapshot(periodKey, {
        historyAvailable: true,
        daily,
        todayKey,
        liveTodayKey: source?.periodWindows?.today?.key || todayKey,
        todayPeriod: source?.periods?.today || source?.today || null,
        locale: options.locale || 'en'
      });
      if (snapshot?.status === 'ready' && snapshot.period) {
        return { ...snapshot.period, derivedFromHistory: true };
      }
    }

    if (periodKey === 'month' && daily.length > 0 && todayKey) {
      const prefix = todayKey.slice(0, 7);
      const inMonth = daily.filter((row) => String(row?.date || '').slice(0, 7) === prefix);
      if (inMonth.length > 0 && fixedPeriodRanges?.derivePeriod) {
        return { ...fixedPeriodRanges.derivePeriod(inMonth, { start: `${prefix}-01`, end: todayKey }), derivedFromHistory: true };
      }
    }

    if (periodKey === 'allTime' && daily.length > 0 && fixedPeriodRanges?.derivePeriod) {
      return { ...fixedPeriodRanges.derivePeriod(daily, { start: daily[0]?.date || '', end: daily[daily.length - 1]?.date || '' }), derivedFromHistory: true };
    }

    return null;
  }

  /**
   * Folds per-client token/cost maps while mapping legacy `antigravity-cli` to `antigravity`.
   *
   * @param {Record<string, unknown> | undefined} map
   */
  function foldClientNumbers(map) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [rawKey, value] of Object.entries(map || {})) {
      const key = canonicalClientKey(rawKey);
      if (!key) continue;
      out[key] = (out[key] || 0) + Math.max(0, n(value));
    }
    return out;
  }

  /**
   * Computes a concise summary from daily rows when a scoped device history omits `summary`.
   *
   * @param {any[]} daily
   * @param {any} [existingSummary]
   */
  function summarizeDaily(daily, existingSummary) {
    const base = existingSummary && typeof existingSummary === 'object' ? existingSummary : {};
    const rows = Array.isArray(daily) ? daily.slice().sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || ''))) : [];
    if (rows.length === 0) {
      return {
        totalTokens: n(base.totalTokens),
        totalCost: n(base.totalCost),
        unpricedTokens: n(base.unpricedTokens),
        activeDays: n(base.activeDays),
        currentStreak: n(base.currentStreak),
        activeTimeMs: n(base.activeTimeMs),
        peakDayTokens: n(base.peakDayTokens),
        favoriteModel: String(base.favoriteModel || ''),
        messages: n(base.messages)
      };
    }

    let totalTokens = 0;
    let totalCost = 0;
    let unpricedTokens = 0;
    let activeDays = 0;
    let activeTimeMs = 0;
    let peakDayTokens = 0;
    let messages = 0;
    /** @type {Record<string, number>} */
    const modelTotals = {};

    for (const row of rows) {
      const tokens = Math.max(0, n(row?.tokens));
      const cost = Math.max(0, n(row?.cost));
      totalTokens += tokens;
      totalCost += cost;
      unpricedTokens += Math.max(0, n(row?.unpricedTokens));
      if (tokens > 0) activeDays += 1;
      activeTimeMs += Math.max(0, n(row?.activeTimeMs));
      if (tokens > peakDayTokens) peakDayTokens = tokens;
      messages += Math.max(0, n(row?.messages));
      for (const [model, entry] of Object.entries(row?.perModel || {})) {
        const modelTokens = typeof entry === 'object' && entry ? n(/** @type {any} */ (entry).tokens) : n(entry);
        if (model && modelTokens > 0) modelTotals[model] = (modelTotals[model] || 0) + modelTokens;
      }
    }

    let currentStreak = 0;
    const today = usageCharts?.localDayKey?.() || '';
    let expectedDate = today;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const date = String(rows[i]?.date || '').slice(0, 10);
      const tokens = Math.max(0, n(rows[i]?.tokens));
      if (i === rows.length - 1 && tokens <= 0) break;
      if (currentStreak === 0 && tokens > 0) {
        currentStreak = 1;
        expectedDate = date;
        continue;
      }
      if (currentStreak > 0 && tokens > 0 && date) {
        const gap = Math.round((Date.parse(`${expectedDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
        if (gap === 1) {
          currentStreak += 1;
          expectedDate = date;
          continue;
        }
        break;
      }
      if (tokens <= 0) break;
    }

    const favoriteModel = Object.entries(modelTotals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
      || String(base.favoriteModel || '');

    return {
      totalTokens: Math.max(totalTokens, n(base.totalTokens)),
      totalCost: Math.max(totalCost, n(base.totalCost)),
      unpricedTokens: Math.max(unpricedTokens, n(base.unpricedTokens)),
      activeDays: base.activeDays != null ? n(base.activeDays) : activeDays,
      currentStreak: base.currentStreak != null ? n(base.currentStreak) : currentStreak,
      activeTimeMs: base.activeTimeMs != null ? n(base.activeTimeMs) : activeTimeMs,
      peakDayTokens: Math.max(peakDayTokens, n(base.peakDayTokens)),
      favoriteModel,
      messages: Math.max(messages, n(base.messages))
    };
  }

  /**
   * Builds the Fleet model across all synced or history-bearing devices.
   * `isFleetMode` is true only when more than 1 machine is known, keeping single-device setups pure.
   *
   * @param {{
   *   stats?: any,
   *   history?: any,
   *   periodKey?: string,
   *   liveRatesByDevice?: Record<string, number>,
   *   settings?: any,
   *   nowMs?: number
   * }} options
   */
  function buildFleetModel(options = {}) {
    const stats = options.stats || null;
    const history = options.history || null;
    const periodKey = options.periodKey || 'today';
    const settings = options.settings || {};
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const liveRatesByDevice = options.liveRatesByDevice || {};

    /** @type {Map<string, any>} */
    const deviceMap = new Map();
    for (const d of stats?.devices || []) {
      const id = String(d?.deviceId || d?.id || '').trim();
      if (id) deviceMap.set(id, d);
    }

    /** @type {Map<string, any>} */
    const historyMap = new Map();
    for (const h of history?.deviceHistories || []) {
      const id = String(h?.deviceId || h?.id || '').trim();
      if (id) historyMap.set(id, h);
    }

    const ids = new Set([...deviceMap.keys(), ...historyMap.keys()]);
    const localId = String(stats?.localDeviceId || settings?.deviceId || '').trim();

    const livePeriod = stats?.periods?.[periodKey] || stats?.periods?.today || stats?.periods?.month || null;
    /** @type {Map<string, any[]>} */
    const sessionsByDevice = new Map();
    for (const session of Object.values(livePeriod?.sessions || {})) {
      const devId = String(session?.sourceDevice?.deviceId || '').trim();
      if (!devId) continue;
      const list = sessionsByDevice.get(devId) || [];
      list.push(session);
      sessionsByDevice.set(devId, list);
    }

    const machinesRaw = Array.from(ids).map((deviceId) => {
      const device = deviceMap.get(deviceId) || {};
      const devHistory = historyMap.get(deviceId) || null;
      const mergedDevice = { ...devHistory, ...device, deviceId };
      const devDaily = devHistory?.history?.daily || [];
      const resolvedPeriod = resolvePeriodData(mergedDevice, devDaily, periodKey, { locale: settings?.locale });
      const todayPeriod = resolvePeriodData(mergedDevice, devDaily, 'today', { locale: settings?.locale });
      const tokens = Math.max(0, n(resolvedPeriod?.totalTokens));
      const cost = Math.max(0, n(resolvedPeriod?.costUsd ?? resolvedPeriod?.totalCost));
      const unpricedTokens = Math.max(0, n(resolvedPeriod?.unpricedTokens));
      const devSessions = sessionsByDevice.get(deviceId) || [];
      let runningCount = 0;
      let activeWorkspace = '';
      let newestTs = 0;

      for (const s of devSessions) {
        const state = sessionLive?.sessionActivityState?.(s, nowMs) || 'idle';
        if (state === 'running' || state === 'waiting') runningCount += 1;
        const ts = Date.parse(String(s?.lastUsedAt || s?.updatedAt || '')) || 0;
        const label = String(s?.projectLabel || s?.title || '').trim();
        if (label && (ts >= newestTs || !activeWorkspace)) {
          newestTs = ts;
          activeWorkspace = label;
        }
      }

      const clients = foldClientNumbers(resolvedPeriod?.clients);
      const topClients = Object.entries(clients)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([id, value]) => ({
          id,
          label: clientDisplayLabel(id),
          tokens: value,
          color: clientColor(id)
        }));

      const rawKind = deviceBreakdown?.deviceLabel
        ? (settings?.deviceIconOverrides?.[settings?.deviceIconScope || 'local']?.[deviceId] || mergedDevice.deviceKind || 'computer')
        : (mergedDevice.deviceKind || 'computer');
      const normalizedKind = deviceKindApi?.normalizeDeviceKind?.(rawKind) || 'computer';
      const iconKind = normalizedKind === 'computer' ? 'desktop' : normalizedKind;

      return {
        deviceId,
        name: deviceBreakdown?.deviceLabel?.(mergedDevice) || deviceId,
        platformLabel: deviceBreakdown?.devicePlatformLabel?.(mergedDevice.platform, mergedDevice.osName, mergedDevice.osVersion) || '',
        deviceKind: iconKind,
        isLocal: Boolean((localId && deviceId === localId) || ids.size === 1 || mergedDevice.isLocal === true),
        stale: mergedDevice.stale === true,
        online: mergedDevice.stale !== true && ids.size > 0,
        updatedAt: mergedDevice.updatedAt || '',
        tokens,
        cost,
        unpricedTokens,
        share: 0,
        liveTokPerSec: Math.max(0, n(liveRatesByDevice[deviceId])),
        activeSessionCount: runningCount,
        sessionCount: devSessions.length,
        activeWorkspace,
        topClients,
        periodData: resolvedPeriod,
        todayPeriod,
        historyAvailable: devHistory?.historyAvailable === true || devDaily.length > 0,
        history: devHistory?.history || null
      };
    });

    const fleetPeriodTokens = machinesRaw.reduce((sum, m) => sum + m.tokens, 0);
    const fleetCost = machinesRaw.reduce((sum, m) => sum + m.cost, 0);
    const denominator = fleetPeriodTokens > 0 ? fleetPeriodTokens : 1;

    const machines = machinesRaw
      .map((m) => ({ ...m, share: fleetPeriodTokens > 0 ? m.tokens / denominator : 0 }))
      .sort((a, b) =>
        b.activeSessionCount - a.activeSessionCount
        || b.tokens - a.tokens
        || Number(b.isLocal) - Number(a.isLocal)
        || a.name.localeCompare(b.name));

    return {
      isFleetMode: machines.length > 1,
      machines,
      fleetTotals: {
        tokens: fleetPeriodTokens,
        cost: fleetCost,
        onlineCount: machines.filter((m) => m.online).length,
        activeSessions: machines.reduce((sum, m) => sum + m.activeSessionCount, 0)
      }
    };
  }

  /**
   * Returns history scoped to `selectedDeviceId` (`'all'` returns aggregate history).
   *
   * @param {any} history
   * @param {string} [selectedDeviceId]
   */
  function selectScopedHistory(history, selectedDeviceId = 'all') {
    const empty = { daily: [], monthly: [], summary: summarizeDaily([], null) };
    if (!history || typeof history !== 'object') return empty;
    if (!selectedDeviceId || selectedDeviceId === 'all') {
      return {
        daily: Array.isArray(history.daily) ? history.daily : [],
        monthly: Array.isArray(history.monthly) ? history.monthly : [],
        summary: summarizeDaily(history.daily || [], history.summary),
        deviceHistories: history.deviceHistories
      };
    }

    const match = (history.deviceHistories || []).find(
      /** @param {any} entry */
      (entry) => String(entry?.deviceId || '').trim() === selectedDeviceId
    );
    if (!match || !match.history) return empty;
    const devDaily = Array.isArray(match.history.daily) ? match.history.daily : [];
    const devMonthly = Array.isArray(match.history.monthly) ? match.history.monthly : [];
    return {
      daily: devDaily,
      monthly: devMonthly,
      summary: summarizeDaily(devDaily, match.history.summary)
    };
  }

  /**
   * Fail-closed Token Anatomy breakdown (`cacheRead`, `cacheWrite`, `cacheMiss`, `output`, `unclassified`).
   * Never absorbs `unclassifiedTokens` into cache-miss/prompt input.
   *
   * @param {any} periodData
   * @param {any[]} [dailyFallback]
   */
  function computeTokenAnatomy(periodData, dailyFallback = []) {
    let totalTokens = Math.max(0, n(periodData?.totalTokens));
    let cacheRead = Math.max(0, n(periodData?.cacheReadTokens));
    let cacheWrite = Math.max(0, n(periodData?.cacheWriteTokens));
    let output = Math.max(0, n(periodData?.outputTokens));
    let unclassified = Math.max(0, n(periodData?.unclassifiedTokens));

    if (!periodData && Array.isArray(dailyFallback) && dailyFallback.length > 0) {
      for (const d of dailyFallback) {
        totalTokens += Math.max(0, n(d?.tokens));
        output += Math.max(0, n(d?.outputTokens));
        cacheRead += Math.max(0, n(d?.cacheReadTokens));
        cacheWrite += Math.max(0, n(d?.cacheWriteTokens));
        unclassified += Math.max(0, n(d?.unclassifiedTokens));
      }
      if (cacheRead === 0 && cacheWrite === 0 && output === 0 && totalTokens > 0) {
        unclassified = totalTokens;
      }
    } else if (periodData && periodData.capabilities?.tokenComponents === false) {
      unclassified = Math.max(unclassified, Math.max(0, totalTokens - cacheRead - cacheWrite - output));
    }

    const accounted = cacheRead + cacheWrite + output + unclassified;
    const explicitInput = periodData?.inputTokens != null ? Math.max(0, n(periodData.inputTokens)) : null;
    const cacheMiss = explicitInput != null
      ? Math.max(0, explicitInput - cacheRead - cacheWrite)
      : Math.max(0, totalTokens - accounted);

    const denominator = totalTokens > 0 ? totalTokens : Math.max(1, cacheRead + cacheWrite + cacheMiss + output + unclassified);
    const cachePromptDenominator = cacheRead + cacheMiss;
    const cacheHitRate = cachePromptDenominator > 0 ? Math.max(0, Math.min(1, cacheRead / cachePromptDenominator)) : null;

    const rawSegments = [
      { key: 'cacheRead', labelKey: 'dashboard.tooltip.inputCacheHit', tokens: cacheRead },
      { key: 'cacheWrite', labelKey: 'dashboard.anatomy.cacheWrite', tokens: cacheWrite },
      { key: 'cacheMiss', labelKey: 'dashboard.tooltip.inputCacheMiss', tokens: cacheMiss },
      { key: 'output', labelKey: 'dashboard.tooltip.output', tokens: output },
      { key: 'unclassified', labelKey: 'dashboard.tooltip.unclassified', tokens: unclassified }
    ];

    const segments = rawSegments
      .filter((s) => s.tokens > 0)
      .map((s) => ({ ...s, share: s.tokens / denominator }));

    return {
      totalTokens,
      cacheRead,
      cacheWrite,
      cacheMiss,
      output,
      unclassified,
      cacheHitRate,
      segments
    };
  }

  /**
   * Builds ranked tool (client) breakdown rows for a period (or daily series fallback).
   *
   * @param {any} periodData
   * @param {any[]} dailyFallback
   * @param {number} totalTokens
   */
  function buildToolRows(periodData, dailyFallback, totalTokens) {
    /** @type {Record<string, { tokens: number, cost: number, unpricedTokens: number }>} */
    const map = {};
    if (periodData?.clients) {
      const foldedTokens = foldClientNumbers(periodData.clients);
      const foldedCosts = foldClientNumbers(periodData.clientCosts);
      const foldedUnpriced = foldClientNumbers(periodData.clientUnpricedTokens);
      for (const [id, tokens] of Object.entries(foldedTokens)) {
        if (tokens <= 0) continue;
        map[id] = {
          tokens,
          cost: Math.max(0, n(foldedCosts[id])),
          unpricedTokens: Math.max(0, n(foldedUnpriced[id]))
        };
      }
    } else {
      for (const d of dailyFallback || []) {
        for (const [rawId, v] of Object.entries(d?.perClient || {})) {
          const id = canonicalClientKey(rawId);
          const tokens = Math.max(0, n(/** @type {any} */ (v)?.tokens));
          if (!id || tokens <= 0) continue;
          if (!map[id]) map[id] = { tokens: 0, cost: 0, unpricedTokens: 0 };
          map[id].tokens += tokens;
          map[id].cost += Math.max(0, n(/** @type {any} */ (v)?.cost));
          map[id].unpricedTokens += Math.max(0, n(/** @type {any} */ (v)?.unpricedTokens));
        }
      }
    }

    const rows = Object.entries(map)
      .map(([id, data]) => ({
        id,
        label: clientDisplayLabel(id),
        tokens: data.tokens,
        cost: data.cost,
        unpricedTokens: data.unpricedTokens,
        color: clientColor(id),
        iconClass: hasBrandMask(id) ? `row-icon-${id}` : '',
        models: Object.entries(periodData?.clientModels?.[id] || {})
          .map(([m, t]) => ({ id: m, tokens: Math.max(0, n(t)), color: modelColor(m) }))
          .filter((m) => m.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)
      }))
      .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));

    const maxTokens = rows[0]?.tokens || 1;
    const sumTokens = totalTokens > 0 ? totalTokens : rows.reduce((s, r) => s + r.tokens, 0) || 1;
    return rows.map((row) => ({
      ...row,
      share: row.tokens / sumTokens,
      relWidth: row.tokens / maxTokens
    }));
  }

  /**
   * Builds ranked model breakdown rows for a period (or daily series fallback).
   *
   * @param {any} periodData
   * @param {any[]} dailyFallback
   * @param {number} totalTokens
   */
  function buildModelRows(periodData, dailyFallback, totalTokens) {
    /** @type {Record<string, { tokens: number, cost: number, unpricedTokens: number }>} */
    const map = {};
    if (periodData?.models) {
      for (const [model, rawTokens] of Object.entries(periodData.models)) {
        const tokens = Math.max(0, n(rawTokens));
        if (!model || tokens <= 0) continue;
        map[model] = {
          tokens,
          cost: Math.max(0, n(periodData.modelCosts?.[model])),
          unpricedTokens: Math.max(0, n(periodData.modelUnpricedTokens?.[model]))
        };
      }
    } else {
      for (const d of dailyFallback || []) {
        for (const [model, v] of Object.entries(d?.perModel || {})) {
          const tokens = Math.max(0, n(/** @type {any} */ (v)?.tokens));
          if (!model || tokens <= 0) continue;
          if (!map[model]) map[model] = { tokens: 0, cost: 0, unpricedTokens: 0 };
          map[model].tokens += tokens;
          map[model].cost += Math.max(0, n(/** @type {any} */ (v)?.cost));
          map[model].unpricedTokens += Math.max(0, n(/** @type {any} */ (v)?.unpricedTokens));
        }
      }
    }

    const rows = Object.entries(map)
      .map(([id, data]) => {
        const vendor = usageCharts?.modelVendorFor?.(id) || '';
        return {
          id,
          label: id,
          vendor,
          tokens: data.tokens,
          cost: data.cost,
          unpricedTokens: data.unpricedTokens,
          color: modelColor(id),
          iconClass: vendor && hasBrandMask(vendor) ? `row-icon-${vendor} model-icon` : ''
        };
      })
      .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));

    const maxTokens = rows[0]?.tokens || 1;
    const sumTokens = totalTokens > 0 ? totalTokens : rows.reduce((s, r) => s + r.tokens, 0) || 1;
    return rows.map((row) => ({
      ...row,
      share: row.tokens / sumTokens,
      relWidth: row.tokens / maxTokens
    }));
  }

  /**
   * Projects live quotas from `stats.limits.providers` using `homeOverview` and `balanceDisplay`.
   * Respects `AGENTS.md` Balance Quotas tripwire (`windows[].metric === 'credits'`, never a provider whitelist).
   *
   * @param {any} stats
   * @param {any} settings
   * @param {number} [nowMs]
   */
  function buildQuotaAccounts(stats, settings, nowMs = Date.now()) {
    const providers = stats?.limits?.providers;
    if (!Array.isArray(providers) || providers.length === 0) return [];
    const catalog = limitProvidersApi?.LIMIT_PROVIDER_CATALOG || [];
    const showUsed = Boolean(settings?.showLimitUsed);

    const enabled = settings?.limitsEnabled === false
      ? []
      : Array.isArray(settings?.limitProviders) && settings.limitProviders.length > 0
        ? settings.limitProviders
        : catalog.map(/** @param {any} p */ (p) => p.id);

    const colors = { ...(usageCharts?.clientColors || {}), factory: usageCharts?.clientColors?.droid || '#888888' };
    const maskEmail = settings?.maskLimitAccountEmails === true;
    const showProviderTitle = settings?.showHomeLimitProviderNames === true || settings?.showToolIcons === false;
    /** @param {unknown} value */
    const formatPlanDisplayLabel = (value) => {
      const label = String(value || '').trim();
      if (!label || label.includes('@')) return '';
      return label.replace(/^[a-z]/, (letter) => letter.toUpperCase());
    };
    /** @param {string} providerId @param {any} win */
    const isWindowHidden = (providerId, win) => {
      const hidden = settings?.limitProviderHiddenItems?.[providerId];
      if (!Array.isArray(hidden)) return false;
      const winId = String(win?.id || win?.kind || win?.label || '').toLowerCase();
      return hidden.includes(winId);
    };

    const accounts = homeOverviewApi?.homeLimitAccountsForProviders
      ? homeOverviewApi.homeLimitAccountsForProviders({
          providers,
          providerOptions: catalog.length > 0
            ? catalog
            : providers.map((/** @type {any} */ p) => ({ id: p.provider, label: p.provider })),
          enabledProviderIds: enabled,
          colors,
          limit: 24,
          sort: 'remaining',
          isWindowHidden,
          compact: false,
          accountPlan: (/** @type {any} */ provider) => {
            const explicit = String(provider?.planLabel || provider?.plan || '').trim();
            if (explicit) return formatPlanDisplayLabel(explicit);
            const legacy = String(provider?.accountLabel || '').trim();
            return legacy && !legacy.includes('@') ? formatPlanDisplayLabel(legacy) : '';
          },
          accountName: (/** @type {any} */ provider, /** @type {number} */ index, /** @type {any[]} */ providerEntries) => {
            const id = String(provider?.provider || '').trim().toLowerCase();
            const option = catalog.find((/** @type {any} */ entry) => String(entry?.id || '').toLowerCase() === id);
            const label = option?.label || String(provider?.provider || id);
            if (!Array.isArray(providerEntries) || providerEntries.length <= 1) return label;
            const accountTitle = accountIdentityApi?.accountTitleLabel?.(provider, providerEntries, { maskEmail, index })
              || String(provider?.accountLabel || provider?.accountName || provider?.label || provider?.region || '').trim();
            if (!accountTitle) return label;
            return showProviderTitle ? `${label} · ${accountTitle}` : accountTitle;
          }
        })
      : [];

    return accounts.map(/** @param {any} account */ (account) => {
      const providerId = String(account.providerId || '').toLowerCase();
      const iconId = String(account.iconId || providerId || '').toLowerCase();
      const iconClass = hasBrandMask(iconId) ? `home-list-mark row-icon row-icon-${iconId}` : '';
      const rawWindows = Array.isArray(account.windows) ? account.windows : [];
      const windows = rawWindows.map(/** @param {any} win */ (win) => {
        const isCredits = balanceDisplay ? balanceDisplay.isCreditsWindow(win) : win.metric === 'credits';
        const remainingPct = win.remainingPercent == null ? null : Math.max(0, Math.min(100, Number(win.remainingPercent)));
        const usedPct = remainingPct == null ? null : 100 - remainingPct;
        const fillPct = remainingPct == null
          ? 0
          : showUsed && !isCredits && !win.value
            ? usedPct
            : remainingPct;
        const paceRaw = homeOverviewApi?.limitWindowPaceRemainingPercent?.(win, nowMs) ?? null;
        const pacePct = paceRaw == null ? null : (showUsed ? 100 - paceRaw : paceRaw);
        const creditsText = isCredits && win.remaining != null && balanceDisplay?.formatMoney
          ? balanceDisplay.formatMoney(win.remaining, win.currency)
          : '';
        const exhausted = remainingPct != null && remainingPct <= 0;
        const low = remainingPct != null && remainingPct > 0 && remainingPct < 20;
        const untouched = remainingPct != null && remainingPct >= 99.5;
        return {
          ...win,
          isCredits,
          showUsed,
          remainingPercent: remainingPct,
          fillPercent: fillPct,
          pacePercent: pacePct,
          creditsText,
          low,
          exhausted,
          untouched
        };
      });
      return {
        ...account,
        iconClass,
        windows
      };
    });
  }

  /**
   * Builds live and recent sessions for the selected period & device scope.
   *
   * @param {{
   *   stats?: any,
   *   periodData?: any,
   *   periodKey?: string,
   *   selectedDeviceId?: string,
   *   settings?: any,
   *   nowMs?: number
   * }} options
   */
  function buildSessionList(options = {}) {
    const stats = options.stats || null;
    const periodKey = options.periodKey || 'today';
    const selectedDeviceId = options.selectedDeviceId || 'all';
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const showContextUsed = options.settings?.sessionContextMetric !== 'remaining';

    const aggregatePeriod = stats?.periods?.[periodKey]
      || options.periodData
      || stats?.periods?.today
      || stats?.periods?.month
      || null;
    const rawMap = aggregatePeriod?.sessions || {};
    const nativeMap = selectedDeviceId === 'all' || selectedDeviceId === stats?.localDeviceId
      ? (stats?.nativeSessions?.[periodKey] || {})
      : {};

    /** @type {Map<string, { name: string, deviceKind: string, isLocal: boolean }>} */
    const deviceLookup = new Map();
    for (const dev of stats?.devices || []) {
      const id = String(dev?.deviceId || dev?.id || '').trim();
      if (!id) continue;
      const rawKind = options.settings?.deviceIconOverrides?.[options.settings?.deviceIconScope || 'local']?.[id]
        || dev.deviceKind
        || 'computer';
      const normalizedKind = deviceKindApi?.normalizeDeviceKind?.(rawKind) || 'computer';
      deviceLookup.set(id, {
        name: deviceBreakdown?.deviceLabel?.(dev) || id,
        deviceKind: normalizedKind === 'computer' ? 'desktop' : normalizedKind,
        isLocal: Boolean((stats?.localDeviceId && id === stats.localDeviceId) || dev.isLocal === true)
      });
    }

    /** @type {any[]} */
    const entries = [];
    const seen = new Set();
    for (const [key, session] of [...Object.entries(rawMap), ...Object.entries(nativeMap)]) {
      if (!session || typeof session !== 'object' || seen.has(key)) continue;
      seen.add(key);
      const devId = String(session?.sourceDevice?.deviceId || '').trim();
      if (selectedDeviceId !== 'all' && devId !== selectedDeviceId) continue;

      const client = canonicalClientKey(session.client || key.split(':')[0] || '');
      const activityState = sessionLive?.sessionActivityState?.(session, nowMs) || 'idle';
      const context = activityState !== 'idle'
        ? (session.context || sessionLive?.sessionContextForRow?.(session, nowMs) || null)
        : null;
      const promptCache = sessionLive?.sessionPromptCacheForRow?.(session, nowMs) || null;
      const isActive = activityState === 'running' || activityState === 'waiting';
      const ts = Date.parse(String(session.lastUsedAt || session.updatedAt || '')) || 0;
      const latestModel = String(session.latestModel || Object.keys(session.models || {})[0] || '');
      const title = String(session.title || session.name || session.projectLabel || session.sessionId || key).trim();
      const matchedDevice = devId ? deviceLookup.get(devId) : null;
      const rawSrcKind = session?.sourceDevice?.deviceKind ? deviceKindApi?.normalizeDeviceKind?.(session.sourceDevice.deviceKind) : '';
      const deviceKind = matchedDevice?.deviceKind || (rawSrcKind === 'computer' ? 'desktop' : rawSrcKind) || '';
      const deviceName = matchedDevice?.name || String(session?.sourceDevice?.name || '').trim();
      const isLocalDevice = Boolean(matchedDevice?.isLocal || (stats?.localDeviceId && devId && devId === stats.localDeviceId));

      entries.push({
        key,
        sessionId: session.sessionId || key,
        client,
        clientLabel: session.clientLabel || clientDisplayLabel(client),
        color: clientColor(client),
        iconClass: hasBrandMask(client) ? `row-icon-${client}` : '',
        title,
        projectLabel: String(session.projectLabel || '').trim(),
        latestModel,
        totalTokens: Math.max(0, n(session.totalTokens)),
        costUsd: Math.max(0, n(session.costUsd)),
        unpricedTokens: Math.max(0, n(session.unpricedTokens)),
        activityState,
        isActive,
        archived: sessionLive?.isArchivedSession?.(session) === true,
        context: context ? {
          ...context,
          displayPercent: showContextUsed ? context.percentUsed : context.percentLeft
        } : null,
        promptCache,
        subagentCount: Math.max(0, n(session.subagentCount)),
        sourceDevice: session.sourceDevice || null,
        deviceName,
        deviceKind,
        isLocalDevice,
        lastUsedAt: session.lastUsedAt || session.updatedAt || '',
        sortTime: ts,
        raw: session
      });
    }

    entries.sort((a, b) => {
      /** @param {any} s */
      const rank = (s) => (s.activityState === 'running' ? 0 : s.activityState === 'waiting' ? 1 : s.activityState === 'ended' ? 2 : 3);
      return rank(a) - rank(b)
        || b.sortTime - a.sortTime
        || b.totalTokens - a.totalTokens
        || a.title.localeCompare(b.title);
    });

    return entries;
  }

  /**
   * Builds ranked workspace/project rows for the selected period and machine scope.
   *
   * @param {{
   *   stats?: any,
   *   periodData?: any,
   *   periodKey?: string,
   *   selectedDeviceId?: string,
   *   sessions?: any[],
   *   colorFor?: (id: string) => string
   * }} options
   */
  function buildWorkspaceList(options = {}) {
    const stats = options.stats || null;
    const periodKey = options.periodKey || 'today';
    const selectedDeviceId = options.selectedDeviceId || 'all';
    const aggregatePeriod = stats?.periods?.[periodKey] || options.periodData || null;
    if (!aggregatePeriod || !projectRowsApi?.projectRowsForPeriod) return [];

    let scopedPeriod = aggregatePeriod;
    if (selectedDeviceId !== 'all') {
      const filteredSessions = Object.fromEntries(
        Object.entries(aggregatePeriod.sessions || {})
          .filter(([, s]) => String(s?.sourceDevice?.deviceId || '').trim() === selectedDeviceId)
      );
      scopedPeriod = { sessions: filteredSessions };
    }

    /** @type {Record<string, string>} */
    const clientColorsMap = {};
    for (const key of Object.keys(usageCharts?.clientColors || {})) {
      clientColorsMap[key] = options.colorFor ? options.colorFor(key) : clientColor(key);
    }

    const rows = projectRowsApi.projectRowsForPeriod(scopedPeriod, {
      clientColors: clientColorsMap,
      clientLabels: clientCatalog?.CLIENT_LABELS || {},
      modelColor,
      fallbackColors: usageCharts?.fallbackModelColors || ['#6ab4f0'],
      nativeProjects: selectedDeviceId === 'all' || selectedDeviceId === stats?.localDeviceId
        ? stats?.nativeProjects?.[periodKey]
        : undefined
    });

    /** @type {Map<string, { activeSessionCount: number, devices: Set<string> }>} */
    const metaByProject = new Map();
    const sessionSource = Array.isArray(options.sessions) && options.sessions.length > 0
      ? options.sessions
      : Object.values(scopedPeriod?.sessions || {});
    for (const s of sessionSource) {
      const labelKey = String(s?.projectLabel || '').trim().toLowerCase();
      if (!labelKey) continue;
      let meta = metaByProject.get(labelKey);
      if (!meta) {
        meta = { activeSessionCount: 0, devices: new Set() };
        metaByProject.set(labelKey, meta);
      }
      const act = s?.activityState || sessionLive?.sessionActivityState?.(s, Date.now());
      if (act === 'running' || act === 'waiting') meta.activeSessionCount += 1;
      const devName = String(s?.deviceName || s?.sourceDevice?.name || '').trim();
      if (devName) meta.devices.add(devName);
    }

    const maxTokens = rows[0]?.value || 1;
    const totalTokens = rows.reduce(/** @param {number} sum @param {any} r */ (sum, r) => sum + n(r.value), 0) || 1;
    return rows.map(/** @param {any} row */ (row) => {
      const meta = metaByProject.get(String(row.name || '').trim().toLowerCase());
      return {
        ...row,
        tokens: n(row.value),
        share: n(row.value) / totalTokens,
        relWidth: n(row.value) / maxTokens,
        activeSessionCount: meta?.activeSessionCount || 0,
        devices: meta ? Array.from(meta.devices) : []
      };
    });
  }

  /**
   * Shapes Edge Dock-style Live Velocity state (`tok/s` / `TPM`, 5-minute sparkline, and active model breakdown).
   *
   * @param {{
   *   sample?: any,
   *   rateSamples?: any[],
   *   rateMode?: 'speed' | 'burn',
   *   selectedDeviceId?: string,
   *   now?: number
   * }} options
   */
  function buildLiveVelocityModel(options = {}) {
    const sample = options.sample || null;
    const burn = options.rateMode === 'burn';
    const selectedDeviceId = String(options.selectedDeviceId || 'all').trim();
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const rateSamples = Array.isArray(options.rateSamples) ? options.rateSamples : [];
    const deviceSamples = Array.isArray(sample?.devices) ? sample.devices : [];

    const matchingDevices = selectedDeviceId !== 'all'
      ? deviceSamples.filter((/** @type {any} */ d) => String(d?.id || '') === selectedDeviceId)
      : deviceSamples;

    let speed = n(sample?.speed);
    let burnVal = n(sample?.burn);
    if (selectedDeviceId !== 'all') {
      speed = 0;
      burnVal = 0;
      for (const dev of matchingDevices) {
        for (const m of dev?.models || []) {
          speed += n(m?.speed);
          burnVal += n(m?.burn);
        }
      }
    }

    const hasSample = Boolean(sample) && (selectedDeviceId === 'all' || matchingDevices.length > 0);
    const idle = Boolean(sample?.idle);
    const primaryValue = hasSample ? (burn ? burnVal : speed) : null;
    const secondaryValue = hasSample ? (burn ? speed : burnVal) : null;

    /** @type {any[]} */
    const rawModels = [];
    for (const dev of matchingDevices) {
      for (const m of dev?.models || []) {
        const value = burn ? n(m?.burn) : n(m?.speed);
        if (!m?.model || value <= 0) continue;
        rawModels.push({
          id: String(m.model),
          deviceName: String(dev?.name || ''),
          value,
          speed: n(m?.speed),
          burn: n(m?.burn)
        });
      }
    }

    // Fold duplicate models across multiple devices when viewing All Devices.
    /** @type {Map<string, { id: string, value: number, speed: number, burn: number, deviceName: string }>} */
    const folded = new Map();
    for (const item of rawModels) {
      const existing = folded.get(item.id);
      if (existing) {
        existing.value += item.value;
        existing.speed += item.speed;
        existing.burn += item.burn;
      } else {
        folded.set(item.id, { ...item });
      }
    }

    const models = Array.from(folded.values())
      .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
      .slice(0, 4)
      .map((entry) => {
        const vendor = usageCharts?.modelVendorFor?.(entry.id) || '';
        return {
          ...entry,
          vendor,
          color: modelColor(entry.id),
          iconClass: vendor && hasBrandMask(vendor) ? `row-icon-${vendor} model-icon` : ''
        };
      });

    const chart = tokenRateApi?.liveTokenRateChart
      ? tokenRateApi.liveTokenRateChart(rateSamples, now, burn ? 'burn' : 'speed')
      : { points: [], peak: 1 };

    return {
      hasSample,
      idle,
      rateMode: /** @type {'speed' | 'burn'} */ (burn ? 'burn' : 'speed'),
      primaryValue,
      secondaryValue,
      speed,
      burn: burnVal,
      deviceCount: n(sample?.deviceCount || matchingDevices.length),
      points: Array.isArray(chart?.points) ? chart.points : [],
      models
    };
  }

  /**
   * Renders a museum-grade shallow axonometric 3D skyline SVG from a `contribHeatmap` model.
   * Zero inline `style=` attributes (CSP `style-src 'self'`).
   *
   * @param {{ cells?: any[], monthLabels?: any[], weeks?: number }} heatModel
   * @param {{
   *   monthLabel?: (m: any) => string,
   *   dayMap?: Map<string, any> | Record<string, any>,
   *   metric?: 'tokens' | 'cost' | string,
   *   uid?: string,
   *   initialHidden?: boolean
   * }} [options]
   */
  function isometricHeatmapSvg(heatModel, options = {}) {
    const cells = Array.isArray(heatModel?.cells) ? heatModel.cells.slice() : [];
    if (cells.length === 0) return '';

    /** @param {unknown} v */
    const escXml = (v) => String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    /** @param {number} v */
    const r2 = (v) => Math.round(v * 100) / 100;

    const metric = options.metric === 'tokens' ? 'tokens' : 'cost';
    const dayMap = options.dayMap || null;
    const prefix = escXml(options.uid || 'dashIso');
    const weeks = Math.max(1, Number(heatModel?.weeks) || (Math.max(...cells.map((c) => n(c.col))) + 1));

    // Shallow axonometric basis chosen so 52+ weeks × 7 days fit a tight ~3.2:1 landscape panorama.
    const UX = 11.4;
    const UY = 2.05;
    const VX = -7.6;
    const VY = 4.95;
    const S = 0.78;
    const PAD = (1 - S) / 2;
    const MIN_H = 5.5;
    const MAX_H = 44;
    const INACTIVE_H = 1.6;

    /** @param {number} col @param {number} row */
    const px = (col, row) => col * UX + row * VX;
    /** @param {number} col @param {number} row */
    const py = (col, row) => col * UY + row * VY;

    /** @param {any} c */
    const lookupValue = (c) => {
      const rec = dayMap
        ? (dayMap instanceof Map ? dayMap.get(c.date) : /** @type {Record<string, any>} */ (dayMap)[c.date])
        : null;
      const tokens = n(rec ? rec.tokens : c.tokens);
      const cost = n(rec ? rec.cost : c.cost);
      return {
        tokens,
        cost,
        val: metric === 'cost' ? cost : tokens
      };
    };

    const enriched = cells.map((c) => ({ ...c, ...lookupValue(c) }));
    const maxVal = enriched.reduce((mx, c) => Math.max(mx, c.val), 0);

    // Base plate bounds slightly expanded outside the 7xN grid.
    const bx0 = -0.35;
    const bx1 = weeks - 0.15;
    const by0 = -0.35;
    const by1 = 7.15;
    const basePts = [
      [px(bx0, by0), py(bx0, by0)],
      [px(bx1, by0), py(bx1, by0)],
      [px(bx1, by1), py(bx1, by1)],
      [px(bx0, by1), py(bx0, by1)]
    ];

    const labelRow = 7.72;
    const allXs = [...basePts.map((p) => p[0]), px(0, labelRow), px(weeks, labelRow)];
    const minX = r2(Math.min(...allXs) - 8);
    const maxX = r2(Math.max(...allXs) + 8);
    let minYBound = Math.min(...basePts.map((p) => p[1]));
    let maxYBound = Math.max(...basePts.map((p) => p[1]), py(weeks, labelRow) + 8);

    const defs = [1, 2, 3, 4].map((lvl) =>
      `<linearGradient id="${prefix}-top-${lvl}" x1="0%" y1="0%" x2="100%" y2="100%">`
      + `<stop offset="0%" class="iso-stop-top-a lvl-${lvl}"></stop>`
      + `<stop offset="100%" class="iso-stop-top-b lvl-${lvl}"></stop>`
      + `</linearGradient>`
      + `<linearGradient id="${prefix}-left-${lvl}" x1="0%" y1="0%" x2="0%" y2="100%">`
      + `<stop offset="0%" class="iso-stop-left-a lvl-${lvl}"></stop>`
      + `<stop offset="100%" class="iso-stop-left-b lvl-${lvl}"></stop>`
      + `</linearGradient>`
      + `<linearGradient id="${prefix}-right-${lvl}" x1="0%" y1="0%" x2="0%" y2="100%">`
      + `<stop offset="0%" class="iso-stop-right-a lvl-${lvl}"></stop>`
      + `<stop offset="100%" class="iso-stop-right-b lvl-${lvl}"></stop>`
      + `</linearGradient>`
    ).join('');

    const plateSvg = `<polygon class="iso-base-plate" points="${basePts.map((p) => `${r2(p[0])},${r2(p[1])}`).join(' ')}"></polygon>`;

    const gridLines = [];
    for (let w = 0; w <= weeks; w += 4) {
      gridLines.push(
        `<line class="iso-grid-line" x1="${r2(px(w, 0))}" y1="${r2(py(w, 0))}" x2="${r2(px(w, 7))}" y2="${r2(py(w, 7))}"></line>`
      );
    }

    // Painter's order: back-to-front so front columns cleanly occlude back columns.
    enriched.sort((a, b) => a.col - b.col || a.row - b.row);
    const hiddenAttr = options.initialHidden ? ' data-motion-hidden="true"' : '';

    const columnsSvg = enriched.map((c) => {
      const level = Math.max(0, Math.min(4, Math.round(n(c.intensity))));
      const active = level > 0 || c.val > 0;
      const ratio = active
        ? (maxVal > 0 && c.val > 0 ? Math.min(1, c.val / maxVal) : Math.max(0.15, level / 4))
        : 0;
      const h = active ? MIN_H + Math.pow(ratio, 0.65) * (MAX_H - MIN_H) : INACTIVE_H;

      const c0 = c.col + PAD;
      const c1 = c.col + 1 - PAD;
      const ro0 = c.row + PAD;
      const ro1 = c.row + 1 - PAD;

      const bx = [px(c0, ro0), px(c1, ro0), px(c1, ro1), px(c0, ro1)];
      const by = [py(c0, ro0), py(c1, ro0), py(c1, ro1), py(c0, ro1)];
      minYBound = Math.min(minYBound, Math.min(...by) - h - 4);
      /** @param {number} i */
      const bPt = (i) => `${r2(bx[i])},${r2(by[i])}`;
      /** @param {number} i */
      const tPt = (i) => `${r2(bx[i])},${r2(by[i] - h)}`;

      const leftFace = level > 0
        ? `<polygon class="iso-face-left lvl-${level}" fill="url(#${prefix}-left-${level})" points="${tPt(3)} ${tPt(2)} ${bPt(2)} ${bPt(3)}"></polygon>`
        : `<polygon class="iso-face-left lvl-0" points="${tPt(3)} ${tPt(2)} ${bPt(2)} ${bPt(3)}"></polygon>`;
      const rightFace = level > 0
        ? `<polygon class="iso-face-right lvl-${level}" fill="url(#${prefix}-right-${level})" points="${tPt(2)} ${tPt(1)} ${bPt(1)} ${bPt(2)}"></polygon>`
        : `<polygon class="iso-face-right lvl-0" points="${tPt(2)} ${tPt(1)} ${bPt(1)} ${bPt(2)}"></polygon>`;
      const topFace = level > 0
        ? `<polygon class="iso-face-top lvl-${level}" fill="url(#${prefix}-top-${level})" points="${tPt(0)} ${tPt(1)} ${tPt(2)} ${tPt(3)}"></polygon>`
        : `<polygon class="iso-face-top lvl-0" points="${tPt(0)} ${tPt(1)} ${tPt(2)} ${tPt(3)}"></polygon>`;
      const rim = level >= 3
        ? `<polyline class="iso-cap-rim lvl-${level}" points="${tPt(3)} ${tPt(2)} ${tPt(1)}"></polyline>`
        : '';

      return `<g class="iso-col lvl-${level}" data-d="${escXml(c.date)}" data-col="${c.col}" data-row="${c.row}" data-lvl="${level}" data-t="${Math.round(c.tokens)}" data-cost="${r2(c.cost)}"${hiddenAttr}>`
        + leftFace + rightFace + topFace + rim
        + `</g>`;
    }).join('');

    let lastLabelX = -Infinity;
    const monthsSvg = (heatModel?.monthLabels || []).map((m) => {
      const lx = px(n(m.col) + 0.5, labelRow);
      if (lx - lastLabelX < 28) return '';
      lastLabelX = lx;
      const ly = py(n(m.col) + 0.5, labelRow);
      maxYBound = Math.max(maxYBound, ly + 6);
      const label = options.monthLabel ? options.monthLabel(m) : String(m.label || '');
      return `<text class="heat-month iso-month" x="${r2(lx)}" y="${r2(ly)}" text-anchor="start">${escXml(label)}</text>`;
    }).join('');

    const minY = r2(minYBound - 5);
    const maxY = r2(maxYBound + 4);
    const vbWidth = r2(maxX - minX);
    const vbHeight = r2(maxY - minY);

    return `<svg class="dash-heatmap dash-heatmap--iso" viewBox="${minX} ${minY} ${vbWidth} ${vbHeight}" preserveAspectRatio="xMidYMid meet" aria-hidden="false">`
      + `<defs>${defs}</defs>`
      + `<g class="iso-plate-layer">${plateSvg}${gridLines.join('')}</g>`
      + `<g class="iso-towers-layer">${columnsSvg}</g>`
      + `<g class="iso-months-layer">${monthsSvg}</g>`
      + `</svg>`;
  }

  /**
   * Builds a 3-tier Live Neural Flow graph linking Devices -> Workspaces/Tools -> Sessions/Models.
   * Uses genuine session topology when sessions exist in scope and falls back cleanly to Tools -> Models.
   *
   * @param {{
   *   fleet?: any,
   *   activeMachine?: any,
   *   hero?: any,
   *   tools?: any[],
   *   models?: any[],
   *   sessions?: any[],
   *   workspaces?: any[]
   * }} [overview]
   * @param {{
   *   maxDevices?: number,
   *   maxHubs?: number,
   *   maxEndpoints?: number
   * }} [options]
   */
  function buildTopologyGraph(overview = {}, options = {}) {
    const fleet = overview?.fleet || {};
    const hero = overview?.hero || {};
    const tools = Array.isArray(overview?.tools) ? overview.tools : [];
    const models = Array.isArray(overview?.models) ? overview.models : [];
    const sessions = Array.isArray(overview?.sessions) ? overview.sessions : [];
    const workspaces = Array.isArray(overview?.workspaces) ? overview.workspaces : [];

    /** @param {unknown} val @param {number} fallback */
    const clampCap = (val, fallback) => {
      const num = Math.floor(Number(val));
      return Number.isFinite(num) && num > 0 ? num : fallback;
    };
    const maxDevices = clampCap(options?.maxDevices, 32);
    const maxHubs = clampCap(options?.maxHubs, 32);
    const maxEndpoints = clampCap(options?.maxEndpoints, 40);

    /** @type {any[]} */
    const candidateMachines = overview?.activeMachine
      ? [overview.activeMachine]
      : (Array.isArray(fleet?.machines) ? fleet.machines : []);

    /** @type {any[]} */
    let devices = candidateMachines
      .slice()
      .sort((/** @type {any} */ a, /** @type {any} */ b) =>
        (n(b?.activeSessionCount) - n(a?.activeSessionCount))
        || (n(b?.liveTokPerSec) - n(a?.liveTokPerSec))
        || (n(b?.tokens) - n(a?.tokens))
        || String(a?.name || '').localeCompare(String(b?.name || ''))
      )
      .slice(0, maxDevices)
      .map((/** @type {any} */ m) => ({
        id: String(m.deviceId || 'local'),
        deviceId: String(m.deviceId || 'local'),
        name: String(m.name || m.deviceId || 'Device'),
        deviceKind: String(m.deviceKind || 'desktop'),
        isLocal: Boolean(m.isLocal),
        online: m.online !== false && m.stale !== true,
        stale: m.stale === true,
        tokens: Math.max(0, n(m.tokens)),
        cost: Math.max(0, n(m.cost)),
        unpricedTokens: Math.max(0, n(m.unpricedTokens)),
        share: Math.max(0, n(m.share)),
        liveTokPerSec: Math.max(0, n(m.liveTokPerSec)),
        activeSessionCount: Math.max(0, n(m.activeSessionCount)),
        activeWorkspace: String(m.activeWorkspace || ''),
        topClients: Array.isArray(m.topClients) ? m.topClients : [],
        raw: m
      }));

    if (devices.length === 0 && (n(hero.tokens) > 0 || sessions.length > 0 || tools.length > 0)) {
      devices = [{
        id: 'local',
        deviceId: 'local',
        name: 'Local',
        deviceKind: 'desktop',
        isLocal: true,
        online: true,
        stale: false,
        tokens: Math.max(0, n(hero.tokens)),
        cost: Math.max(0, n(hero.cost)),
        unpricedTokens: Math.max(0, n(hero.unpricedTokens)),
        share: 1,
        liveTokPerSec: Math.max(0, n(hero.liveTokPerSec)),
        activeSessionCount: sessions.filter((s) => s.isActive).length,
        activeWorkspace: String(workspaces[0]?.name || ''),
        topClients: tools.slice(0, 3),
        raw: null
      }];
    }

    const totalDevices = candidateMachines.length || devices.length;

    /** @type {Map<string, any>} */
    const deviceById = new Map(devices.map((d) => [d.id, d]));
    const fallbackDeviceId = devices.find((d) => d.isLocal)?.id || devices[0]?.id || '';
    /** @param {string | undefined} rawId */
    const resolveDeviceId = (rawId) => {
      const id = String(rawId || '').trim();
      if (!id) return fallbackDeviceId;
      return deviceById.has(id) ? id : '';
    };

    if (devices.length === 0) {
      return {
        mode: 'sessions',
        devices: [],
        hubs: [],
        endpoints: [],
        devToHub: [],
        hubToEnd: [],
        counts: { devices: 0, hubs: 0, endpoints: 0, activeEdges: 0 },
        totals: { devices: 0, hubs: 0, endpoints: 0 },
        overflow: { devices: 0, hubs: 0, endpoints: 0 }
      };
    }

    if (sessions.length > 0) {
      /** @type {Map<string, any>} */
      const wsLookup = new Map();
      for (const ws of workspaces) {
        const nameKey = String(ws?.name || '').trim().toLowerCase();
        if (nameKey && !wsLookup.has(nameKey)) wsLookup.set(nameKey, ws);
      }

      /** @param {any} s */
      const sessionHubKey = (s) => {
        const label = String(s?.projectLabel || '').trim();
        return label ? `ws:${label.toLowerCase()}` : 'ws:__general';
      };

      // Rank workspace hubs across all sessions/workspaces in scope by live activity then volume.
      /** @type {Map<string, any>} */
      const candidateHubs = new Map();
      for (const s of sessions) {
        const hubId = sessionHubKey(s);
        const label = String(s?.projectLabel || '').trim();
        const ws = label ? wsLookup.get(label.toLowerCase()) : null;
        let hub = candidateHubs.get(hubId);
        if (!hub) {
          hub = {
            id: hubId,
            name: ws?.name || label || '',
            isGeneral: !label,
            tokens: ws ? n(ws.tokens) : 0,
            cost: ws ? n(ws.cost) : 0,
            unpricedTokens: ws ? n(ws.unpricedTokens) : 0,
            activeSessionCount: ws ? n(ws.activeSessionCount) : 0,
            barBackground: String(ws?.barBackground || ''),
            clients: Array.isArray(ws?.clients) ? ws.clients : [],
            color: s.color || '#6ab4f0',
            sessionTokens: 0,
            activeCount: 0,
            raw: ws || null
          };
          candidateHubs.set(hubId, hub);
        }
        hub.sessionTokens += Math.max(0, n(s.totalTokens));
        if (s.isActive) hub.activeCount += 1;
        if (!ws) {
          hub.tokens += Math.max(0, n(s.totalTokens));
          hub.cost += Math.max(0, n(s.costUsd));
        }
        if (!ws && s.isActive) hub.activeSessionCount += 1;
        if (s.clientLabel && !hub.clients.includes(s.clientLabel)) {
          hub.clients = [...hub.clients, s.clientLabel];
        }
      }

      // Include every ranked workspace even if its sessions fell outside the visible slice.
      for (const ws of workspaces) {
        const label = String(ws?.name || '').trim();
        if (!label) continue;
        const hubId = `ws:${label.toLowerCase()}`;
        if (!candidateHubs.has(hubId)) {
          candidateHubs.set(hubId, {
            id: hubId,
            name: label,
            isGeneral: false,
            tokens: n(ws.tokens),
            cost: n(ws.cost),
            unpricedTokens: n(ws.unpricedTokens),
            activeSessionCount: n(ws.activeSessionCount),
            barBackground: String(ws.barBackground || ''),
            clients: Array.isArray(ws.clients) ? ws.clients : [],
            color: '#6ab4f0',
            sessionTokens: 0,
            activeCount: 0,
            raw: ws
          });
        }
      }

      const sortedHubs = Array.from(candidateHubs.values())
        .sort((a, b) =>
          (b.activeCount - a.activeCount)
          || (b.activeSessionCount - a.activeSessionCount)
          || (b.tokens - a.tokens)
          || (b.sessionTokens - a.sessionTokens)
        );
      const hubs = sortedHubs.slice(0, maxHubs);
      const visibleHubSet = new Set(hubs.map((h) => h.id));

      const endpoints = sessions
        .filter((s) => visibleHubSet.has(sessionHubKey(s)))
        .slice(0, maxEndpoints)
        .map((s) => ({
          id: String(s.key),
          hubId: sessionHubKey(s),
          deviceId: resolveDeviceId(s.sourceDevice?.deviceId),
          title: String(s.title || s.sessionId || s.key),
          client: String(s.client || ''),
          clientLabel: String(s.clientLabel || ''),
          projectLabel: String(s.projectLabel || ''),
          latestModel: String(s.latestModel || ''),
          iconClass: String(s.iconClass || ''),
          color: String(s.color || '#6ab4f0'),
          totalTokens: Math.max(0, n(s.totalTokens)),
          costUsd: Math.max(0, n(s.costUsd)),
          unpricedTokens: Math.max(0, n(s.unpricedTokens)),
          activityState: String(s.activityState || 'idle'),
          isActive: Boolean(s.isActive),
          context: s.context || null,
          subagentCount: Math.max(0, n(s.subagentCount)),
          deviceName: String(s.deviceName || s.sourceDevice?.name || ''),
          raw: s
        }));

      const totalEndTokens = endpoints.reduce((sum, ep) => sum + ep.totalTokens, 0) || 1;

      /** @type {Map<string, any>} */
      const devToHubMap = new Map();
      for (const ep of endpoints) {
        if (!ep.deviceId || !ep.hubId) continue;
        const edgeKey = `${ep.deviceId}->${ep.hubId}`;
        let edge = devToHubMap.get(edgeKey);
        if (!edge) {
          const dev = deviceById.get(ep.deviceId);
          edge = {
            id: `d2h:${edgeKey}`,
            from: ep.deviceId,
            to: ep.hubId,
            tokens: 0,
            share: 0,
            active: false,
            liveRate: dev ? n(dev.liveTokPerSec) : 0,
            color: ep.color,
            sessionCount: 0
          };
          devToHubMap.set(edgeKey, edge);
        }
        edge.tokens += ep.totalTokens;
        edge.sessionCount += 1;
        if (ep.isActive) {
          edge.active = true;
          edge.color = ep.color;
        }
      }

      // Connect devices directly referenced by a workspace even if no session endpoint matched it.
      for (const hub of hubs) {
        const rawDevices = Array.isArray(hub.raw?.devices) ? hub.raw.devices : [];
        for (const devName of rawDevices) {
          const matchedDev = devices.find((d) => d.name === devName);
          if (!matchedDev) continue;
          const edgeKey = `${matchedDev.id}->${hub.id}`;
          if (!devToHubMap.has(edgeKey)) {
            devToHubMap.set(edgeKey, {
              id: `d2h:${edgeKey}`,
              from: matchedDev.id,
              to: hub.id,
              tokens: Math.round(hub.tokens / Math.max(1, rawDevices.length)),
              share: 0,
              active: hub.activeSessionCount > 0 && matchedDev.liveTokPerSec > 0,
              liveRate: n(matchedDev.liveTokPerSec),
              color: hub.color,
              sessionCount: 0
            });
          }
        }
      }

      const devToHub = Array.from(devToHubMap.values());
      const maxD2H = devToHub.reduce((mx, e) => Math.max(mx, e.tokens), 0) || 1;
      for (const edge of devToHub) edge.share = edge.tokens / maxD2H;

      const hubToEnd = endpoints.map((ep) => {
        const dev = deviceById.get(ep.deviceId);
        return {
          id: `h2e:${ep.hubId}->${ep.id}`,
          from: ep.hubId,
          to: ep.id,
          tokens: ep.totalTokens,
          share: ep.totalTokens / totalEndTokens,
          active: ep.isActive,
          state: ep.activityState,
          liveRate: ep.isActive ? Math.max(1, n(dev?.liveTokPerSec)) : 0,
          color: ep.color
        };
      });

      const activeEdges = devToHub.filter((e) => e.active).length + hubToEnd.filter((e) => e.active).length;
      return {
        mode: 'sessions',
        devices,
        hubs,
        endpoints,
        devToHub,
        hubToEnd,
        counts: {
          devices: devices.length,
          hubs: hubs.length,
          endpoints: endpoints.length,
          activeEdges
        },
        totals: {
          devices: totalDevices,
          hubs: sortedHubs.length,
          endpoints: sessions.length
        },
        overflow: {
          devices: Math.max(0, totalDevices - devices.length),
          hubs: Math.max(0, sortedHubs.length - hubs.length),
          endpoints: Math.max(0, sessions.length - endpoints.length)
        }
      };
    }

    // Fallback when no sessions are tracked in the selected period: Devices -> Tools -> Models.
    const hubs = tools.slice(0, maxHubs).map((row) => ({
      id: `tool:${row.id}`,
      toolId: row.id,
      name: String(row.label || row.id),
      isGeneral: false,
      tokens: Math.max(0, n(row.tokens)),
      cost: Math.max(0, n(row.cost)),
      unpricedTokens: Math.max(0, n(row.unpricedTokens)),
      activeSessionCount: 0,
      iconClass: String(row.iconClass || ''),
      color: String(row.color || '#6ab4f0'),
      barBackground: '',
      clients: [],
      raw: row
    }));

    const endpoints = models.slice(0, maxEndpoints).map((m) => ({
      id: `model:${m.id}`,
      modelId: m.id,
      title: String(m.label || m.id),
      client: String(m.vendor || ''),
      clientLabel: String(m.vendor || ''),
      projectLabel: '',
      latestModel: String(m.id),
      iconClass: String(m.iconClass || ''),
      color: String(m.color || '#6ab4f0'),
      totalTokens: Math.max(0, n(m.tokens)),
      costUsd: Math.max(0, n(m.cost)),
      unpricedTokens: Math.max(0, n(m.unpricedTokens)),
      activityState: 'idle',
      isActive: false,
      context: null,
      subagentCount: 0,
      deviceName: '',
      raw: m
    }));

    /** @type {any[]} */
    const devToHub = [];
    const hubByToolId = new Map(hubs.map((h) => [h.toolId, h]));
    for (const dev of devices) {
      /** @type {any[]} */
      const rawClients = Array.isArray(dev.topClients) ? dev.topClients : [];
      const clientList = rawClients.length > 0
        ? rawClients.filter((/** @type {any} */ c) => hubByToolId.has(c.id))
        : hubs.map((h) => ({ id: h.toolId, tokens: h.tokens, color: h.color }));
      const effectiveList = clientList.length > 0 ? clientList : hubs.slice(0, 1).map((h) => ({ id: h.toolId, tokens: h.tokens, color: h.color }));
      for (const c of effectiveList) {
        const hub = hubByToolId.get(c.id);
        if (!hub) continue;
        devToHub.push({
          id: `d2h:${dev.id}->${hub.id}`,
          from: dev.id,
          to: hub.id,
          tokens: Math.max(0, n(c.tokens)),
          share: 0,
          active: dev.liveTokPerSec > 0,
          liveRate: n(dev.liveTokPerSec),
          color: hub.color,
          sessionCount: 0
        });
      }
    }
    const maxD2H = devToHub.reduce((mx, e) => Math.max(mx, e.tokens), 0) || 1;
    for (const edge of devToHub) edge.share = edge.tokens / maxD2H;

    /** @type {any[]} */
    const hubToEnd = [];
    /** @type {Set<string>} */
    const linkedModels = new Set();
    for (const hub of hubs) {
      for (const mod of hub.raw?.models || []) {
        const epId = `model:${mod.id}`;
        const ep = endpoints.find((item) => item.id === epId);
        if (!ep) continue;
        linkedModels.add(epId);
        hubToEnd.push({
          id: `h2e:${hub.id}->${ep.id}`,
          from: hub.id,
          to: ep.id,
          tokens: Math.max(0, n(mod.tokens)),
          share: ep.totalTokens > 0 ? Math.min(1, n(mod.tokens) / ep.totalTokens) : 0,
          active: false,
          state: 'idle',
          liveRate: 0,
          color: ep.color
        });
      }
    }
    if (hubs[0]) {
      for (const ep of endpoints) {
        if (linkedModels.has(ep.id)) continue;
        hubToEnd.push({
          id: `h2e:${hubs[0].id}->${ep.id}`,
          from: hubs[0].id,
          to: ep.id,
          tokens: ep.totalTokens,
          share: 0.6,
          active: false,
          state: 'idle',
          liveRate: 0,
          color: ep.color
        });
      }
    }

    const activeEdges = devToHub.filter((e) => e.active).length;
    return {
      mode: 'tools',
      devices,
      hubs,
      endpoints,
      devToHub,
      hubToEnd,
      counts: {
        devices: devices.length,
        hubs: hubs.length,
        endpoints: endpoints.length,
        activeEdges
      },
      totals: {
        devices: totalDevices,
        hubs: tools.length,
        endpoints: models.length
      },
      overflow: {
        devices: Math.max(0, totalDevices - devices.length),
        hubs: Math.max(0, tools.length - hubs.length),
        endpoints: Math.max(0, models.length - endpoints.length)
      }
    };
  }

  /**
   * Builds the full overview projection for the selected machine & period.
   *
   * @param {{
   *   stats?: any,
   *   history?: any,
   *   periodKey?: string,
   *   selectedDeviceId?: string,
   *   settings?: any,
   *   liveRatesByDevice?: Record<string, number>,
   *   rateSample?: any,
   *   rateSamples?: any[],
   *   rateMode?: 'speed' | 'burn',
   *   topology?: { maxDevices?: number, maxHubs?: number, maxEndpoints?: number },
   *   nowMs?: number
   * }} options
   */
  function buildScopedOverview(options = {}) {
    const stats = options.stats || null;
    const history = options.history || null;
    const periodKey = options.periodKey || 'today';
    const selectedDeviceId = options.selectedDeviceId || 'all';
    const settings = options.settings || {};
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();

    const fleet = buildFleetModel({
      stats,
      history,
      periodKey,
      liveRatesByDevice: options.liveRatesByDevice,
      settings,
      nowMs
    });

    const activeMachine = selectedDeviceId !== 'all'
      ? fleet.machines.find((m) => m.deviceId === selectedDeviceId) || null
      : null;

    const scopedHistory = selectScopedHistory(history, activeMachine ? activeMachine.deviceId : 'all');
    const periodSource = activeMachine
      ? { periods: { [periodKey]: activeMachine.periodData } }
      : stats;

    const periodData = activeMachine
      ? activeMachine.periodData
      : resolvePeriodData(periodSource, scopedHistory.daily, periodKey, { locale: settings?.locale });

    const anatomy = computeTokenAnatomy(periodData, scopedHistory.daily);
    const totalTokens = periodData ? Math.max(0, n(periodData.totalTokens)) : n(scopedHistory.summary.totalTokens);
    const totalCost = periodData ? Math.max(0, n(periodData.costUsd ?? periodData.totalCost)) : n(scopedHistory.summary.totalCost);
    const unpricedTokens = periodData ? Math.max(0, n(periodData.unpricedTokens)) : n(scopedHistory.summary.unpricedTokens);

    const tools = buildToolRows(periodData, scopedHistory.daily, totalTokens);
    const models = buildModelRows(periodData, scopedHistory.daily, totalTokens);
    const sessions = buildSessionList({
      stats,
      periodData,
      periodKey,
      selectedDeviceId: activeMachine ? activeMachine.deviceId : 'all',
      settings,
      nowMs
    });
    const workspaces = buildWorkspaceList({
      stats,
      periodData,
      periodKey,
      selectedDeviceId: activeMachine ? activeMachine.deviceId : 'all',
      sessions
    });
    const quotas = buildQuotaAccounts(stats, settings, nowMs);

    const velocity = buildLiveVelocityModel({
      sample: options.rateSample || null,
      rateSamples: options.rateSamples || [],
      rateMode: options.rateMode === 'burn' ? 'burn' : 'speed',
      selectedDeviceId: activeMachine ? activeMachine.deviceId : 'all',
      now: nowMs
    });

    const dailyLedger = (scopedHistory.daily || [])
      .slice()
      .sort(/** @param {any} a @param {any} b */ (a, b) => String(b?.date || '').localeCompare(String(a?.date || '')))
      .map(/** @param {any} row @param {number} index @param {any[]} list */ (row, index, list) => {
        const prev = list[index + 1];
        const prevTokens = n(prev?.tokens);
        const curTokens = n(row?.tokens);
        const deltaPercent = prev && prevTokens > 0 ? ((curTokens - prevTokens) / prevTokens) * 100 : null;
        const topClientEntry = Object.entries(foldClientNumbers(
          Object.fromEntries(Object.entries(row?.perClient || {}).map(([k, v]) => [k, /** @type {any} */ (v)?.tokens]))
        )).sort((a, b) => b[1] - a[1])[0];
        return {
          date: String(row?.date || '').slice(0, 10),
          tokens: curTokens,
          cost: n(row?.cost),
          unpricedTokens: n(row?.unpricedTokens),
          topClient: topClientEntry ? { id: topClientEntry[0], label: clientDisplayLabel(topClientEntry[0]), color: clientColor(topClientEntry[0]) } : null,
          deltaPercent,
          raw: row
        };
      });

    const baseOverview = {
      fleet,
      activeMachine,
      scopedHistory,
      periodData,
      periodKey,
      hero: {
        tokens: totalTokens,
        cost: totalCost,
        unpricedTokens,
        anatomy,
        cacheHitRate: anatomy.cacheHitRate,
        streak: n(scopedHistory.summary.currentStreak),
        activeDays: n(scopedHistory.summary.activeDays),
        liveTokPerSec: activeMachine
          ? activeMachine.liveTokPerSec
          : fleet.machines.reduce((sum, m) => sum + n(m.liveTokPerSec), 0)
      },
      velocity,
      tools,
      models,
      sessions,
      workspaces,
      quotas,
      dailyLedger
    };

    return {
      ...baseOverview,
      topology: buildTopologyGraph(baseOverview, options.topology)
    };
  }

  return {
    resolvePeriodData,
    summarizeDaily,
    buildFleetModel,
    selectScopedHistory,
    computeTokenAnatomy,
    buildToolRows,
    buildModelRows,
    buildQuotaAccounts,
    buildSessionList,
    buildWorkspaceList,
    buildLiveVelocityModel,
    buildTopologyGraph,
    isometricHeatmapSvg,
    buildScopedOverview
  };
});
