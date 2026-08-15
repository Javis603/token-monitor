'use strict';

const { KNOWN_CLIENTS } = require('./clientTracking');
const { LIMIT_PROVIDER_IDS, VALID_LIMIT_WINDOW_METRICS } = require('./limitProviders');

const MAC_WIDGET_SCHEMA_VERSION = 6;
const MAC_WIDGET_FRESHNESS_HEARTBEAT_MS = 5 * 60 * 1000;
const KNOWN_TOOLS = new Set(KNOWN_CLIENTS.split(',').filter(Boolean));
const KNOWN_LIMIT_PROVIDERS = new Set(LIMIT_PROVIDER_IDS);
const KNOWN_LIMIT_STATUSES = new Set([
  'ok', 'disabled', 'notConfigured', 'unauthorized', 'rateLimited',
  'sourceRateLimited', 'unavailable', 'error'
]);
const KNOWN_WINDOW_KINDS = new Set(['session', 'weekly', 'billing']);
const CURRENCIES = Object.freeze({ USD: '$', TWD: 'NT$', HKD: 'HK$', CNY: '¥' });

function finiteNumber(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  return Math.max(0, finiteNumber(value, fallback));
}

function normalizedPercent(value) {
  const number = optionalFiniteNumber(value);
  if (number === null) return null;
  return Math.max(0, Math.min(100, number));
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sourceTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validSourceDevice(device) {
  return Boolean(
    device
    && typeof device === 'object'
    && (
      String(device.deviceId || device.id || '').trim()
      || (device.periods && typeof device.periods === 'object')
      || sourceTimestamp(device.receivedAt) !== null
      || sourceTimestamp(device.updatedAt) !== null
    )
  );
}

function resolveWidgetSourceFreshness(stats, _now = new Date()) {
  const devices = Array.isArray(stats?.devices) ? stats.devices.filter(validSourceDevice) : [];
  if (devices.length > 0) {
    const deviceTimes = devices.map((device) => (
      sourceTimestamp(device.receivedAt) ?? sourceTimestamp(device.updatedAt)
    )).filter((value) => value !== null);
    const newest = deviceTimes.length > 0 ? Math.max(...deviceTimes) : null;
    return {
      sourceUpdatedAt: newest === null
        ? normalizedIso(stats?.updatedAt || stats?.generatedAt)
        : new Date(newest).toISOString(),
      sourceStale: devices.every((device) => device.stale === true)
    };
  }

  return {
    sourceUpdatedAt: normalizedIso(stats?.updatedAt || stats?.generatedAt),
    sourceStale: Boolean(stats?.stale)
  };
}

function normalizedStatus(value) {
  const status = String(value || '').trim();
  return KNOWN_LIMIT_STATUSES.has(status) ? status : 'error';
}

function safeDisplayName(value, fallback = '') {
  const raw = String(value || '').trim();
  if (isLikelySensitivePathOrUrl(raw)) return fallback;
  const name = raw.replace(/\s+/g, ' ').slice(0, 80);
  if (!name || name.includes('@')) return fallback;
  return name;
}

function isLikelySensitivePathOrUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 80 || /[\u0000-\u001f\u007f]/.test(raw)) return true;
  return Boolean(
    /^\\\\/.test(raw)
    || raw.startsWith('/')
    || /^(?:file|https?):\/\//i.test(raw)
    || /^(?:~|\.{1,2})[\\/]/.test(raw)
    || /^[A-Za-z]:[\\/]/.test(raw)
    || /(?:^|[\\/])(?:\.\.?)(?:[\\/]|$)/.test(raw)
    || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)
  );
}

function periodStats(stats, period) {
  const value = stats?.periods?.[period];
  return value && typeof value === 'object' ? value : {};
}

function buildTools(period) {
  const tokensByTool = period?.clients && typeof period.clients === 'object' ? period.clients : {};
  const costsByTool = period?.clientCosts && typeof period.clientCosts === 'object' ? period.clientCosts : {};
  const tools = [];
  for (const tool of KNOWN_TOOLS) {
    const totalTokens = Math.round(nonNegativeNumber(tokensByTool[tool]));
    const costUsd = nonNegativeNumber(costsByTool[tool]);
    if (totalTokens <= 0 && costUsd <= 0) continue;
    tools.push({ id: tool, totalTokens, costUsd });
  }
  return tools.sort((left, right) => (
    right.totalTokens - left.totalTokens
    || right.costUsd - left.costUsd
    || left.id.localeCompare(right.id)
  ));
}

function buildLimitWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const kind = String(window.kind || '').trim().toLowerCase();
  if (!KNOWN_WINDOW_KINDS.has(kind)) return null;
  const usedPercent = normalizedPercent(window.usedPercent);
  const remainingPercent = normalizedPercent(
    window.remainingPercent ?? (usedPercent === null ? null : 100 - usedPercent)
  );
  const metricValue = String(window.metric || '').trim().toLowerCase();
  const metric = VALID_LIMIT_WINDOW_METRICS.has(metricValue) ? metricValue : null;
  const remaining = optionalFiniteNumber(window.remaining);
  const rawCurrency = String(window.currency || '').trim().toUpperCase();
  const currency = /^[A-Z]{3,8}$/.test(rawCurrency) ? rawCurrency : null;
  return {
    kind,
    metric,
    showMeter: window.showMeter !== false,
    usedPercent,
    remainingPercent,
    resetsAt: normalizedIso(window.resetsAt),
    windowMinutes: window.windowMinutes === null || window.windowMinutes === undefined
      ? null
      : nonNegativeNumber(window.windowMinutes),
    ...(remaining === null ? {} : { remaining }),
    ...(currency ? { currency } : {})
  };
}

function buildProviderBalance(provider) {
  const source = provider?.balance;
  if (!source || typeof source !== 'object') return null;
  const amount = optionalFiniteNumber(source.amount);
  const currency = String(source.currency || '').trim().toUpperCase();
  if (amount === null || !Object.hasOwn(CURRENCIES, currency)) return null;
  return { amount, currency };
}

function buildQuota(limits) {
  const providers = Array.isArray(limits?.providers) ? limits.providers : [];
  const candidates = [];
  for (const [inputIndex, provider] of providers.entries()) {
    if (!provider || typeof provider !== 'object') continue;
    const providerId = String(provider.provider || '').trim().toLowerCase();
    if (!KNOWN_LIMIT_PROVIDERS.has(providerId)) continue;
    const windows = Array.isArray(provider.windows)
      ? provider.windows.map(buildLimitWindow).filter(Boolean).slice(0, 2)
      : [];
    const balance = buildProviderBalance(provider);
    const accountKey = String(provider.accountKey || '').trim();
    const source = String(provider.source || '').trim().toLowerCase();
    const sourceDetail = String(provider.sourceDetail || '').trim().toLowerCase();
    const stableRecord = {
      provider: providerId,
      status: normalizedStatus(provider.status),
      balance,
      windows
    };
    candidates.push({
      accountKey,
      identitySortKey: accountKey
        ? `key:${accountKey}`
        : `anonymous:${source}|${sourceDetail}`,
      inputIndex,
      record: {
      provider: providerId,
      status: stableRecord.status,
      updatedAt: normalizedIso(provider.updatedAt),
      ...(balance ? { balance } : {}),
      windows
      }
    });
  }
  candidates.sort((left, right) => (
    left.record.provider.localeCompare(right.record.provider)
    || left.identitySortKey.localeCompare(right.identitySortKey)
    || left.inputIndex - right.inputIndex
  ));
  const providerCounts = new Map();
  const providerTotals = new Map();
  for (const candidate of candidates) {
    providerTotals.set(candidate.record.provider, (providerTotals.get(candidate.record.provider) || 0) + 1);
  }
  const providerOrdinals = new Map();
  const anonymousOrdinals = new Map();
  const identityCounts = new Map();
  const output = candidates.map((candidate) => {
    const providerId = candidate.record.provider;
    providerCounts.set(providerId, (providerCounts.get(providerId) || 0) + 1);
    const providerOrdinal = (providerOrdinals.get(providerId) || 0) + 1;
    providerOrdinals.set(providerId, providerOrdinal);
    const identityKey = `${providerId}|${candidate.identitySortKey}`;
    const identityOrdinal = (identityCounts.get(identityKey) || 0) + 1;
    identityCounts.set(identityKey, identityOrdinal);
    const suffix = identityOrdinal > 1 ? `-${identityOrdinal}` : '';
    let instanceId;
    if (candidate.accountKey) {
      instanceId = `${providerId}-${stableHash(`${identityKey}${suffix}`)}`;
    } else {
      const anonymousOrdinal = (anonymousOrdinals.get(providerId) || 0) + 1;
      anonymousOrdinals.set(providerId, anonymousOrdinal);
      instanceId = providerTotals.get(providerId) === 1
        ? `${providerId}-single`
        : `${providerId}-anonymous-${anonymousOrdinal}`;
    }
    return {
      ...candidate.record,
      instanceId,
      _providerOrdinal: providerOrdinal
    };
  }).map((provider) => ({
    ...provider,
    displayName: `${providerLabel(provider.provider)}${providerCounts.get(provider.provider) > 1 ? ` ${provider._providerOrdinal}` : ''}`
  }));
  return output.sort((left, right) => {
    const leftReady = left.status === 'ok' && (left.balance || left.windows.length) ? 0 : 1;
    const rightReady = right.status === 'ok' && (right.balance || right.windows.length) ? 0 : 1;
    return leftReady - rightReady
      || left.provider.localeCompare(right.provider)
      || left._providerOrdinal - right._providerOrdinal
      || left.instanceId.localeCompare(right.instanceId);
  }).map(({ _providerOrdinal, ...provider }) => provider).slice(0, 10);
}

