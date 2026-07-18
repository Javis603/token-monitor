'use strict';

const { KNOWN_CLIENTS } = require('./clientTracking');

const MAC_WIDGET_SCHEMA_VERSION = 5;
const KNOWN_TOOLS = new Set(KNOWN_CLIENTS.split(',').filter(Boolean));
const KNOWN_LIMIT_PROVIDERS = new Set([
  'claude', 'codex', 'cursor', 'antigravity', 'opencode', 'deepseek', 'minimax',
  'mimo', 'grok', 'copilot', 'kiro', 'zai', 'volcengine', 'qoder', 'zaiteam',
  'kimi', 'ollama'
]);
const KNOWN_LIMIT_STATUSES = new Set([
  'ok', 'disabled', 'notConfigured', 'unauthorized', 'rateLimited',
  'sourceRateLimited', 'unavailable', 'error'
]);
const KNOWN_WINDOW_KINDS = new Set(['session', 'weekly', 'billing']);
const PERIODS = new Set(['today', 'month', 'allTime']);
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

function normalizedStatus(value) {
  const status = String(value || '').trim();
  return KNOWN_LIMIT_STATUSES.has(status) ? status : 'error';
}

function safeDisplayName(value, fallback = '') {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name || name.includes('\0') || /^[A-Za-z]:[\\/]/.test(name) || name.startsWith('/') || name.includes('@')) return fallback;
  return name;
}

function normalizedPeriod(value) {
  const period = String(value || '').trim();
  return PERIODS.has(period) ? period : 'today';
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
  return {
    kind,
    usedPercent,
    remainingPercent,
    resetsAt: normalizedIso(window.resetsAt),
    windowMinutes: window.windowMinutes === null || window.windowMinutes === undefined
      ? null
      : nonNegativeNumber(window.windowMinutes)
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
  const output = [];
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') continue;
    const providerId = String(provider.provider || '').trim().toLowerCase();
    if (!KNOWN_LIMIT_PROVIDERS.has(providerId)) continue;
    const windows = Array.isArray(provider.windows)
      ? provider.windows.map(buildLimitWindow).filter(Boolean).slice(0, 2)
      : [];
    const balance = buildProviderBalance(provider);
    output.push({
      provider: providerId,
      status: normalizedStatus(provider.status),
      updatedAt: normalizedIso(provider.updatedAt),
      ...(balance ? { balance } : {}),
      windows
    });
  }
  return output.sort((left, right) => {
    const leftReady = left.status === 'ok' && (left.balance || left.windows.length) ? 0 : 1;
    const rightReady = right.status === 'ok' && (right.balance || right.windows.length) ? 0 : 1;
    return leftReady - rightReady || left.provider.localeCompare(right.provider);
  }).slice(0, 10);
}

function buildModels(period) {
  const values = period?.models && typeof period.models === 'object' ? period.models : {};
  const costs = period?.modelCosts && typeof period.modelCosts === 'object' ? period.modelCosts : {};
  const rows = [];
  for (const [rawName, rawTokens] of Object.entries(values)) {
    const displayName = safeDisplayName(rawName);
    const totalTokens = Math.round(nonNegativeNumber(rawTokens));
    if (!displayName || totalTokens <= 0) continue;
    rows.push({ displayName, totalTokens, costUsd: nonNegativeNumber(costs[rawName]) });
  }
  rows.sort((left, right) => right.totalTokens - left.totalTokens || left.displayName.localeCompare(right.displayName));
  const denominator = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  return rows.slice(0, 10).map((row) => ({
    ...row,
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

function buildActivity(history, period) {
  const daily = normalizedDaily(history).slice(-182);
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

function buildTrend(history) {
  const points = normalizedDaily(history).slice(-28);
  const peakTokens = points.reduce((max, point) => Math.max(max, point.totalTokens), 0);
  return {
    startDate: points[0]?.date || null,
    endDate: points.at(-1)?.date || null,
    peakTokens,
    currentTokens: points.at(-1)?.totalTokens || 0,
    points
  };
}

function buildPeriodSnapshot(stats, period, generatedAt) {
  const current = periodStats(stats, period);
  const tools = buildTools(current);
  const models = buildModels(current);
  const activity = buildActivity(stats?.historyPreview, period);
  const trend = buildTrend(stats?.historyPreview);
  const overview = {
    currentPeriod: period,
    totalTokens: Math.round(nonNegativeNumber(current.totalTokens)),
    costUsd: nonNegativeNumber(current.costUsd),
    primaryTool: tools[0]?.id || null,
    updatedAt: normalizedIso(stats?.updatedAt) || generatedAt
  };
  return { overview, models, activity, trend };
}

function buildPresentation(source = {}, period = 'today') {
  const currencyCode = String(source.currencyCode || source.currency || 'USD').trim().toUpperCase();
  const safeCurrency = Object.hasOwn(CURRENCIES, currencyCode) ? currencyCode : 'USD';
  const locale = String(source.locale || 'auto').trim();
  return {
    defaultPeriod: normalizedPeriod(source.defaultPeriod || period),
    currencyCode: safeCurrency,
    currencySymbol: CURRENCIES[safeCurrency],
    currencyRate: Math.max(0.000001, finiteNumber(source.currencyRate, 1)),
    numberStyle: source.compactNumbers === false ? 'full' : 'compact',
    showCost: source.showCost !== false,
    locale: /^(?:auto|en|zh-CN|zh-TW|ko|ja)$/.test(locale) ? locale : 'auto',
    theme: source.theme === 'custom' ? 'custom' : 'system'
  };
}

function buildStatus({ generatedAt, stats, quota, periods, now }) {
  const sourceUpdatedAt = normalizedIso(stats?.updatedAt || stats?.generatedAt);
  const sourceTime = sourceUpdatedAt ? Date.parse(sourceUpdatedAt) : now.getTime();
  const dataAgeSeconds = Math.max(0, Math.round((now.getTime() - sourceTime) / 1000));
  const statuses = quota.map((provider) => provider.status);
  return {
    isStale: Boolean(stats?.stale) || dataAgeSeconds > 20 * 60,
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
  const presentation = buildPresentation(options.presentation, options.presentation?.defaultPeriod);
  const quota = buildQuota(stats?.limits);
  const periods = {
    day: buildPeriodSnapshot(stats, 'today', generatedAt),
    month: buildPeriodSnapshot(stats, 'month', generatedAt),
    total: buildPeriodSnapshot(stats, 'allTime', generatedAt)
  };
  const defaultPeriod = normalizedPeriod(presentation.defaultPeriod);
  const defaultKey = defaultPeriod === 'month' ? 'month' : defaultPeriod === 'allTime' ? 'total' : 'day';
  const selected = periods[defaultKey];
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
    status: buildStatus({ generatedAt, stats, quota, periods, now: safeNow })
  };
}

function serializeMacWidgetSnapshot(stats, options = {}) {
  return `${JSON.stringify(buildMacWidgetSnapshot(stats, options))}\n`;
}

module.exports = {
  MAC_WIDGET_SCHEMA_VERSION,
  buildMacWidgetSnapshot,
  safeDisplayName,
  serializeMacWidgetSnapshot
};
