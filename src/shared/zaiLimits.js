'use strict';

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { runWithProbeDeadline } = require('./probeDeadline');

const ZAI_FETCH_TIMEOUT_MS = 12_000;

const ZAI_REGIONS = {
  global: {
    baseUrl: 'https://api.z.ai',
    dashboardUrl: 'https://z.ai/manage-apikey/coding-plan/personal/my-plan'
  },
  'bigmodel-cn': {
    baseUrl: 'https://open.bigmodel.cn',
    dashboardUrl: 'https://bigmodel.cn/coding-plan/personal/usage'
  }
};
const ZAI_QUOTA_PATH = '/api/monitor/usage/quota/limit';
const ZAI_SUBSCRIPTION_PATH = '/api/biz/subscription/list';
const ZAI_QUOTA_URL = `${ZAI_REGIONS.global.baseUrl}${ZAI_QUOTA_PATH}`;
const ZAI_SUBSCRIPTION_URL = `${ZAI_REGIONS.global.baseUrl}${ZAI_SUBSCRIPTION_PATH}`;
const ZAI_KEY_NAMES = ['ZAI_API_KEY', 'Z_AI_API_KEY', 'GLM_API_KEY', 'ZHIPU_API_KEY'];

function cleanSecret(value) {
  let raw = value;
  if (typeof raw !== 'string') return '';
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampPercent(value) {
  const parsed = numberOrNull(value);
  if (parsed === null) return null;
  return Math.max(0, Math.min(100, parsed));
}

function zaiWindowMinutes(unit, number) {
  if (!Number.isFinite(unit) || !Number.isFinite(number) || number <= 0) return null;
  if (unit === 5) return number;
  if (unit === 3) return number * 60;
  if (unit === 1) return number * 24 * 60;
  if (unit === 6) return number * 7 * 24 * 60;
  return null;
}

function zaiUsedPercent(limit) {
  const total = numberOrNull(limit?.usage);
  const remaining = numberOrNull(limit?.remaining);
  const currentValue = numberOrNull(limit?.currentValue ?? limit?.current_value);
  if (total !== null && total > 0) {
    let usedRaw = null;
    if (remaining !== null) {
      const usedFromRemaining = total - remaining;
      usedRaw = currentValue === null ? usedFromRemaining : Math.max(usedFromRemaining, currentValue);
    } else if (currentValue !== null) {
      usedRaw = currentValue;
    }
    if (usedRaw !== null) {
      const used = Math.max(0, Math.min(total, usedRaw));
      return Math.max(0, Math.min(100, (used / total) * 100));
    }
  }
  return clampPercent(limit?.percentage ?? limit?.usedPercent ?? limit?.used_percent);
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 20_000_000_000 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function displayPlanText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bglm\b/gi, 'GLM')
    .replace(/\bz\.?ai\b/gi, 'Z.ai')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bZ\.Ai\b/g, 'Z.ai');
}