// Mirrors LIMIT_PROVIDERS in src/electron/renderer/app.js: this is the name the
// widget actually shows, since buildQuota stamps it onto every row as
// displayName and the Swift side prefers that over its own fallback map.
const PROVIDER_LABELS = Object.freeze({
  antigravity: 'Antigravity',
  claude: 'Claude',
  codex: 'Codex',
  commandcode: 'Command Code',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  deepseek: 'DeepSeek',
  grok: 'Grok',
  kiro: 'Kiro',
  kimi: 'Kimi',
  minimax: 'Minimax',
  mimo: 'MiMo',
  ollama: 'Ollama',
  opencode: 'OpenCode',
  openrouter: 'OpenRouter',
  qoder: 'Qoder',
  thirdparty: 'Third-party APIs',
  volcengine: 'Volcengine',
  zai: 'GLM',
  zaiteam: 'GLM Team'
});

function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider;
}

function buildModels(period) {
  const values = period?.models && typeof period.models === 'object' ? period.models : {};
  const costs = period?.modelCosts && typeof period.modelCosts === 'object' ? period.modelCosts : {};
  const rowsByName = new Map();
  for (const [rawName, rawTokens] of Object.entries(values)) {
    const displayName = safeDisplayName(rawName);
    const totalTokens = Math.round(nonNegativeNumber(rawTokens));
    if (!displayName || totalTokens <= 0) continue;
    const key = displayName.normalize('NFKC').toLocaleLowerCase('en-US');
    const existing = rowsByName.get(key);
    if (existing) {
      existing.totalTokens += totalTokens;
      existing.costUsd += nonNegativeNumber(costs[rawName]);
      existing.displayName = existing.displayName.localeCompare(displayName) <= 0 ? existing.displayName : displayName;
    } else {
      rowsByName.set(key, { displayName, totalTokens, costUsd: nonNegativeNumber(costs[rawName]), key });
    }
  }
  const rows = Array.from(rowsByName.values());
  rows.sort((left, right) => right.totalTokens - left.totalTokens || left.displayName.localeCompare(right.displayName));
  const denominator = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  return rows.slice(0, 10).map((row) => ({
    displayName: row.displayName,
    id: `model-${stableHash(row.key)}`,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
    sharePercent: denominator > 0 ? Math.max(0, Math.min(100, row.totalTokens / denominator * 100)) : 0
  }));
}

function normalizedDay(value) {
  const day = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toISOString().slice(0, 10) === day ? day : '';
}

function normalizedDaily(history) {
  const daily = Array.isArray(history?.daily) ? history.daily : [];
  const byDate = new Map();
  for (const entry of daily) {
    const date = normalizedDay(entry?.date);
    if (!date) continue;
    byDate.set(date, {
      date,
      totalTokens: Math.round(nonNegativeNumber(entry?.tokens)),
      costUsd: nonNegativeNumber(entry?.cost)
    });
  }
  return Array.from(byDate.values()).sort((left, right) => left.date.localeCompare(right.date));
}

const MAC_WIDGET_ACTIVITY_DAYS = 182;
const TREND_WINDOW_DAYS = 7;

function localDayKey(date) {
  const value = date instanceof Date ? date : new Date(date || Date.now());
  if (Number.isNaN(value.getTime())) return '';
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function addCalendarDays(day, delta) {
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp + delta * 86_400_000).toISOString().slice(0, 10);
}

function buildActivity(history, period) {
  const daily = normalizedDaily(history).slice(-MAC_WIDGET_ACTIVITY_DAYS);
  const peak = daily.reduce((max, day) => Math.max(max, day.totalTokens), 0);
  return {
    currentPeriod: period,
    activeDays: daily.filter((day) => day.totalTokens > 0).length,
    days: daily.map((day) => ({
      date: day.date,
      intensity: peak > 0 ? Math.max(0, Math.min(4, Math.ceil(day.totalTokens / peak * 4))) : 0,
      totalTokens: day.totalTokens
    }))
  };
}

