(function exposePeriodRanges(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPeriodRanges = api;
})(typeof window !== 'undefined' ? window : null, function createPeriodRangesApi() {
  const SLOT_MODES = Object.freeze({
    today: Object.freeze(['today']),
    month: Object.freeze(['month', 'week', 'last7', 'last30']),
    allTime: Object.freeze(['allTime', 'range'])
  });
  const SETTING_KEYS = Object.freeze({
    today: 'periodTodayMode',
    month: 'periodMonthMode',
    allTime: 'periodTotalMode'
  });
  const DEFAULT_MODES = Object.freeze({ today: 'today', month: 'month', allTime: 'allTime' });
  const DISPLAY_LABELS = Object.freeze({
    today: 'DAY',
    month: 'MONTH',
    allTime: 'TOTAL',
    week: 'WEEK',
    last7: '7D',
    last30: '30D',
    range: 'RANGE'
  });

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function setOwn(target, key, value) {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }

  function normalizeMode(slot, value, fallback = DEFAULT_MODES[slot]) {
    const allowed = SLOT_MODES[slot] || [];
    const normalizedFallback = allowed.includes(fallback) ? fallback : (DEFAULT_MODES[slot] || allowed[0] || '');
    return allowed.includes(value) ? value : normalizedFallback;
  }

  function modeSettingKey(slot) {
    return SETTING_KEYS[slot] || '';
  }

  function modeForSlot(slot, settings = {}) {
    return normalizeMode(slot, settings?.[modeSettingKey(slot)]);
  }

  function normalizedSettings(settings = {}) {
    return {
      periodTodayMode: modeForSlot('today', settings),
      periodMonthMode: modeForSlot('month', settings),
      periodTotalMode: modeForSlot('allTime', settings),
      periodRangeStart: normalizeDateKey(settings.periodRangeStart),
      periodRangeEnd: normalizeDateKey(settings.periodRangeEnd)
    };
  }

  function effectiveSelection(slot, settings = {}, options = {}) {
    const mode = modeForSlot(slot, settings);
    if (options.historyEnabled === false && isDerived(mode)) return DEFAULT_MODES[slot] || mode;
    return mode;
  }

  function displayLabel(selection) {
    return DISPLAY_LABELS[selection] || DISPLAY_LABELS.today;
  }

  function isDerived(selection) {
    return selection === 'week' || selection === 'last7' || selection === 'last30' || selection === 'range';
  }

  function supportsBreakdown(selection, breakdown) {
    return !isDerived(selection) || (breakdown !== 'project' && breakdown !== 'session');
  }

  function normalizeDateKey(value) {
    const key = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return '';
    const date = new Date(`${key}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key ? key : '';
  }

  function normalizeDateRange(start, end) {
    const normalizedStart = normalizeDateKey(start);
    const normalizedEnd = normalizeDateKey(end);
    if (!normalizedStart || !normalizedEnd || normalizedStart > normalizedEnd) return null;
    return { start: normalizedStart, end: normalizedEnd };
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

  function isValidTimeZone(value) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch (_) {
      return false;
    }
  }

  function currentDayKey(periodWindows, value = new Date()) {
    const now = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(now.getTime())) return localDayKey();
    const window = periodWindows?.today || {};
    if (!window || Object.keys(window).length === 0) return localDayKey(now);
    const timeZone = String(window.timeZone || '').trim();
    if (timeZone && isValidTimeZone(timeZone)) {
      try {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone }).formatToParts(now);
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        const key = `${values.year}-${values.month}-${values.day}`;
        if (normalizeDateKey(key)) return key;
      } catch (_) { /* fall through to the legacy window key */ }
    }
    const key = normalizeDateKey(window.key);
    const endsAt = Date.parse(String(window.endsAt || ''));
    if (key && Number.isFinite(endsAt) && now.getTime() < endsAt) return key;
    return now.toISOString().slice(0, 10);
  }

  function weekStartsOn(locale) {
    try {
      const resolved = new Intl.Locale(String(locale || 'en'));
      const info = typeof resolved.getWeekInfo === 'function'
        ? resolved.getWeekInfo()
        : resolved.weekInfo;
      const firstDay = Number(info?.firstDay);
      if (Number.isInteger(firstDay) && firstDay >= 1 && firstDay <= 7) return firstDay % 7;
    } catch (_) { /* fall through to the ISO week default */ }
    return 1;
  }

  function rangeForSelection(selection, options = {}) {
    const todayKey = normalizeDateKey(options.todayKey) || localDayKey();
    if (selection === 'week') {
      const weekday = new Date(`${todayKey}T00:00:00Z`).getUTCDay();
      const daysSinceStart = (weekday - weekStartsOn(options.locale) + 7) % 7;
      return { start: dayKeyAddDays(todayKey, -daysSinceStart), end: todayKey };
    }
    if (selection === 'last7') return { start: dayKeyAddDays(todayKey, -6), end: todayKey };
    if (selection === 'last30') return { start: dayKeyAddDays(todayKey, -29), end: todayKey };
    if (selection === 'range') return normalizeDateRange(options.rangeStart, options.rangeEnd);
    return null;
  }

  function emptyPeriod() {
    return {
      totalTokens: 0,
      costUsd: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      unclassifiedTokens: 0,
      timedTokens: 0,
      timedOutputTokens: 0,
      timedDurationMs: 0,
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
      clientModels: {},
      clientModelCosts: {},
      projects: {},
      sessions: {}
    };
  }

  function dailyRowFromPeriod(period, date, previous = {}) {
    const perClient = {};
    for (const [client, tokens] of Object.entries(period?.clients || {})) {
      setOwn(perClient, client, {
        tokens: finiteNumber(tokens),
        cost: finiteNumber(period?.clientCosts?.[client]),
        messages: finiteNumber(previous?.perClient?.[client]?.messages),
        cacheReadTokens: finiteNumber(period?.clientCacheReads?.[client]),
        cacheWriteTokens: finiteNumber(period?.clientCacheWrites?.[client]),
        outputTokens: finiteNumber(period?.clientOutputs?.[client]),
        unclassifiedTokens: 0
      });
    }
    const perModel = {};
    for (const [model, tokens] of Object.entries(period?.models || {})) {
      setOwn(perModel, model, {
        tokens: finiteNumber(tokens),
        cost: finiteNumber(period?.modelCosts?.[model]),
        cacheReadTokens: finiteNumber(period?.modelCacheReads?.[model]),
        cacheWriteTokens: finiteNumber(period?.modelCacheWrites?.[model]),
        outputTokens: finiteNumber(period?.modelOutputs?.[model]),
        unclassifiedTokens: 0
      });
    }
    const perClientModel = {};
    for (const [client, models] of Object.entries(period?.clientModels || {})) {
      const clientModels = {};
      for (const [model, tokens] of Object.entries(models || {})) {
        setOwn(clientModels, model, {
          tokens: finiteNumber(tokens),
          cost: finiteNumber(period?.clientModelCosts?.[client]?.[model])
        });
      }
      setOwn(perClientModel, client, clientModels);
    }
    return {
      ...previous,
      date,
      tokens: finiteNumber(period?.totalTokens),
      cost: finiteNumber(period?.costUsd),
      cacheReadTokens: finiteNumber(period?.cacheReadTokens),
      cacheWriteTokens: finiteNumber(period?.cacheWriteTokens),
      outputTokens: finiteNumber(period?.outputTokens),
      unclassifiedTokens: 0,
      capabilities: { tokenComponents: true, clientModels: true },
      perClient,
      perModel,
      perClientModel
    };
  }

  function patchToday(daily, todayKey, nativeToday) {
    const rows = Array.isArray(daily) ? daily.map((row) => ({ ...row })) : [];
    const date = normalizeDateKey(todayKey);
    if (!date || !nativeToday) return rows;
    const index = rows.findIndex((row) => normalizeDateKey(row?.date) === date);
    const previous = index >= 0 ? rows[index] : {};
    const next = dailyRowFromPeriod(nativeToday, date, previous);
    if (index >= 0) rows[index] = next;
    else rows.push(next);
    return rows.sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || '')));
  }

  function dailyRowsForSelection(daily, options = {}) {
    const selection = options.selection;
    const range = rangeForSelection(selection, options);
    if (!range) return [];
    return patchToday(daily, options.todayKey, options.nativeToday).filter((row) => {
      const date = normalizeDateKey(row?.date);
      return date && date >= range.start && date <= range.end;
    });
  }

  function addMapValue(target, key, value) {
    if (!key) return;
    const previous = Object.prototype.hasOwnProperty.call(target, key) ? target[key] : 0;
    setOwn(target, key, finiteNumber(previous) + finiteNumber(value));
  }

  function addNestedMapValue(target, outerKey, innerKey, value) {
    if (!outerKey || !innerKey) return;
    let inner = Object.prototype.hasOwnProperty.call(target, outerKey) ? target[outerKey] : null;
    if (!inner || typeof inner !== 'object') {
      inner = {};
      setOwn(target, outerKey, inner);
    }
    addMapValue(inner, innerKey, value);
  }

  function unclassifiedValue(value, exact) {
    if (Object.prototype.hasOwnProperty.call(value || {}, 'unclassifiedTokens')) {
      return finiteNumber(value.unclassifiedTokens);
    }
    return exact ? 0 : finiteNumber(value?.tokens);
  }

  function derivePeriod(daily, options = {}) {
    const period = emptyPeriod();
    const rows = dailyRowsForSelection(daily, options);
    period.capabilities = {
      // Capability is selection-local. The history-wide summary can be false
      // because of an unrelated legacy day outside the requested range.
      tokenComponents: rows.length > 0
        && rows.every((row) => row?.capabilities?.tokenComponents === true),
      clientModels: rows.length > 0
        && rows.every((row) => row?.capabilities?.clientModels === true)
    };
    for (const row of rows) {
      period.totalTokens += finiteNumber(row?.tokens);
      period.costUsd += finiteNumber(row?.cost);
      period.cacheReadTokens += finiteNumber(row?.cacheReadTokens);
      period.cacheWriteTokens += finiteNumber(row?.cacheWriteTokens);
      period.outputTokens += finiteNumber(row?.outputTokens);
      const rowExact = row?.capabilities?.tokenComponents === true;
      period.unclassifiedTokens += unclassifiedValue(row, rowExact);
      for (const [client, value] of Object.entries(row?.perClient || {})) {
        addMapValue(period.clients, client, value?.tokens);
        addMapValue(period.clientCosts, client, value?.cost);
        addMapValue(period.clientCacheReads, client, value?.cacheReadTokens);
        addMapValue(period.clientCacheWrites, client, value?.cacheWriteTokens);
        addMapValue(period.clientOutputs, client, value?.outputTokens);
        addMapValue(period.clientUnclassifiedTokens, client, unclassifiedValue(value, rowExact));
      }
      for (const [model, value] of Object.entries(row?.perModel || {})) {
        addMapValue(period.models, model, value?.tokens);
        addMapValue(period.modelCosts, model, value?.cost);
        addMapValue(period.modelCacheReads, model, value?.cacheReadTokens);
        addMapValue(period.modelCacheWrites, model, value?.cacheWriteTokens);
        addMapValue(period.modelOutputs, model, value?.outputTokens);
        addMapValue(period.modelUnclassifiedTokens, model, unclassifiedValue(value, rowExact));
      }
      for (const [client, models] of Object.entries(row?.perClientModel || {})) {
        for (const [model, value] of Object.entries(models || {})) {
          addNestedMapValue(period.clientModels, client, model, value?.tokens);
          addNestedMapValue(period.clientModelCosts, client, model, value?.cost);
        }
      }
    }
    period.totalTokens = Math.max(0, Math.round(period.totalTokens));
    period.unclassifiedTokens = Math.max(0, Math.round(period.unclassifiedTokens));
    period.costUsd = Number(period.costUsd.toFixed(6));
    for (const map of [
      period.clients, period.clientCacheReads, period.clientCacheWrites, period.clientOutputs,
      period.clientUnclassifiedTokens, period.models, period.modelCacheReads,
      period.modelCacheWrites, period.modelOutputs, period.modelUnclassifiedTokens
    ]) {
      for (const key of Object.keys(map)) map[key] = Math.max(0, Math.round(map[key]));
    }
    for (const map of [period.clientCosts, period.modelCosts]) {
      for (const key of Object.keys(map)) map[key] = Number(map[key].toFixed(6));
    }
    for (const client of Object.keys(period.clientModels)) {
      for (const model of Object.keys(period.clientModels[client])) {
        period.clientModels[client][model] = Math.max(0, Math.round(period.clientModels[client][model]));
        period.clientModelCosts[client][model] = Number(period.clientModelCosts[client][model].toFixed(6));
      }
    }
    return period;
  }

  function mergePeriods(periods) {
    const list = (Array.isArray(periods) ? periods : []).filter((period) => period && typeof period === 'object');
    const merged = emptyPeriod();
    merged.capabilities = {
      tokenComponents: list.length > 0 && list.every((period) => period.capabilities?.tokenComponents === true),
      clientModels: list.length > 0 && list.every((period) => period.capabilities?.clientModels === true)
    };
    for (const period of list) {
      for (const key of ['totalTokens', 'costUsd', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens']) {
        merged[key] += finiteNumber(period[key]);
      }
      for (const key of [
        'clients', 'clientCosts', 'clientCacheReads', 'clientCacheWrites', 'clientOutputs',
        'clientUnclassifiedTokens', 'models', 'modelCosts', 'modelCacheReads',
        'modelCacheWrites', 'modelOutputs', 'modelUnclassifiedTokens'
      ]) {
        for (const [name, value] of Object.entries(period[key] || {})) addMapValue(merged[key], name, value);
      }
      for (const key of ['clientModels', 'clientModelCosts']) {
        for (const [client, models] of Object.entries(period[key] || {})) {
          for (const [model, value] of Object.entries(models || {})) {
            addNestedMapValue(merged[key], client, model, value);
          }
        }
      }
    }
    merged.totalTokens = Math.max(0, Math.round(merged.totalTokens));
    merged.unclassifiedTokens = Math.max(0, Math.round(merged.unclassifiedTokens));
    merged.costUsd = Number(merged.costUsd.toFixed(6));
    for (const map of [
      merged.clients, merged.clientCacheReads, merged.clientCacheWrites, merged.clientOutputs,
      merged.clientUnclassifiedTokens, merged.models, merged.modelCacheReads,
      merged.modelCacheWrites, merged.modelOutputs, merged.modelUnclassifiedTokens
    ]) {
      for (const key of Object.keys(map)) map[key] = Math.max(0, Math.round(map[key]));
    }
    for (const map of [merged.clientCosts, merged.modelCosts]) {
      for (const key of Object.keys(map)) map[key] = Number(map[key].toFixed(6));
    }
    for (const client of Object.keys(merged.clientModels)) {
      for (const model of Object.keys(merged.clientModels[client])) {
        merged.clientModels[client][model] = Math.max(0, Math.round(merged.clientModels[client][model]));
        merged.clientModelCosts[client][model] = Number(merged.clientModelCosts[client][model].toFixed(6));
      }
    }
    return merged;
  }

  function rangeSummary(daily, options = {}) {
    const rows = dailyRowsForSelection(daily, options);
    const range = rangeForSelection(options.selection, options);
    const activeDates = new Set(rows
      .filter((row) => finiteNumber(row?.tokens) > 0)
      .map((row) => normalizeDateKey(row?.date))
      .filter(Boolean));
    let currentStreak = 0;
    let cursor = range?.end || '';
    while (cursor && activeDates.has(cursor)) {
      currentStreak += 1;
      cursor = dayKeyAddDays(cursor, -1);
    }
    return {
      activeDays: rows.filter((row) => finiteNumber(row?.tokens) > 0).length,
      currentStreak,
      activeTimeMs: rows.reduce((sum, row) => sum + finiteNumber(row?.activeTimeMs), 0),
      peakDayTokens: rows.reduce((peak, row) => Math.max(peak, finiteNumber(row?.tokens)), 0)
    };
  }

  return {
    DEFAULT_MODES,
    DISPLAY_LABELS,
    SLOT_MODES,
    dailyRowsForSelection,
    dayKeyAddDays,
    currentDayKey,
    derivePeriod,
    displayLabel,
    effectiveSelection,
    isDerived,
    localDayKey,
    mergePeriods,
    modeForSlot,
    modeSettingKey,
    normalizeDateKey,
    normalizeDateRange,
    normalizeMode,
    normalizedSettings,
    patchToday,
    rangeForSelection,
    rangeSummary,
    supportsBreakdown,
    weekStartsOn
  };
});
