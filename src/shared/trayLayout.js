'use strict';

(function exposeTrayLayout(root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./currency') : root?.TokenMonitorCurrency,
    typeof module === 'object' && module.exports ? require('./trayText') : root?.TokenMonitorTrayText,
    typeof module === 'object' && module.exports
      ? require('./limitBalanceDisplay')
      : root?.TokenMonitorLimitBalanceDisplay,
    typeof module === 'object' && module.exports
      ? require('./compactMoney')
      : root?.TokenMonitorCompactMoney
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorTrayLayout = api;
})(typeof window !== 'undefined' ? window : globalThis, function createTrayLayoutApi(currencyApi, trayTextApi, balanceDisplay, compactMoneyApi) {
  const VERSION = 3;
  const MAX_ITEMS = 12;
  const STYLE_IDS = Object.freeze([
    'appIcon',
    'providerIcon',
    'singleBar',
    'doubleBar',
    'doublePercent',
    'doubleReset',
    'doubleInfo',
    'percent',
    'percentReset',
    'reset',
    'tokens',
    'cost',
    'account',
    'customText',
    'doubleCustomText',
    'spacer',
    'separatorDot'
  ]);
  const STYLE_SET = new Set(STYLE_IDS);
  const ITEM_TYPES = new Set(['icon', 'bars', 'stack', 'text', 'spacer']);
  const ACCOUNT_MODES = new Set(['lowest', 'active', 'specific']);
  const VALUE_MODES = new Set(['remaining', 'used']);
  const TEXT_METRICS = new Set(['percent', 'percentReset', 'reset', 'tokens', 'cost', 'account', 'custom']);
  const INFO_METRICS = new Set(['percent', 'percentReset', 'reset', 'tokens', 'cost']);
  const STACK_METRICS = new Set(['percent', 'reset', 'mixed', 'custom']);
  const STACK_ALIGNMENTS = new Set(['left', 'right']);
  const FONT_STYLES = new Set(['normal', 'condensed', 'menubar', 'compactMono']);
  const ICON_AUTO_MODES = new Set(['lowestLimit', 'recent', 'tokens', 'cost']);
  const BAR_ICON_MODES = new Set(['app', 'first', 'second', 'none']);
  const SPACER_SIZES = new Set(['narrow', 'regular', 'wide']);
  const SPACER_VARIANTS = new Set(['space', 'dot']);
  const COST_FORMATS = new Set(['compact', 'full']);
  const USAGE_SCOPES = new Set(['all', 'recent']);
  const PERIODS = new Set(['today', 'month', 'allTime']);
  const WINDOW_PRESETS = new Set(['primary', 'secondary', 'session', 'weekly', 'billing']);

  function clean(value, max = 160) {
    return String(value || '').trim().slice(0, max);
  }

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clampPercent(value) {
    const number = finite(value);
    return number === null ? null : Math.max(0, Math.min(100, number));
  }

  function displayPercent(window, valueMode = 'remaining') {
    const remaining = clampPercent(window?.remainingPercent);
    const used = clampPercent(window?.usedPercent);
    if (valueMode === 'used') {
      if (remaining !== null) return 100 - remaining;
      return used;
    }
    if (remaining !== null) return remaining;
    return used === null ? null : 100 - used;
  }

  function remainingPercent(window) {
    return displayPercent(window, 'remaining');
  }

  // Credits windows carry money, not a wire percentage. Derive one so they can
  // still fill a bar and take part in "which quota is tightest" comparisons.
  function windowPercent(provider, window) {
    return balanceDisplay.isCreditsWindow(window)
      ? balanceDisplay.creditsMeterPercent(provider, window)
      : remainingPercent(window);
  }

  function normalizeWindowSelector(value, fallback = 'primary') {
    const selector = clean(value);
    if (WINDOW_PRESETS.has(selector) || /^exact\|[^|]{1,24}\|.{0,120}$/.test(selector)) return selector;
    return fallback;
  }

  function windowKey(window) {
    const kind = clean(window?.kind, 24) || 'other';
    const label = clean(window?.label, 120);
    return `exact|${kind}|${label}`;
  }

  function sourceDefaults(window = 'primary') {
    return {
      provider: 'auto',
      accountMode: 'lowest',
      accountKey: '',
      window,
      valueMode: 'remaining'
    };
  }

  function normalizeCostDisplay(input = {}, defaults = {}) {
    const format = clean(input.costFormat, 24);
    const defaultFormat = COST_FORMATS.has(defaults.costFormat) ? defaults.costFormat : 'compact';
    const defaultDecimals = defaults.costDecimals === 'auto' ? 'auto' : 2;
    const decimals = input.costDecimals === 'auto'
      ? 'auto'
      : input.costDecimals === null || input.costDecimals === '' || input.costDecimals === undefined
        ? defaultDecimals
        : finite(input.costDecimals);
    return {
      costFormat: COST_FORMATS.has(format) ? format : defaultFormat,
      costDecimals: decimals === 'auto'
        ? 'auto'
        : decimals === null ? defaultDecimals : Math.max(0, Math.min(4, Math.round(decimals)))
    };
  }

  function normalizeUsageScope(value) {
    const scope = clean(value, 24);
    return USAGE_SCOPES.has(scope) ? scope : 'all';
  }

  function normalizeSource(input, fallbackWindow = 'primary') {
    const source = input && typeof input === 'object' ? input : {};
    const provider = clean(source.provider, 48).toLowerCase();
    const accountMode = clean(source.accountMode, 24);
    const valueMode = clean(source.valueMode, 24);
    return {
      provider: provider || 'auto',
      accountMode: ACCOUNT_MODES.has(accountMode) ? accountMode : 'lowest',
      accountKey: clean(source.accountKey),
      window: normalizeWindowSelector(source.window, fallbackWindow),
      valueMode: VALUE_MODES.has(valueMode) ? valueMode : 'remaining'
    };
  }

  function infoRowDefaults(metric = 'percent', window = 'primary') {
    const row = {
      ...sourceDefaults(window),
      metric: INFO_METRICS.has(metric) ? metric : 'percent',
      period: 'today'
    };
    if (row.metric === 'cost') return { ...row, usageScope: 'all', ...normalizeCostDisplay() };
    return row.metric === 'tokens' ? { ...row, usageScope: 'all' } : row;
  }

  function normalizeInfoRow(input, fallbackMetric = 'percent', fallbackWindow = 'primary', options = {}) {
    const row = input && typeof input === 'object' ? input : {};
    const metric = clean(row.metric, 24);
    const normalized = {
      ...normalizeSource(row, fallbackWindow),
      metric: INFO_METRICS.has(metric) ? metric : fallbackMetric,
      period: PERIODS.has(row.period) ? row.period : 'today'
    };
    if (normalized.metric === 'cost') {
      return {
        ...normalized,
        usageScope: normalizeUsageScope(row.usageScope),
        ...normalizeCostDisplay(row, options.costDefaults)
      };
    }
    return normalized.metric === 'tokens'
      ? { ...normalized, usageScope: normalizeUsageScope(row.usageScope) }
      : normalized;
  }

  function normalizeBarIcon(value, rowCount = 1) {
    const mode = clean(value, 24);
    if (!BAR_ICON_MODES.has(mode)) return 'first';
    if (mode === 'second' && rowCount < 2) return 'first';
    return mode;
  }

  function normalizeFontStyle(value) {
    const style = clean(value, 24);
    return FONT_STYLES.has(style) ? style : 'normal';
  }

  function normalizeIconAutoMode(value) {
    const mode = clean(value, 24);
    return ICON_AUTO_MODES.has(mode) ? mode : 'lowestLimit';
  }

  function normalizeSpacerSize(value) {
    const size = clean(value, 24);
    return SPACER_SIZES.has(size) ? size : 'regular';
  }

  function normalizeSpacerVariant(value, style = '') {
    const variant = clean(value, 24);
    if (SPACER_VARIANTS.has(variant)) return variant;
    return style === 'separatorDot' ? 'dot' : 'space';
  }

  function nextItemId(idFactory) {
    if (typeof idFactory === 'function') return clean(idFactory(), 80) || 'item';
    return `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function createTrayLayoutItem(style, options = {}) {
    const id = nextItemId(options.idFactory);
    const styleId = STYLE_SET.has(style) ? style : 'singleBar';
    if (styleId === 'appIcon') {
      return {
        id,
        type: 'icon',
        style: styleId,
        icon: 'app',
        autoMode: 'lowestLimit',
        period: 'today',
        source: sourceDefaults()
      };
    }
    if (styleId === 'providerIcon') {
      return {
        id,
        type: 'icon',
        style: styleId,
        icon: 'provider',
        autoMode: 'lowestLimit',
        period: 'today',
        source: sourceDefaults()
      };
    }
    if (styleId === 'singleBar') {
      return { id, type: 'bars', style: styleId, icon: 'first', rows: [sourceDefaults('primary')] };
    }
    if (styleId === 'doubleBar') {
      return {
        id,
        type: 'bars',
        style: styleId,
        icon: 'first',
        rows: [sourceDefaults('primary'), sourceDefaults('secondary')]
      };
    }
    if (styleId === 'doublePercent' || styleId === 'doubleReset') {
      return {
        id,
        type: 'stack',
        style: styleId,
        metric: styleId === 'doubleReset' ? 'reset' : 'percent',
        icon: 'first',
        fontStyle: 'normal',
        alignment: styleId === 'doubleReset' ? 'left' : 'right',
        alignmentCustomized: false,
        rows: [sourceDefaults('primary'), sourceDefaults('secondary')]
      };
    }
    if (styleId === 'doubleInfo') {
      return {
        id,
        type: 'stack',
        style: styleId,
        metric: 'mixed',
        icon: 'first',
        fontStyle: 'normal',
        alignment: 'left',
        alignmentCustomized: false,
        rows: [infoRowDefaults('percent'), infoRowDefaults('reset')]
      };
    }
    if (styleId === 'doubleCustomText') {
      return {
        id,
        type: 'stack',
        style: styleId,
        metric: 'custom',
        icon: 'none',
        fontStyle: 'normal',
        alignment: 'left',
        alignmentCustomized: false,
        lines: ['Text', 'Text']
      };
    }
    if (styleId === 'customText') {
      return {
        id,
        type: 'text',
        style: styleId,
        metric: 'custom',
        fontStyle: 'normal',
        text: 'Text'
      };
    }
    if (styleId === 'spacer' || styleId === 'separatorDot') {
      return {
        id,
        type: 'spacer',
        style: styleId,
        variant: styleId === 'separatorDot' ? 'dot' : 'space',
        size: 'regular'
      };
    }
    const metric = {
      percent: 'percent',
      percentReset: 'percentReset',
      reset: 'reset',
      tokens: 'tokens',
      cost: 'cost',
      account: 'account'
    }[styleId];
    const item = {
      id,
      type: 'text',
      style: styleId,
      metric,
      fontStyle: 'normal',
      period: 'today',
      source: sourceDefaults()
    };
    if (metric === 'cost') return { ...item, usageScope: 'all', ...normalizeCostDisplay() };
    return metric === 'tokens' ? { ...item, usageScope: 'all' } : item;
  }

  function normalizeItem(input, index = 0, options = {}) {
    if (!input || typeof input !== 'object') return null;
    const type = clean(input.type, 24);
    if (!ITEM_TYPES.has(type)) return null;
    const style = STYLE_SET.has(input.style) ? input.style : (
      type === 'icon' ? (input.icon === 'provider' ? 'providerIcon' : 'appIcon')
        : type === 'bars' ? ((input.rows || []).length > 1 ? 'doubleBar' : 'singleBar')
          : type === 'stack' ? (
            input.metric === 'custom' ? 'doubleCustomText'
              : input.metric === 'mixed' ? 'doubleInfo'
              : input.metric === 'reset' ? 'doubleReset' : 'doublePercent'
          )
            : type === 'spacer' ? (input.variant === 'dot' ? 'separatorDot' : 'spacer')
              : TEXT_METRICS.has(input.metric) ? input.metric : 'percent'
    );
    const id = clean(input.id, 80) || `item-${index + 1}`;
    if (type === 'icon') {
      return {
        id,
        type,
        style,
        icon: input.icon === 'provider' ? 'provider' : 'app',
        autoMode: normalizeIconAutoMode(input.autoMode),
        period: PERIODS.has(input.period) ? input.period : 'today',
        source: normalizeSource(input.source)
      };
    }
    if (type === 'bars') {
      const rows = Array.isArray(input.rows) ? input.rows.slice(0, 2) : [];
      const normalizedRows = rows.map((row, rowIndex) => normalizeSource(row, rowIndex === 0 ? 'primary' : 'secondary'));
      return {
        id,
        type,
        style: normalizedRows.length > 1 ? 'doubleBar' : 'singleBar',
        icon: normalizeBarIcon(input.icon, normalizedRows.length),
        rows: normalizedRows.length ? normalizedRows : [sourceDefaults()]
      };
    }
    if (type === 'stack') {
      const metric = STACK_METRICS.has(input.metric)
        ? input.metric
        : style === 'doubleCustomText' ? 'custom'
          : style === 'doubleInfo' ? 'mixed'
          : style === 'doubleReset' ? 'reset' : 'percent';
      const alignmentCustomized = input.alignmentCustomized === true;
      const defaultAlignment = metric === 'percent' ? 'right' : 'left';
      if (metric === 'custom') {
        const lines = Array.isArray(input.lines) ? input.lines.slice(0, 2) : [];
        while (lines.length < 2) lines.push('Text');
        return {
          id,
          type,
          style: 'doubleCustomText',
          metric,
          icon: 'none',
          fontStyle: normalizeFontStyle(input.fontStyle),
          alignment: alignmentCustomized && STACK_ALIGNMENTS.has(input.alignment)
            ? input.alignment
            : defaultAlignment,
          alignmentCustomized,
          lines: lines.map((line) => clean(line, 40))
        };
      }
      if (metric === 'mixed') {
        const rows = Array.isArray(input.rows) ? input.rows.slice(0, 2) : [];
        const normalizedRows = rows.map((row, rowIndex) => normalizeInfoRow(
          row,
          rowIndex === 0 ? 'percent' : 'reset',
          'primary',
          options
        ));
        while (normalizedRows.length < 2) {
          normalizedRows.push(infoRowDefaults(normalizedRows.length === 0 ? 'percent' : 'reset'));
        }
        return {
          id,
          type,
          style: 'doubleInfo',
          metric,
          icon: normalizeBarIcon(input.icon, normalizedRows.length),
          fontStyle: normalizeFontStyle(input.fontStyle),
          alignment: alignmentCustomized && STACK_ALIGNMENTS.has(input.alignment)
            ? input.alignment
            : defaultAlignment,
          alignmentCustomized,
          rows: normalizedRows
        };
      }
      const rows = Array.isArray(input.rows) ? input.rows.slice(0, 2) : [];
      const normalizedRows = rows.map((row, rowIndex) => normalizeSource(row, rowIndex === 0 ? 'primary' : 'secondary'));
      while (normalizedRows.length < 2) {
        normalizedRows.push(sourceDefaults(normalizedRows.length === 0 ? 'primary' : 'secondary'));
      }
      return {
        id,
        type,
        style: metric === 'reset' ? 'doubleReset' : 'doublePercent',
        metric,
        icon: normalizeBarIcon(input.icon, normalizedRows.length),
        fontStyle: normalizeFontStyle(input.fontStyle),
        alignment: alignmentCustomized && STACK_ALIGNMENTS.has(input.alignment)
          ? input.alignment
          : defaultAlignment,
        alignmentCustomized,
        rows: normalizedRows
      };
    }
    if (type === 'spacer') {
      const variant = normalizeSpacerVariant(input.variant, style);
      return {
        id,
        type,
        style: variant === 'dot' ? 'separatorDot' : 'spacer',
        variant,
        size: normalizeSpacerSize(input.size)
      };
    }
    const metric = TEXT_METRICS.has(input.metric) ? input.metric : 'percent';
    if (metric === 'custom' || style === 'customText') {
      return {
        id,
        type,
        style: 'customText',
        metric: 'custom',
        fontStyle: normalizeFontStyle(input.fontStyle),
        text: clean(input.text, 40)
      };
    }
    const period = PERIODS.has(input.period) ? input.period : 'today';
    const normalized = {
      id,
      type,
      style: STYLE_SET.has(style) ? style : metric,
      metric,
      fontStyle: normalizeFontStyle(input.fontStyle),
      period,
      source: normalizeSource(input.source)
    };
    if (metric === 'cost') {
      return {
        ...normalized,
        usageScope: normalizeUsageScope(input.usageScope),
        ...normalizeCostDisplay(input, options.costDefaults)
      };
    }
    return metric === 'tokens'
      ? { ...normalized, usageScope: normalizeUsageScope(input.usageScope) }
      : normalized;
  }

  function uniqueItemId(value, usedIds) {
    const base = clean(value, 80) || 'item';
    if (!usedIds.has(base)) return base;
    let suffix = 2;
    let candidate;
    do {
      const ending = `-${suffix}`;
      candidate = `${base.slice(0, 80 - ending.length)}${ending}`;
      suffix += 1;
    } while (usedIds.has(candidate));
    return candidate;
  }

  function createDefaultTrayLayout() {
    return {
      version: VERSION,
      items: [
        createTrayLayoutItem('appIcon', { idFactory: () => 'app-icon' })
      ]
    };
  }

  function normalizeTrayLayout(input, fallback = createDefaultTrayLayout()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return normalizeTrayLayout(fallback, { version: VERSION, items: [] });
    }
    const items = [];
    const usedIds = new Set();
    const sourceVersion = finite(input.version);
    const normalizeOptions = sourceVersion === null || sourceVersion < 3
      ? { costDefaults: { costFormat: 'full', costDecimals: 'auto' } }
      : {};
    for (const candidate of Array.isArray(input.items) ? input.items : []) {
      const item = normalizeItem(candidate, items.length, normalizeOptions);
      if (!item) continue;
      item.id = uniqueItemId(item.id, usedIds);
      usedIds.add(item.id);
      items.push(item);
      if (items.length >= MAX_ITEMS) break;
    }
    return { version: VERSION, items };
  }

  function replaceTrayLayoutItem(layout, itemId, patch) {
    const normalized = normalizeTrayLayout(layout);
    const index = normalized.items.findIndex((item) => item.id === itemId);
    if (index < 0) return normalized;
    const next = normalizeItem({ ...normalized.items[index], ...(patch || {}), id: itemId }, index);
    if (!next) return normalized;
    normalized.items[index] = next;
    return normalized;
  }

  function removeTrayLayoutItem(layout, itemId) {
    const normalized = normalizeTrayLayout(layout);
    normalized.items = normalized.items.filter((item) => item.id !== itemId);
    return normalized;
  }

  function appendTrayLayoutItem(layout, style, options = {}) {
    const normalized = normalizeTrayLayout(layout);
    if (normalized.items.length >= MAX_ITEMS) return normalized;
    normalized.items.push(createTrayLayoutItem(style, options));
    return normalized;
  }

  function moveTrayLayoutItem(layout, itemId, targetIndex) {
    const normalized = normalizeTrayLayout(layout);
    const from = normalized.items.findIndex((item) => item.id === itemId);
    if (from < 0) return normalized;
    const [item] = normalized.items.splice(from, 1);
    const to = Math.max(0, Math.min(normalized.items.length, Math.round(Number(targetIndex) || 0)));
    normalized.items.splice(to, 0, item);
    return normalized;
  }

  function providerId(provider) {
    return clean(provider?.provider, 48).toLowerCase();
  }

  function usableProvider(provider) {
    return provider && provider.status === 'ok' && !provider.stale;
  }

  function providersFromStats(stats) {
    return (Array.isArray(stats?.limits?.providers) ? stats.limits.providers : []).filter(usableProvider);
  }

  function providerOptions(stats) {
    const seen = new Set();
    const options = [];
    for (const provider of providersFromStats(stats)) {
      const id = providerId(provider);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      options.push({ value: id, provider: id });
    }
    return options;
  }

  function accountLabel(provider) {
    return clean(
      provider?.accountEmail
      || provider?.accountName
      || provider?.accountLabel
      || provider?.planLabel
      || provider?.accountKey
    ) || providerId(provider);
  }

  function accountOptions(stats, selectedProvider) {
    const id = clean(selectedProvider, 48).toLowerCase();
    const seen = new Set();
    const options = [];
    for (const provider of providersFromStats(stats)) {
      if (providerId(provider) !== id) continue;
      const key = clean(provider.accountKey) || `${id}:${accountLabel(provider)}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      options.push({ value: key, label: accountLabel(provider), provider });
    }
    return options;
  }

  function windowOptions(stats, selectedProvider, accountKey = '') {
    const id = clean(selectedProvider, 48).toLowerCase();
    const key = clean(accountKey);
    const seen = new Set();
    const options = [];
    for (const provider of providersFromStats(stats)) {
      if (id && id !== 'auto' && providerId(provider) !== id) continue;
      if (key && clean(provider.accountKey) !== key) continue;
      for (const window of provider.windows || []) {
        if (!window || window.showMeter === false || windowPercent(provider, window) === null) continue;
        const value = windowKey(window);
        if (seen.has(value)) continue;
        seen.add(value);
        options.push({
          value,
          kind: clean(window.kind, 24),
          label: clean(window.label, 120),
          window
        });
      }
    }
    return options;
  }

  function selectionIdentity(selection) {
    if (!selection) return '';
    return [
      selection.provider,
      clean(selection.providerRecord?.accountKey),
      windowKey(selection.window)
    ].join('|');
  }

  function sourceWindowOptions(stats, source, options = {}) {
    const normalized = normalizeSource(source);
    if (normalized.provider !== 'auto') {
      const accountKey = normalized.accountMode === 'specific' ? normalized.accountKey : '';
      const selected = selectSource(stats, normalized, options);
      const selectedKey = selected ? windowKey(selected.window) : '';
      return windowOptions(stats, normalized.provider, accountKey)
        .map((entry) => ({
          ...entry,
          selection: selectSource(stats, { ...normalized, window: entry.value }, options)
        }))
        .filter((entry) => entry.selection)
        .sort((left, right) => (
          Number(right.value === selectedKey) - Number(left.value === selectedKey)
        ));
    }

    const selectors = [
      normalized.window,
      'primary',
      'secondary',
      'session',
      'weekly',
      'billing'
    ].filter((value, index, values) => values.indexOf(value) === index);
    const seen = new Set();
    const choices = [];
    for (const selector of selectors) {
      const selection = selectSource(stats, { ...normalized, window: selector }, options);
      const identity = selectionIdentity(selection);
      if (!selection || seen.has(identity)) continue;
      seen.add(identity);
      choices.push({
        value: selector,
        kind: clean(selection.window?.kind, 24),
        label: clean(selection.window?.label, 120),
        window: selection.window,
        selection
      });
    }
    return choices;
  }

  function meteredWindows(provider) {
    return (provider?.windows || []).filter((window) => (
      window && window.showMeter !== false && windowPercent(provider, window) !== null
    ));
  }

  function preferredWindow(provider, kind) {
    const windows = meteredWindows(provider).filter((window) => !kind || window.kind === kind);
    if (windows.length < 2) return windows[0] || null;
    const canonicalLabels = kind === 'weekly' ? new Set(['', 'weekly'])
      : kind === 'billing' ? new Set(['', 'total'])
        : new Set(['']);
    return windows.find((window) => canonicalLabels.has(clean(window.label).toLowerCase()))
      || windows.reduce((pick, window) => (
        !pick || windowPercent(provider, window) < windowPercent(provider, pick) ? window : pick
      ), null);
  }

  function selectWindow(provider, selector) {
    const normalized = normalizeWindowSelector(selector);
    if (normalized.startsWith('exact|')) {
      return meteredWindows(provider).find((window) => windowKey(window) === normalized) || null;
    }
    if (normalized === 'session' || normalized === 'weekly' || normalized === 'billing') {
      return preferredWindow(provider, normalized);
    }
    const primary = preferredWindow(provider, 'session')
      || preferredWindow(provider, 'weekly')
      || preferredWindow(provider, 'billing')
      || meteredWindows(provider)[0]
      || null;
    if (normalized === 'primary') return primary;
    if (normalized === 'secondary') {
      if (!primary) return null;
      return meteredWindows(provider).find((window) => window !== primary) || null;
    }
    return primary;
  }

  function activeAccountCandidate(provider, options = {}) {
    const id = providerId(provider);
    const requestedKey = clean(options.activeAccountKeys?.[id]);
    if (requestedKey) return clean(provider.accountKey) === requestedKey;
    if (id !== 'codex') return true;
    return !['managed'].includes(clean(provider.sourceDetail).toLowerCase());
  }

  function selectSource(stats, source, options = {}) {
    const normalized = normalizeSource(source);
    let candidates = providersFromStats(stats);
    if (normalized.provider !== 'auto') {
      candidates = candidates.filter((provider) => providerId(provider) === normalized.provider);
    }
    if (normalized.accountMode === 'active') {
      candidates = candidates.filter((provider) => activeAccountCandidate(provider, options));
    } else if (normalized.accountMode === 'specific') {
      candidates = candidates.filter((provider) => clean(provider.accountKey) === normalized.accountKey);
    }
    let selected = null;
    for (const provider of candidates) {
      const window = selectWindow(provider, normalized.window);
      if (!window) continue;
      const remaining = windowPercent(provider, window);
      if (!selected || remaining < selected.remaining) {
        const credits = balanceDisplay.isCreditsWindow(window);
        selected = {
          provider: providerId(provider),
          providerRecord: provider,
          window,
          remaining,
          percent: credits
            ? (normalized.valueMode === 'used' ? 100 - remaining : remaining)
            : displayPercent(window, normalized.valueMode),
          // A balance's headline value is money; percent styles print this
          // instead of a percentage derived from lifetime spend.
          moneyText: credits
            ? balanceDisplay.formatCompactMoney(
                balanceDisplay.creditsAmount(provider, window),
                balanceDisplay.creditsCurrency(provider, window)
              )
            : '',
          source: normalized
        };
      }
    }
    return selected;
  }

  function formatPercent(value) {
    const percent = clampPercent(value);
    return percent === null ? '--' : `${Math.round(percent)}%`;
  }

  function formatResetCountdown(value, nowMs = Date.now()) {
    const resetMs = Date.parse(value || '');
    const current = Number(nowMs);
    if (!Number.isFinite(resetMs) || !Number.isFinite(current)) return '';
    const remainingMinutes = Math.max(0, Math.ceil((resetMs - current) / 60000));
    if (remainingMinutes < 60) return `${remainingMinutes}m`;
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    if (hours < 24) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  function trayLayoutNeedsClock(layout) {
    return normalizeTrayLayout(layout).items.some((item) => {
      if (item.type === 'text') {
        return item.metric === 'reset' || item.metric === 'percentReset';
      }
      if (item.type !== 'stack') return false;
      if (item.metric === 'reset') return true;
      return item.metric === 'mixed' && item.rows.some((row) => (
        row.metric === 'reset' || row.metric === 'percentReset'
      ));
    });
  }

  function formatCompactNumber(value, options) {
    if (trayTextApi?.formatCompactNumber) return trayTextApi.formatCompactNumber(value, options);
    const number = Math.round(Number(value) || 0);
    if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
    return String(number);
  }

  function formatCost(value, item, options) {
    const display = normalizeCostDisplay(item);
    if (!compactMoneyApi?.formatCompactCurrencyFromUsd) {
      return currencyApi?.formatCurrencyFromUsd?.(value, options.currency || 'USD')
        || String(Number(value) || 0);
    }
    return compactMoneyApi.formatCompactCurrencyFromUsd(
      value,
      options.currency || 'USD',
      options.compactTokenUnits,
      options.locale || options.language || 'en',
      {
        compact: display.costFormat !== 'full',
        fractionDigits: display.costDecimals
      }
    );
  }

  function resolveUsageValue(item, stats, recentProvider) {
    const period = stats?.periods?.[item.period] || {};
    if (normalizeUsageScope(item.usageScope) !== 'recent') {
      return {
        available: true,
        provider: null,
        value: item.metric === 'tokens' ? period.totalTokens : period.costUsd
      };
    }
    const provider = recentProvider || null;
    if (!provider) return { available: false, provider: null, value: 0 };
    return {
      available: true,
      provider,
      value: item.metric === 'tokens'
        ? Number(period.clients?.[provider]) || 0
        : Number(period.clientCosts?.[provider]) || 0
    };
  }

  function resolveTextItem(item, stats, options, recentProvider = null) {
    if (item.metric === 'custom') {
      const text = clean(item.text, 40);
      return { ...item, available: Boolean(text), text: text || '--' };
    }
    if (item.metric === 'tokens' || item.metric === 'cost') {
      const usage = resolveUsageValue(item, stats, recentProvider);
      if (!usage.available) {
        return { ...item, available: false, text: '--', provider: null };
      }
      const text = item.metric === 'tokens'
        ? formatCompactNumber(usage.value, options)
        : formatCost(usage.value, item, options);
      return { ...item, available: true, text, provider: usage.provider };
    }
    const selection = selectSource(stats, item.source, options);
    if (!selection) return { ...item, available: false, text: '--', selection: null };
    const reset = formatResetCountdown(selection.window.resetsAt, options.nowMs);
    const headline = selection.moneyText || formatPercent(selection.percent);
    let text;
    if (item.metric === 'percent') text = headline;
    else if (item.metric === 'percentReset') text = [headline, reset].filter(Boolean).join(' · ');
    else if (item.metric === 'reset') text = reset || '--';
    else text = accountLabel(selection.providerRecord) || selection.provider;
    return { ...item, available: Boolean(text && text !== '--'), text: text || '--', selection };
  }

  function preferredRowProvider(rows, preferredIndex = 0) {
    const providerFor = (row) => clean(row?.selection?.provider || row?.provider, 48).toLowerCase();
    const preferred = Array.isArray(rows) ? rows[preferredIndex] : null;
    return providerFor(preferred)
      || providerFor((rows || []).find((row) => providerFor(row)))
      || '';
  }

  function resolveTrayLayout(layout, stats, options = {}) {
    const normalized = normalizeTrayLayout(layout);
    const usesRecentProvider = normalized.items.some((item) => (
      (item.type === 'icon' && item.autoMode === 'recent')
      || (item.type === 'text' && item.usageScope === 'recent')
      || (item.type === 'stack' && item.metric === 'mixed'
        && item.rows.some((row) => row.usageScope === 'recent'))
    ));
    const recentProvider = usesRecentProvider
      ? trayTextApi?.pickRecentUsageProviderId?.(stats) || null
      : null;
    const recentIconProvider = recentProvider && (
      !Array.isArray(options.availableProviderIds)
      || options.availableProviderIds.includes(recentProvider)
    ) ? recentProvider : null;
    return {
      version: VERSION,
      items: normalized.items.map((item) => {
        if (item.type === 'icon') {
          if (item.icon === 'app') return { ...item, available: true, provider: 'app', selection: null };
          const fixedProvider = item.source.provider !== 'auto' ? item.source.provider : '';
          if (fixedProvider) {
            return {
              ...item,
              available: true,
              provider: fixedProvider,
              selection: null
            };
          }
          if (item.autoMode === 'recent' || item.autoMode === 'tokens' || item.autoMode === 'cost') {
            const provider = item.autoMode === 'recent'
              ? recentIconProvider
              : trayTextApi?.pickUsageProviderId?.(
                  stats,
                  item.autoMode,
                  item.period,
                  options.availableProviderIds
                );
            return {
              ...item,
              available: true,
              provider: provider || 'app',
              selection: null
            };
          }
          const selection = selectSource(stats, item.source, options);
          return {
            ...item,
            available: true,
            provider: selection?.provider || 'app',
            selection
          };
        }
        if (item.type === 'bars') {
          const rows = item.rows.map((source) => {
            const selection = selectSource(stats, source, options);
            return {
              source,
              available: Boolean(selection),
              percent: selection?.percent ?? null,
              selection
            };
          });
          return { ...item, available: rows.some((row) => row.available), rows };
        }
        if (item.type === 'stack') {
          if (item.metric === 'custom') {
            const rows = item.lines.map((text) => ({
              available: Boolean(text),
              text: text || '--',
              selection: null
            }));
            return { ...item, available: rows.some((row) => row.available), rows };
          }
          if (item.metric === 'mixed') {
            const rows = item.rows.map((source) => {
              const resolved = resolveTextItem({
                ...source,
                type: 'text',
                style: source.metric,
                metric: source.metric,
                period: source.period,
                source
              }, stats, options, recentProvider);
              return {
                source,
                available: resolved.available,
                text: resolved.text,
                provider: resolved.provider || null,
                selection: resolved.selection || null
              };
            });
            return { ...item, available: rows.some((row) => row.available), rows };
          }
          const rows = item.rows.map((source) => {
            const selection = selectSource(stats, source, options);
            const text = !selection
              ? '--'
              : item.metric === 'reset'
                ? formatResetCountdown(selection.window.resetsAt, options.nowMs) || '--'
                : formatPercent(selection.percent);
            return {
              source,
              available: Boolean(selection && text !== '--'),
              text,
              selection
            };
          });
          return { ...item, available: rows.some((row) => row.available), rows };
        }
        if (item.type === 'spacer') return { ...item, available: true };
        return resolveTextItem(item, stats, options, recentProvider);
      })
    };
  }

  return {
    MAX_ITEMS,
    STYLE_IDS,
    VERSION,
    accountOptions,
    appendTrayLayoutItem,
    createDefaultTrayLayout,
    createTrayLayoutItem,
    displayPercent,
    formatResetCountdown,
    moveTrayLayoutItem,
    normalizeSource,
    normalizeTrayLayout,
    providerOptions,
    preferredRowProvider,
    removeTrayLayoutItem,
    replaceTrayLayoutItem,
    resolveTrayLayout,
    selectSource,
    sourceWindowOptions,
    trayLayoutNeedsClock,
    windowKey,
    windowOptions
  };
});