function buildTrend(history, options = {}) {
  const daily = normalizedDaily(history);
  let points = daily.slice(-28);
  if (options.period === 'today') {
    const today = localDayKey(options.now);
    const livePeriod = options.livePeriod && typeof options.livePeriod === 'object' ? options.livePeriod : {};
    const liveTokens = Math.round(nonNegativeNumber(livePeriod.totalTokens));
    const liveCost = nonNegativeNumber(livePeriod.costUsd);
    if (today && (daily.length > 0 || liveTokens > 0 || liveCost > 0)) {
      const start = addCalendarDays(today, -(TREND_WINDOW_DAYS - 1));
      const byDate = new Map(daily
        .filter((point) => point.date >= start && point.date <= today)
        .map((point) => [point.date, point]));
      points = [];
      for (let offset = -(TREND_WINDOW_DAYS - 1); offset <= 0; offset += 1) {
        const date = addCalendarDays(today, offset);
        const historical = byDate.get(date);
        if (!historical) {
          points.push({
            date,
            totalTokens: date === today ? liveTokens : 0,
            costUsd: date === today ? liveCost : 0
          });
          continue;
        }
        points.push({
          ...historical,
          ...(date === today ? {
            // The graph may already contain part or all of today's usage. Use
            // the greater observation instead of adding live and graph values.
            totalTokens: Math.max(historical.totalTokens, liveTokens),
            costUsd: Math.max(historical.costUsd, liveCost)
          } : {})
        });
      }
    } else {
      points = [];
    }
  }
  const peakTokens = points.reduce((max, point) => Math.max(max, point.totalTokens), 0);
  return {
    startDate: points[0]?.date || null,
    endDate: points.at(-1)?.date || null,
    peakTokens,
    currentTokens: points.at(-1)?.totalTokens || 0,
    points
  };
}

function buildPeriodSnapshot(stats, period, generatedAt, history, sourceUpdatedAt, now) {
  const current = periodStats(stats, period);
  const tools = buildTools(current);
  const models = buildModels(current);
  const activity = buildActivity(history, period);
  const trend = buildTrend(history, { period, livePeriod: current, now });
  const overview = {
    currentPeriod: period,
    totalTokens: Math.round(nonNegativeNumber(current.totalTokens)),
    costUsd: nonNegativeNumber(current.costUsd),
    primaryTool: tools[0]?.id || null,
    updatedAt: sourceUpdatedAt || normalizedIso(stats?.updatedAt) || generatedAt
  };
  return { overview, models, activity, trend };
}

function buildPresentation(source = {}) {
  const currencyCode = String(source.currencyCode || source.currency || 'USD').trim().toUpperCase();
  const safeCurrency = Object.hasOwn(CURRENCIES, currencyCode) ? currencyCode : 'USD';
  const locale = String(source.locale || 'auto').trim();
  return {
    currencyCode: safeCurrency,
    currencySymbol: CURRENCIES[safeCurrency],
    currencyRate: Math.max(0.000001, finiteNumber(source.currencyRate, 1)),
    numberStyle: source.compactNumbers === false ? 'full' : 'compact',
    compactTokenUnits: source.compactTokenUnits === 'localized' ? 'localized' : 'western',
    showCost: source.showCost !== false,
    locale: /^(?:auto|en|zh-CN|zh-TW|ko|ja)$/.test(locale) ? locale : 'auto',
    theme: source.theme === 'custom' ? 'custom' : 'system'
  };
}

function buildStatus({ generatedAt, quota, periods, now, sourceFreshness }) {
  const sourceUpdatedAt = sourceFreshness.sourceUpdatedAt;
  const sourceTime = sourceUpdatedAt ? Date.parse(sourceUpdatedAt) : now.getTime();
  const dataAgeSeconds = Math.max(0, Math.round((now.getTime() - sourceTime) / 1000));
  const statuses = quota.map((provider) => provider.status);
  return {
    isStale: sourceFreshness.sourceStale || dataAgeSeconds > 20 * 60,
    sourceStale: sourceFreshness.sourceStale,
    dataAgeSeconds,
    providerConfigured: statuses.some((status) => !['notConfigured', 'disabled'].includes(status)),
    providerNeedsLogin: statuses.some((status) => status === 'unauthorized'),
    noData: Object.values(periods).every((period) => (
      period.overview.totalTokens === 0
      && period.models.length === 0
      && period.activity.activeDays === 0
    )),
    sourceUpdatedAt,
    snapshotGeneratedAt: generatedAt
  };
}