function zaiToken(env = process.env, explicitKey = '') {
  const explicit = cleanSecret(explicitKey);
  if (explicit) return explicit;
  for (const name of ZAI_KEY_NAMES) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

function zaiRegion(options = {}, env = process.env) {
  const raw = String(
    options.zaiApiRegion
    || env.TOKEN_MONITOR_ZAI_API_REGION
    || env.ZAI_API_REGION
    || env.Z_AI_API_REGION
    || env.Z_AI_API_HOST
    || env.ZAI_API_HOST
    || ''
  ).trim().toLowerCase();
  if (raw === 'bigmodel-cn' || raw === 'bigmodel' || raw === 'cn' || raw === 'china' || raw.includes('open.bigmodel.cn') || raw.includes('bigmodel.cn')) {
    return 'bigmodel-cn';
  }
  return 'global';
}

function zaiBaseUrl(region = 'global') {
  return ZAI_REGIONS[zaiRegion({ zaiApiRegion: region })].baseUrl;
}

function zaiQuotaUrl(region = 'global') {
  return `${zaiBaseUrl(region)}${ZAI_QUOTA_PATH}`;
}

function zaiSubscriptionUrl(region = 'global') {
  return `${zaiBaseUrl(region)}${ZAI_SUBSCRIPTION_PATH}`;
}

function zaiDashboardUrl(region = 'global') {
  return ZAI_REGIONS[zaiRegion({ zaiApiRegion: region })].dashboardUrl;
}

function firstSubscription(subscriptions) {
  const rows = Array.isArray(subscriptions?.data) ? subscriptions.data : [];
  return rows.find((row) => row && typeof row === 'object') || null;
}

function firstTextField(source, fields, { display = false } = {}) {
  if (!source || typeof source !== 'object') return '';
  for (const field of fields) {
    const value = String(source[field] || '').trim();
    if (value) return display ? displayPlanText(value) : value;
  }
  return '';
}

function planFromResponses(quotaBody, subscriptionBody) {
  const sub = firstSubscription(subscriptionBody);
  const subscriptionPlan = firstTextField(sub, [
    'product_name',
    'productName',
    'plan_name',
    'planName',
    'package_name',
    'packageName',
    'plan',
    'plan_type',
    'planType',
    'level'
  ], { display: true });
  if (subscriptionPlan) return subscriptionPlan;
  const quotaData = quotaBody?.data;
  return firstTextField(quotaData, [
    'planName',
    'plan_name',
    'packageName',
    'package_name',
    'plan',
    'plan_type',
    'planType',
    'level'
  ], { display: true });
}

function subscriptionResetAt(subscriptionBody) {
  const sub = firstSubscription(subscriptionBody);
  return toIso(sub?.next_renew_time ?? sub?.nextRenewTime);
}

function zaiWindow(limit, { kind, label, fallbackResetAt = null, includeWindowMinutes = true, resetDescription = null }) {
  const usedPercent = zaiUsedPercent(limit);
  if (usedPercent === null) return null;
  const windowMinutes = zaiWindowMinutes(numberOrNull(limit.unit), numberOrNull(limit.number));
  const resetsAt = toIso(limit.nextResetTime ?? limit.next_reset_time) || fallbackResetAt;
  const window = {
    kind,
    label,
    usedPercent,
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    showMeter: true
  };
  if (includeWindowMinutes && windowMinutes !== null) window.windowMinutes = windowMinutes;
  if (resetsAt) window.resetsAt = resetsAt;
  if (resetDescription) window.resetDescription = resetDescription;
  return window;
}

function isZaiSessionTokenLimit(limit) {
  const minutes = zaiWindowMinutes(numberOrNull(limit?.unit), numberOrNull(limit?.number));
  return minutes !== null && minutes <= 6 * 60;
}

function parseZaiUsage(quotaBody, subscriptionBody = null) {
  const plan = planFromResponses(quotaBody, subscriptionBody);
  const resetAt = subscriptionResetAt(subscriptionBody);
  const limits = Array.isArray(quotaBody?.data?.limits) ? quotaBody.data.limits : [];
  const windows = [];
  const tokenLimits = [];
  let timeLimit = null;

  for (const limit of limits) {
    if (!limit || typeof limit !== 'object') continue;
    const type = String(limit.type || limit.limit_type || '').trim().toUpperCase();
    if (type === 'TOKENS_LIMIT' && zaiUsedPercent(limit) !== null) {
      tokenLimits.push(limit);
    } else if (type === 'TIME_LIMIT' && zaiUsedPercent(limit) !== null) {
      timeLimit = limit;
    }
  }

  tokenLimits.sort((a, b) => {
    const aMinutes = zaiWindowMinutes(numberOrNull(a.unit), numberOrNull(a.number)) ?? Number.MAX_SAFE_INTEGER;
    const bMinutes = zaiWindowMinutes(numberOrNull(b.unit), numberOrNull(b.number)) ?? Number.MAX_SAFE_INTEGER;
    return aMinutes - bMinutes;
  });
  const onlyTokenLimit = tokenLimits[0] || null;
  const sessionTokenLimit = tokenLimits.length >= 2
    ? tokenLimits[0]
    : isZaiSessionTokenLimit(onlyTokenLimit) ? onlyTokenLimit : null;
  const tokenLimit = tokenLimits.length >= 2
    ? tokenLimits[tokenLimits.length - 1]
    : sessionTokenLimit ? null : onlyTokenLimit;

  const fiveHour = sessionTokenLimit && zaiWindow(sessionTokenLimit, { kind: 'session', label: '5-hour' });
  if (fiveHour) windows.push(fiveHour);

  const weekly = tokenLimit && zaiWindow(tokenLimit, { kind: 'weekly', label: 'Weekly' });
  if (weekly) windows.push(weekly);

  // The MCP TIME_LIMIT is a monthly bucket, but z.ai encodes its window as a
  // misleading unit=5/number=1 (1-minute) marker. Drop windowMinutes and carry
  // a 'Monthly' cadence so the reset stays right when the renew time is absent.
  const mcp = timeLimit && zaiWindow(timeLimit, {
    kind: 'billing',
    label: 'MCP',
    fallbackResetAt: resetAt,
    includeWindowMinutes: false,
    resetDescription: 'Monthly'
  });
  if (mcp) {
    const remaining = numberOrNull(timeLimit.remaining);
    if (remaining !== null) mcp.remaining = remaining;
    windows.push(mcp);
  }

  return { plan, windows };
}

async function fetchJson(url, key, deps = {}) {
  const deadlineMs = Number(deps.zaiFetchTimeoutMs || deps.fetchTimeoutMs || ZAI_FETCH_TIMEOUT_MS);
  return runWithProbeDeadline(async ({ signal }) => {
    const response = await (deps.fetch || fetch)(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      },
      signal
    });
    if (!response.ok) {
      const error = new Error(`${url} returned ${response.status}`);
      error.status = response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw error;
    }
    return response.json();
  }, { signal: deps.signal, deadlineMs });
}

async function fetchZaiLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const key = zaiToken(env, options.zaiApiKey);
  const region = zaiRegion(options, env);
  if (!key) {
    return normalizeLimitProvider({
      provider: 'zai',
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: [],
      region
    });
  }

  try {
    const quota = await fetchJson(zaiQuotaUrl(region), key, deps);
    let subscription = null;
    try {
      subscription = await fetchJson(zaiSubscriptionUrl(region), key, deps);
    } catch (_) {}
    const usage = parseZaiUsage(quota, subscription);
    return normalizeLimitProvider({
      provider: 'zai',
      accountKey: hashKey('zai', key),
      accountLabel: usage.plan,
      source: 'api',
      status: usage.windows.length ? 'ok' : 'unavailable',
      updatedAt,
      windows: usage.windows,
      region
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'zai',
      source: 'api',
      status: error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable',
      updatedAt,
      windows: [],
      region
    });
  }
}

module.exports = {
  ZAI_FETCH_TIMEOUT_MS,
  ZAI_QUOTA_URL,
  ZAI_SUBSCRIPTION_URL,
  zaiToken,
  zaiRegion,
  zaiQuotaUrl,
  zaiSubscriptionUrl,
  zaiDashboardUrl,
  parseZaiUsage,
  fetchZaiLimits
};
