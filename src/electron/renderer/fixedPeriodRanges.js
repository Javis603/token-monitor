(function exposeFixedPeriodRanges(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorFixedPeriodRanges = api;
})(typeof window !== 'undefined' ? window : null, function createFixedPeriodRangesApi() {
  const MONTH_MODES = Object.freeze(['month', 'week', 'last7', 'last30']);
  const LABELS = Object.freeze({
    today: 'DAY',
    month: 'MONTH',
    allTime: 'TOTAL',
    week: 'WEEK',
    last7: '7D',
    last30: '30D'
  });

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function normalizeDateKey(value) {
    const key = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return '';
    const date = new Date(`${key}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key ? key : '';
  }

  function dayKeyAddDays(key, delta) {
    const normalized = normalizeDateKey(key);
    if (!normalized) return '';
    const date = new Date(`${normalized}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Number(delta || 0));
    return date.toISOString().slice(0, 10);
  }

  function localDayKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function weekStartsOn(locale) {
    try {
      const resolved = new Intl.Locale(String(locale || 'en'));
      const info = typeof resolved.getWeekInfo === 'function' ? resolved.getWeekInfo() : resolved.weekInfo;
      const firstDay = Number(info?.firstDay);
      if (Number.isInteger(firstDay) && firstDay >= 1 && firstDay <= 7) return firstDay % 7;
    } catch (_) { /* use ISO Monday */ }
    return 1;
  }

  function normalizeMonthMode(value) {
    return MONTH_MODES.includes(value) ? value : 'month';
  }

  function periodMenuTargetIndex(key, currentIndex, itemCount) {
    const count = Math.max(0, Math.floor(Number(itemCount) || 0));
    if (count === 0) return -1;
    const current = Math.max(0, Math.min(count - 1, Math.floor(Number(currentIndex) || 0)));
    if (key === 'ArrowDown') return (current + 1) % count;
    if (key === 'ArrowUp') return (current - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return -1;
  }

  function handlePeriodMenuNavigation(event, options = {}) {
    const index = periodMenuTargetIndex(event?.key, options.currentIndex, options.itemCount);
    if (index < 0) return false;
    event?.preventDefault?.();
    options.focusIndex?.(index);
    return true;
  }

  function isDerived(value) {
    return value === 'week' || value === 'last7' || value === 'last30';
  }

  function slotForSelection(value) {
    return isDerived(value) || value === 'month' ? 'month' : value;
  }

  function displayLabel(value) {
    return LABELS[value] || LABELS.today;
  }

  function rangeForSelection(selection, options = {}) {
    const todayKey = normalizeDateKey(options.todayKey) || localDayKey(options.now);
    if (!todayKey) return null;
    if (selection === 'week') {
      const weekday = new Date(`${todayKey}T00:00:00Z`).getUTCDay();
      const offset = (weekday - weekStartsOn(options.locale) + 7) % 7;
      return { start: dayKeyAddDays(todayKey, -offset), end: todayKey };
    }
    if (selection === 'last7') return { start: dayKeyAddDays(todayKey, -6), end: todayKey };
    if (selection === 'last30') return { start: dayKeyAddDays(todayKey, -29), end: todayKey };
    return null;
  }

  function addMap(target, key, value) {
    if (!key) return;
    target[key] = finiteNumber(target[key]) + finiteNumber(value);
  }

  function tokenComponentBreakdown(value = {}) {
    const total = Math.max(0, finiteNumber(value.totalTokens));
    const unclassified = Math.min(total, Math.max(0, finiteNumber(value.unclassifiedTokens)));
    const classified = total - unclassified;
    const cacheRead = Math.min(classified, Math.max(0, finiteNumber(value.cacheReadTokens)));
    const output = Math.min(classified - cacheRead, Math.max(0, finiteNumber(value.outputTokens)));
    const cacheMiss = Math.max(0, classified - cacheRead - output);
    const input = cacheRead + cacheMiss;
    const hitPct = input > 0 ? Math.round((cacheRead / input) * 100) : 0;
    return {
      cacheRead,
      cacheMiss,
      output,
      unclassified,
      hitPct,
      missPct: input > 0 ? 100 - hitPct : 0
    };
  }

  function unclassifiedTokensFor(value) {
    if (!value || typeof value !== 'object') return 0;
    if (Object.prototype.hasOwnProperty.call(value, 'unclassifiedTokens')) {
      return Math.max(0, finiteNumber(value.unclassifiedTokens));
    }
    return value.tokenComponentsAvailable === true ? 0 : Math.max(0, finiteNumber(value.tokens));
  }

  function liveComponentValues(
    totalValue,
    cacheReadValue,
    cacheWriteValue,
    outputValue,
    exact,
    unclassifiedValue,
    hasExplicitUnclassified = false
  ) {
    const total = Math.max(0, finiteNumber(totalValue));
    const cacheReadTokens = Math.min(total, Math.max(0, finiteNumber(cacheReadValue)));
    const cacheWriteTokens = Math.min(
      total - cacheReadTokens,
      Math.max(0, finiteNumber(cacheWriteValue))
    );
    const outputTokens = Math.min(
      total - cacheReadTokens - cacheWriteTokens,
      Math.max(0, finiteNumber(outputValue))
    );
    const remainder = Math.max(0, total - cacheReadTokens - cacheWriteTokens - outputTokens);
    return {
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      unclassifiedTokens: exact
        ? 0
        : hasExplicitUnclassified
          ? Math.min(remainder, Math.max(0, finiteNumber(unclassifiedValue)))
          : remainder
    };
  }

  function rowFromLivePeriod(period, date, previous = {}) {
    const tokenComponentsAvailable = period?.capabilities?.tokenComponents === true;
    const hasClientUnclassified = Object.prototype.hasOwnProperty.call(period || {}, 'clientUnclassifiedTokens');
    const hasModelUnclassified = Object.prototype.hasOwnProperty.call(period || {}, 'modelUnclassifiedTokens');
    const perClient = {};
    const clients = new Set([
      ...Object.keys(period?.clients || {}),
      ...Object.keys(period?.clientCosts || {})
    ]);
    for (const client of clients) {
      const tokens = finiteNumber(period?.clients?.[client]);
      const components = liveComponentValues(
        tokens,
        period?.clientCacheReads?.[client],
        period?.clientCacheWrites?.[client],
        period?.clientOutputs?.[client],
        tokenComponentsAvailable,
        period?.clientUnclassifiedTokens?.[client],
        hasClientUnclassified
      );
      perClient[client] = {
        tokens,
        cost: finiteNumber(period?.clientCosts?.[client]),
        messages: finiteNumber(previous?.perClient?.[client]?.messages),
        ...components
      };
    }
    const perModel = {};
    const models = new Set([
      ...Object.keys(period?.models || {}),
      ...Object.keys(period?.modelCosts || {})
    ]);
    for (const model of models) {
      const tokens = finiteNumber(period?.models?.[model]);
      const components = liveComponentValues(
        tokens,
        period?.modelCacheReads?.[model],
        period?.modelCacheWrites?.[model],
        period?.modelOutputs?.[model],
        tokenComponentsAvailable,
        period?.modelUnclassifiedTokens?.[model],
        hasModelUnclassified
      );
      perModel[model] = {
        tokens,
        cost: finiteNumber(period?.modelCosts?.[model]),
        ...components
      };
    }
    const totalComponents = liveComponentValues(
      period?.totalTokens,
      period?.cacheReadTokens,
      period?.cacheWriteTokens,
      period?.outputTokens,
      tokenComponentsAvailable,
      period?.unclassifiedTokens,
      Object.prototype.hasOwnProperty.call(period || {}, 'unclassifiedTokens')
    );
    return {
      ...previous,
      date,
      tokens: finiteNumber(period?.totalTokens),
      cost: finiteNumber(period?.costUsd),
      ...totalComponents,
      tokenComponentsAvailable,
      perClient,
      perModel
    };
  }

  function dailyWithLiveToday(daily, todayKey, todayPeriod) {
    const rows = Array.isArray(daily) ? daily.map((row) => ({ ...row })) : [];
    const date = normalizeDateKey(todayKey);
    if (!date || !todayPeriod) return rows;
    const index = rows.findIndex((row) => normalizeDateKey(row?.date) === date);
    const previous = index >= 0 ? rows[index] : {};
    const live = rowFromLivePeriod(todayPeriod, date, previous);
    if (index < 0) rows.push(live);
    else if (finiteNumber(live.tokens) >= finiteNumber(previous.tokens)) rows[index] = live;
    return rows.sort((left, right) => String(left?.date || '').localeCompare(String(right?.date || '')));
  }

  function dailyForRange(daily, range, options = {}) {
    const byDate = new Map();
    for (const row of dailyWithLiveToday(
      daily,
      options.liveTodayKey || options.todayKey,
      options.todayPeriod
    )) {
      const date = normalizeDateKey(row?.date);
      if (date && date >= range.start && date <= range.end) byDate.set(date, row);
    }
    const rows = [];
    for (let date = range.start; date <= range.end; date = dayKeyAddDays(date, 1)) {
      rows.push(byDate.get(date) || {
        date, tokens: 0, cost: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
        unclassifiedTokens: 0,
        tokenComponentsAvailable: true,
        perClient: {}, perModel: {}
      });
    }
    return rows;
  }

  function summaryForDaily(rows) {
    const daily = Array.isArray(rows) ? rows : [];
    const active = daily.filter((row) => finiteNumber(row?.tokens) > 0);
    let currentStreak = 0;
    for (let index = daily.length - 1; index >= 0 && finiteNumber(daily[index]?.tokens) > 0; index -= 1) {
      currentStreak += 1;
    }
    const peakDayTokens = Math.max(0, ...daily.map((row) => finiteNumber(row?.tokens)));
    return {
      activeDays: active.length,
      currentStreak,
      activeTimeMs: daily.reduce((sum, row) => sum + finiteNumber(row?.activeTimeMs), 0),
      peakDayTokens
    };
  }

  function sourcePeriod(source, periodName) {
    return source?.periods?.[periodName] || source?.[periodName] || null;
  }

  function deviceInventorySignature(devices) {
    const deviceIds = new Set((devices || [])
      .map((device) => String(device?.deviceId || '').trim())
      .filter(Boolean));
    return JSON.stringify(Array.from(deviceIds).sort());
  }

  function shouldRetryFixedPeriodHistory(options = {}) {
    const signature = String(options.signature || '');
    const currentSignature = String(options.currentSignature || '');
    const retries = Number(options.retries);
    const maxRetries = Number(options.maxRetries);
    return Boolean(signature)
      && currentSignature === signature
      && Number.isInteger(retries)
      && Number.isInteger(maxRetries)
      && retries >= 0
      && retries < maxRetries
      && (options.failed === true || options.inventoryMatches !== true);
  }

  function shouldWarmFixedPeriodHistory(options = {}) {
    if (options.hasStats !== true || options.historyEnabled === false || options.apiAvailable !== true) {
      return false;
    }
    if (options.active === true) return true;
    if (options.force === true) return true;
    if (options.retryFailed === true && options.failed === true) return true;
    return options.requested !== true
      || String(options.loadedSignature || '') !== String(options.currentSignature || '');
  }

  function createLatestRequestCoordinator(options = {}) {
    let activePromise = null;
    let renderRequested = false;

    function request(requestOptions = {}) {
      if (requestOptions.renderOnComplete !== false) renderRequested = true;
      if (activePromise) return activePromise;

      const promise = (async () => {
        let force = requestOptions.force === true;
        let loaded = false;
        while (true) {
          const signature = String(options.signature?.() || '');
          loaded = Boolean(await options.load?.({ force, signature })) || loaded;
          force = false;
          if (String(options.signature?.() || '') === signature) return loaded;
        }
      })();
      activePromise = promise;

      const settle = () => {
        if (activePromise !== promise) return;
        activePromise = null;
        const shouldRender = renderRequested;
        renderRequested = false;
        options.onSettled?.({ render: shouldRender });
      };
      void promise.then(settle, settle);
      return promise;
    }

    return {
      active: () => Boolean(activePromise),
      request
    };
  }

  function joinDeviceHistorySources(historySources, liveDevices) {
    const histories = new Map((historySources || []).map((source) => [String(source?.deviceId || ''), source]));
    const live = new Map((liveDevices || []).map((source) => [String(source?.deviceId || ''), source]));
    const deviceIds = new Set([...histories.keys(), ...live.keys()]);
    deviceIds.delete('');
    return Array.from(deviceIds).sort().map((deviceId) => {
      const historySource = histories.get(deviceId);
      const liveSource = live.get(deviceId);
      return {
        ...(historySource || {}),
        ...(liveSource || {}),
        deviceId,
        history: historySource?.history || null,
        historyAvailable: historySource?.historyAvailable === true
      };
    });
  }

  function sourceParticipatesInUsage(source) {
    for (const periodName of ['today', 'month', 'allTime']) {
      const period = sourcePeriod(source, periodName);
      if (finiteNumber(period?.totalTokens) > 0 || finiteNumber(period?.costUsd) > 0) return true;
    }
    return (source?.history?.daily || []).some((row) => (
      finiteNumber(row?.tokens) > 0 || finiteNumber(row?.cost) > 0
    ));
  }

  function dayKeyInTimeZone(value, timeZone) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()) || !timeZone) return '';
    try {
      const parts = new Intl.DateTimeFormat('en', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(date);
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return normalizeDateKey(`${values.year}-${values.month}-${values.day}`);
    } catch (_) {
      return '';
    }
  }

  function deviceDayState(source, options = {}) {
    const window = source?.periodWindows?.today;
    const key = normalizeDateKey(window?.key);
    const endsAtMs = Date.parse(window?.endsAt || '');
    const nowMs = options.now instanceof Date
      ? options.now.getTime()
      : Number.isFinite(Number(options.now))
        ? Number(options.now)
        : Date.now();
    if (!key || !Number.isFinite(endsAtMs)) return null;
    if (nowMs < endsAtMs) return { currentKey: key, snapshotKey: key };
    const currentKey = dayKeyInTimeZone(nowMs, source?.periodWindows?.timeZone);
    return currentKey ? { currentKey, snapshotKey: key } : null;
  }

  function readySnapshotForSelection(snapshot, selection) {
    return snapshot?.status === 'ready' && snapshot.selection === selection ? snapshot : null;
  }

  function devicesForReadySnapshot(snapshot, selection) {
    const ready = readySnapshotForSelection(snapshot, selection);
    return (ready?.devices || []).map((source) => ({
      ...source,
      periods: {
        ...(source?.periods || {}),
        [selection]: source.period
      }
    }));
  }

  function addDailyAttribution(target, field, source) {
    for (const [name, value] of Object.entries(source || {})) {
      if (!target[field][name]) target[field][name] = { tokens: 0, cost: 0 };
      target[field][name].tokens += finiteNumber(value?.tokens);
      target[field][name].cost += finiteNumber(value?.cost);
      target[field][name].cacheReadTokens = finiteNumber(target[field][name].cacheReadTokens)
        + finiteNumber(value?.cacheReadTokens);
      target[field][name].cacheWriteTokens = finiteNumber(target[field][name].cacheWriteTokens)
        + finiteNumber(value?.cacheWriteTokens);
      target[field][name].outputTokens = finiteNumber(target[field][name].outputTokens)
        + finiteNumber(value?.outputTokens);
      target[field][name].unclassifiedTokens = finiteNumber(target[field][name].unclassifiedTokens)
        + unclassifiedTokensFor(value);
      if (field === 'perClient') {
        target[field][name].messages = finiteNumber(target[field][name].messages)
          + finiteNumber(value?.messages);
      }
    }
  }

  function mergeSelectedDaily(snapshots) {
    const byDate = new Map();
    for (const snapshot of snapshots) {
      for (const row of snapshot.daily || []) {
        const date = normalizeDateKey(row?.date);
        if (!date) continue;
        if (!byDate.has(date)) {
          byDate.set(date, {
            date,
            tokens: 0,
            cost: 0,
            activeTimeMs: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            unclassifiedTokens: 0,
            tokenComponentsAvailable: true,
            perClient: {},
            perModel: {}
          });
        }
        const target = byDate.get(date);
        target.tokens += finiteNumber(row?.tokens);
        target.cost += finiteNumber(row?.cost);
        target.activeTimeMs += finiteNumber(row?.activeTimeMs);
        target.cacheReadTokens += finiteNumber(row?.cacheReadTokens);
        target.cacheWriteTokens += finiteNumber(row?.cacheWriteTokens);
        target.outputTokens += finiteNumber(row?.outputTokens);
        target.unclassifiedTokens += unclassifiedTokensFor(row);
        target.tokenComponentsAvailable = target.tokenComponentsAvailable
          && row?.tokenComponentsAvailable === true;
        addDailyAttribution(target, 'perClient', row?.perClient);
        addDailyAttribution(target, 'perModel', row?.perModel);
      }
    }
    return Array.from(byDate.values()).sort((left, right) => left.date.localeCompare(right.date));
  }

  function fixedPeriodSnapshotFromDevices(selection, sources, options = {}) {
    if (!isDerived(selection)) return { status: 'native', period: null, range: null, devices: [] };
    if (options.historyEnabled === false) {
      return { status: 'unavailable', reason: 'historyDisabled', period: null, range: null, devices: [] };
    }
    if (!Array.isArray(sources)) {
      return { status: 'unavailable', reason: 'historyUnavailable', period: null, range: null, devices: [] };
    }

    // A device with zero native DAY/MONTH/TOTAL can still own retained usage in
    // the selected range (for example when allTimeSince excludes it). Require a
    // History answer from every joined device before deciding participation so
    // missing records never become silent zeroes.
    if (sources.some((source) => source?.historyAvailable !== true)) {
      return { status: 'unavailable', reason: 'historyUnavailable', period: null, range: null, devices: [] };
    }

    const participating = sources.filter(sourceParticipatesInUsage);
    if (participating.length === 0) {
      const empty = fixedPeriodSnapshot(selection, {
        ...options,
        historyAvailable: options.historyAvailable === true,
        daily: [],
        todayPeriod: null
      });
      return { ...empty, devices: [] };
    }
    const snapshots = [];
    for (const source of participating) {
      const dayState = deviceDayState(source, options);
      if (!dayState) {
        return { status: 'unavailable', reason: 'historyUnavailable', period: null, range: null, devices: [] };
      }
      const snapshot = fixedPeriodSnapshot(selection, {
        ...options,
        historyAvailable: true,
        daily: source.history?.daily || [],
        todayKey: dayState.currentKey,
        liveTodayKey: dayState.snapshotKey,
        todayPeriod: sourcePeriod(source, 'today')
      });
      if (snapshot.status !== 'ready') return { ...snapshot, devices: [] };
      snapshots.push({ ...source, ...snapshot });
    }

    const daily = mergeSelectedDaily(snapshots);
    const range = {
      start: snapshots.reduce((value, snapshot) => !value || snapshot.range.start < value ? snapshot.range.start : value, ''),
      end: snapshots.reduce((value, snapshot) => !value || snapshot.range.end > value ? snapshot.range.end : value, '')
    };
    return {
      status: 'ready',
      selection,
      reason: '',
      range,
      daily,
      summary: summaryForDaily(daily),
      period: derivePeriod(daily, range),
      devices: snapshots.map((snapshot) => ({
        ...snapshot,
        period: snapshot.period,
        daily: snapshot.daily,
        range: snapshot.range
      }))
    };
  }

  function derivePeriod(daily, range, options = {}) {
    const period = {
      totalTokens: 0,
      costUsd: 0,
      clients: {},
      clientCosts: {},
      clientCacheReads: {},
      clientCacheWrites: {},
      clientOutputs: {},
      clientUnclassifiedTokens: {},
      models: {},
      modelCosts: {},
      modelCacheReads: {},
      modelCacheWrites: {},
      modelOutputs: {},
      modelUnclassifiedTokens: {},
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      unclassifiedTokens: 0,
      sessions: {},
      projects: {},
      capabilities: { tokenComponents: false, attribution: true, clientModels: false },
      derivedFixedRange: true
    };
    const rows = dailyForRange(daily, range, options);
    period.capabilities.tokenComponents = rows.every((row) => row?.tokenComponentsAvailable === true);
    for (const row of rows) {
      period.totalTokens += finiteNumber(row?.tokens);
      period.costUsd += finiteNumber(row?.cost);
      period.cacheReadTokens += finiteNumber(row?.cacheReadTokens);
      period.cacheWriteTokens += finiteNumber(row?.cacheWriteTokens);
      period.outputTokens += finiteNumber(row?.outputTokens);
      period.unclassifiedTokens += unclassifiedTokensFor(row);
      for (const [client, value] of Object.entries(row?.perClient || {})) {
        addMap(period.clients, client, value?.tokens);
        addMap(period.clientCosts, client, value?.cost);
        addMap(period.clientCacheReads, client, value?.cacheReadTokens);
        addMap(period.clientCacheWrites, client, value?.cacheWriteTokens);
        addMap(period.clientOutputs, client, value?.outputTokens);
        addMap(period.clientUnclassifiedTokens, client, unclassifiedTokensFor(value));
      }
      for (const [model, value] of Object.entries(row?.perModel || {})) {
        addMap(period.models, model, value?.tokens);
        addMap(period.modelCosts, model, value?.cost);
        addMap(period.modelCacheReads, model, value?.cacheReadTokens);
        addMap(period.modelCacheWrites, model, value?.cacheWriteTokens);
        addMap(period.modelOutputs, model, value?.outputTokens);
        addMap(period.modelUnclassifiedTokens, model, unclassifiedTokensFor(value));
      }
    }
    period.totalTokens = Math.max(0, Math.round(period.totalTokens));
    period.costUsd = Number(period.costUsd.toFixed(6));
    period.cacheReadTokens = Math.max(0, Math.round(period.cacheReadTokens));
    period.cacheWriteTokens = Math.max(0, Math.round(period.cacheWriteTokens));
    period.outputTokens = Math.max(0, Math.round(period.outputTokens));
    period.unclassifiedTokens = Math.max(0, Math.round(period.unclassifiedTokens));
    for (const map of [
      period.clients,
      period.clientCacheReads,
      period.clientCacheWrites,
      period.clientOutputs,
      period.clientUnclassifiedTokens,
      period.models,
      period.modelCacheReads,
      period.modelCacheWrites,
      period.modelOutputs,
      period.modelUnclassifiedTokens
    ]) {
      for (const key of Object.keys(map)) map[key] = Math.max(0, Math.round(map[key]));
    }
    for (const map of [period.clientCosts, period.modelCosts]) {
      for (const key of Object.keys(map)) map[key] = Number(map[key].toFixed(6));
    }
    return period;
  }

  function fixedPeriodSnapshot(selection, options = {}) {
    if (!isDerived(selection)) return { status: 'native', selection, period: null, range: null };
    if (options.historyEnabled === false) return { status: 'unavailable', selection, reason: 'historyDisabled', period: null, range: null };
    if (options.historyAvailable !== true) return { status: 'unavailable', selection, reason: 'historyUnavailable', period: null, range: null };
    const range = rangeForSelection(selection, options);
    if (!range) return { status: 'unavailable', selection, reason: 'historyUnavailable', period: null, range: null };
    const daily = dailyForRange(options.daily, range, options);
    return {
      status: 'ready',
      selection,
      reason: '',
      range,
      daily,
      summary: summaryForDaily(daily),
      period: derivePeriod(daily, range)
    };
  }

  function fixedPeriodDeviceSnapshots(selection, sources, options = {}) {
    return fixedPeriodSnapshotFromDevices(selection, sources, options).devices || [];
  }

  function supportsBreakdown(selection, breakdown, options = {}) {
    if (!isDerived(selection)) return true;
    if (breakdown === 'session' || breakdown === 'project') return false;
    if (breakdown === 'device') return options.deviceHistoriesAvailable === true;
    return true;
  }

  return {
    MONTH_MODES,
    createLatestRequestCoordinator,
    dailyForRange,
    dayKeyAddDays,
    derivePeriod,
    deviceInventorySignature,
    devicesForReadySnapshot,
    displayLabel,
    fixedPeriodDeviceSnapshots,
    fixedPeriodSnapshot,
    fixedPeriodSnapshotFromDevices,
    isDerived,
    joinDeviceHistorySources,
    localDayKey,
    handlePeriodMenuNavigation,
    normalizeMonthMode,
    periodMenuTargetIndex,
    readySnapshotForSelection,
    rangeForSelection,
    shouldRetryFixedPeriodHistory,
    shouldWarmFixedPeriodHistory,
    slotForSelection,
    supportsBreakdown,
    tokenComponentBreakdown,
    weekStartsOn
  };
});