function buildMacWidgetSnapshot(stats, options = {}) {
  const now = options.now === undefined ? new Date() : new Date(options.now);
  const safeNow = Number.isNaN(now.getTime()) ? new Date() : now;
  const generatedAt = safeNow.toISOString();
  const sourceFreshness = resolveWidgetSourceFreshness(stats, safeNow);
  const presentation = buildPresentation(options.presentation);
  const quota = buildQuota(stats?.limits);
  const history = options.history;
  const periods = {
    day: buildPeriodSnapshot(stats, 'today', generatedAt, history, sourceFreshness.sourceUpdatedAt, safeNow),
    month: buildPeriodSnapshot(stats, 'month', generatedAt, history, sourceFreshness.sourceUpdatedAt, safeNow),
    total: buildPeriodSnapshot(stats, 'allTime', generatedAt, history, sourceFreshness.sourceUpdatedAt, safeNow)
  };
  // The top-level mirror is the schemaVersion 1 shape. Every reader from
  // version 2 on takes `periods.day` and ignores it, so it is pinned to the same
  // period rather than tracking anything: sourcing it from the app's own
  // Today/Month/AllTime tab used to rewrite the snapshot and spend a
  // `WidgetCenter.reloadTimelines()` on a change no widget could render, and
  // WidgetKit reload budgets are finite. Each widget picks its own period
  // through the AppIntent instead.
  const selected = periods.day;
  return {
    schemaVersion: MAC_WIDGET_SCHEMA_VERSION,
    generatedAt,
    periods,
    overview: selected.overview,
    quota,
    models: selected.models,
    activity: selected.activity,
    trend: selected.trend,
    presentation,
    status: buildStatus({ generatedAt, quota, periods, now: safeNow, sourceFreshness })
  };
}

const SNAPSHOT_VOLATILE_KEYS = new Set([
  'generatedAt',
  'snapshotGeneratedAt',
  'dataAgeSeconds',
  'updatedAt',
  'sourceUpdatedAt',
  'isStale'
]);

function stableComparisonValue(value) {
  if (Array.isArray(value)) return value.map(stableComparisonValue);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (SNAPSHOT_VOLATILE_KEYS.has(key)) continue;
    if (value[key] === undefined) continue;
    output[key] = stableComparisonValue(value[key]);
  }
  return output;
}

function stableJson(value) {
  return JSON.stringify(stableComparisonValue(value));
}

function macWidgetSnapshotFingerprint(snapshot) {
  const source = stableJson(snapshot);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function macWidgetSnapshotFingerprintFromSerialized(serialized) {
  try {
    return macWidgetSnapshotFingerprint(JSON.parse(String(serialized)));
  } catch (_) {
    return null;
  }
}

function stableHash(value) {
  const source = String(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`.slice(0, 12);
}

function freshnessSignature(snapshot) {
  return JSON.stringify({
    isStale: Boolean(snapshot?.status?.isStale),
    sourceStale: Boolean(snapshot?.status?.sourceStale)
  });
}

function snapshotGeneratedTime(snapshot) {
  const value = snapshot?.status?.snapshotGeneratedAt || snapshot?.generatedAt;
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function macWidgetSnapshotNeedsWrite(currentSnapshot, previousSnapshot, options = {}) {
  if (!previousSnapshot) return true;
  if (macWidgetSnapshotFingerprint(currentSnapshot) !== macWidgetSnapshotFingerprint(previousSnapshot)) return true;
  if (freshnessSignature(currentSnapshot) !== freshnessSignature(previousSnapshot)) return true;
  const now = Date.parse(options.now || '');
  const previousGeneratedAt = snapshotGeneratedTime(previousSnapshot);
  if (!Number.isFinite(now) || previousGeneratedAt === null) return false;
  return now - previousGeneratedAt >= MAC_WIDGET_FRESHNESS_HEARTBEAT_MS;
}

function serializeMacWidgetSnapshot(stats, options = {}) {
  return `${JSON.stringify(buildMacWidgetSnapshot(stats, options))}\n`;
}

module.exports = {
  MAC_WIDGET_ACTIVITY_DAYS,
  MAC_WIDGET_SCHEMA_VERSION,
  MAC_WIDGET_FRESHNESS_HEARTBEAT_MS,
  buildMacWidgetSnapshot,
  resolveWidgetSourceFreshness,
  isLikelySensitivePathOrUrl,
  macWidgetSnapshotFingerprint,
  macWidgetSnapshotFingerprintFromSerialized,
  macWidgetSnapshotNeedsWrite,
  safeDisplayName,
  serializeMacWidgetSnapshot
};
