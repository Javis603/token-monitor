'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { runWithProbeDeadline } = require('./probeDeadline');
const { discoverZcodeConnection } = require('./zcodeDiscovery');

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
    // GLM coding-plan windows can arrive as CREDIT_LIMIT in addition to the
    // legacy TOKENS_LIMIT; both share the same fields and unit/number window
    // encodings, so CREDIT_LIMIT is treated as a token-window type. MCP stays
    // on the TIME_LIMIT path below.
    if (type === 'TOKENS_LIMIT' && zaiUsedPercent(limit) !== null) {
      tokenLimits.push(limit);
    } else if (type === 'CREDIT_LIMIT' && zaiUsedPercent(limit) !== null) {
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

// Three independent account pools feed one GLM row, in parallel: the paid
// subscription quota (console key), the cash balance (console key), and the
// ZCode Start/Weekend plan buckets (local ZCode login). A pool only renders
// when it actually has something — an empty pool is absent, not zero. The
// console key also answers quota for users without ZCode; the ZCode login
// also answers plan buckets for users without a console key.
async function fetchZaiLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const key = zaiToken(env, options.zaiApiKey);
  const region = zaiRegion(options, env);

  const keyLane = key
    ? (async () => {
      const [quotaResult, balanceResult] = await Promise.allSettled([
        fetchJson(zaiQuotaUrl(region), key, deps),
        fetchJson(zaiBalanceUrl(region), key, deps)
      ]);
      let subscription = null;
      try {
        subscription = await fetchJson(zaiSubscriptionUrl(region), key, deps);
      } catch (_) {}
      if (quotaResult.status === 'rejected') throw quotaResult.reason;
      const usage = parseZaiUsage(quotaResult.value, subscription);
      const balanceWindow = balanceResult.status === 'fulfilled'
        ? zaiBalanceWindow(balanceResult.value, region)
        : null;
      return {
        windows: balanceWindow ? [...usage.windows, balanceWindow] : usage.windows,
        plan: usage.plan,
        accountKey: hashKey('zai', key),
        balance: balanceWindow
          ? { amount: balanceWindow.remaining, currency: balanceWindow.currency }
          : null,
        hasAnything: usage.windows.length > 0 || Boolean(balanceWindow),
        quotaFailed: false
      };
    })()
    : Promise.resolve({ windows: [], plan: '', accountKey: '', hasAnything: false, quotaFailed: false });

  const planLane = (async () => {
    const discovery = discoverZcodeConnection(options, {
      readFileSync: deps.readFileSync || fs.readFileSync,
      homeDir: deps.homeDir || options.homeDir || os.homedir()
    });
    if (discovery.kind !== 'start-billing' || !discovery.entitled || !discovery.credential) {
      return { windows: [], plan: '', accountKey: '', hasAnything: false };
    }
    const payload = await runWithProbeDeadline(async ({ signal }) => {
      const deviceMid = zcodeDeviceMid(deps);
      const response = await (deps.fetch || fetch)(zcodeStartPlanBalanceUrl(), {
        headers: {
          Authorization: `Bearer ${discovery.credential.token}`,
          Accept: 'application/json',
          ...(deviceMid ? { 'X-Device-Mid': deviceMid } : {})
        },
        signal
      });
      if (!response.ok) {
        const error = new Error(`zcode billing returned ${response.status}`);
        error.status = response.status === 401 || response.status === 403
          ? 'unauthorized'
          : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
        throw error;
      }
      return response.json();
    }, { signal: deps.signal, deadlineMs: Number(deps.zaiFetchTimeoutMs || deps.fetchTimeoutMs || ZAI_FETCH_TIMEOUT_MS) });
    const usage = parseZcodeStartPlanBalances(payload);
    return {
      windows: usage.windows,
      plan: usage.plan,
      accountKey: hashKey('zai', discovery.credential.token),
      hasAnything: usage.windows.length > 0
    };
  })();

  const [keyResult, planResult] = await Promise.allSettled([keyLane, planLane]);

  if (keyResult.status === 'rejected' && planResult.status === 'rejected') {
    const error = keyResult.reason;
    if (error?.status === 'unauthorized') return zcodeStatusProvider('notConfigured', options, deps);
    return zcodeStatusProvider(error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable', options, deps);
  }

  const lanes = [keyResult, planResult].filter((result) => result.status === 'fulfilled');
  const windows = lanes.flatMap((result) => result.value.windows);
  // The console key's quota is the authoritative failure signal: when it was
  // asked for and rejected, the whole row is that failure even if the plan
  // lane still has buckets to show.
  if (key && keyResult.status === 'rejected') {
    const error = keyResult.reason;
    return zcodeStatusProvider(error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable', options, deps);
  }
  const accountKey = lanes.map((result) => result.value.accountKey).filter(Boolean)[0] || '';
  const accountLabel = lanes.map((result) => result.value.plan).filter(Boolean)[0] || '';
  const hasAnything = lanes.some((result) => result.value.hasAnything);
  const balance = lanes.map((result) => result.value.balance).filter(Boolean)[0] || null;
  return normalizeLimitProvider({
    provider: 'zai',
    ...(accountKey ? { accountKey } : {}),
    ...(accountLabel ? { accountLabel } : {}),
    ...(balance ? { balance } : {}),
    source: 'api',
    status: hasAnything ? 'ok' : key ? 'unavailable' : 'notConfigured',
    updatedAt,
    windows,
    region
  });
}

// Cash balance for a console API key, from the same endpoint BigModel's own
// finance page renders. Amounts come back as high-precision decimals
// ("0E-9"); the console rounds them to 2 places before display. Currency is
// not in the response — it follows the region: USD on z.ai, CNY on BigModel.
function zaiBalanceUrl(region) {
  return `${zaiBaseUrl(region)}/api/biz/account/query-customer-account-report`;
}

function zaiBalanceCurrency(region) {
  return zaiRegion({ zaiApiRegion: region }) === 'bigmodel-cn' ? 'CNY' : 'USD';
}

function zaiBalanceWindow(payload, region) {
  const data = payload?.data;
  const remaining = numberOrNull(data?.availableBalance);
  if (remaining === null) return null;
  return {
    kind: 'billing',
    metric: 'credits',
    label: 'Balance',
    remaining: Math.max(0, remaining),
    currency: zaiBalanceCurrency(region)
  };
}

// ZCode Start/Weekend plan quota lives on ZCode's own billing endpoint, not
// the shared subscription quota above. Single origin, no region split; the
// gateway rejects requests without the ZCode client's device id (code 3001
// "parameter error"), so the id rides along from ZCode's own telemetry state.

// The billing gateway rejects requests without the ZCode client's device id
// (code 3001 "parameter error"), so it reads ZCode's own telemetry state.
function zcodeDeviceMid(deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const homeDir = deps.homeDir || os.homedir();
  try {
    const state = JSON.parse(readFileSync(path.join(homeDir, '.zcode', 'v2', 'telemetry-state.json'), 'utf8'));
    const deviceMid = String(state?.deviceMid || '').trim();
    return deviceMid || null;
  } catch (_) {
    return null;
  }
}

function zcodeStartPlanBalanceUrl() {
  return 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';
}

// Mirrors ZCode's normalizeZaiStartPlanBalanceLimits: one window per balance
// bucket. The grant period lives on the plan entitlement, not the bucket, so
// callers pass an entitlement_id → period map alongside the payload; daily
// grants map to the shared daily lane, one-time grants take the billing lane
// without windowMinutes.
function zcodeBalanceWindow(balance, periodByEntitlement = {}) {
  const total = numberOrNull(balance?.total_units);
  const used = numberOrNull(balance?.used_units);
  const remaining = numberOrNull(balance?.remaining_units);
  if (total === null && used === null && remaining === null) return null;
  const usedPercent = total !== null && total > 0 && remaining !== null
    ? clampPercent(100 - (remaining / total) * 100)
    : clampPercent(balance?.percentage);
  const label = String(balance?.show_name || '').trim() || 'Start Plan';
  const resetsAt = toIso(balance?.expires_at ?? balance?.period_end);
  const period = periodByEntitlement[String(balance?.entitlement_id || '').trim()]
    || String(balance?.period || '');
  const window = {
    kind: period === 'daily' ? 'daily' : 'billing',
    label,
    limitId: String(balance?.plan_id || '').trim(),
    ...(usedPercent !== null ? { usedPercent, remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)) } : {}),
    showMeter: usedPercent !== null,
    ...(period === 'daily' ? { windowMinutes: 24 * 60 } : {})
  };
  if (used !== null) window.used = used;
  if (remaining !== null) window.remaining = remaining;
  if (total !== null) window.limit = total;
  if (resetsAt) window.resetsAt = resetsAt;
  return window;
}

function zcodePeriodByEntitlement(payload) {
  const periodByEntitlement = {};
  const plans = Array.isArray(payload?.data?.plans) ? payload.data.plans : [];
  for (const plan of plans) {
    const entitlements = Array.isArray(plan?.entitlements) ? plan.entitlements : [];
    for (const entitlement of entitlements) {
      const id = String(entitlement?.entitlement_id || '').trim();
      const period = String(entitlement?.period || '').trim();
      if (id && period) periodByEntitlement[id] = period;
    }
  }
  return periodByEntitlement;
}

function parseZcodeStartPlanBalances(payload) {
  const periodByEntitlement = zcodePeriodByEntitlement(payload);
  const balances = Array.isArray(payload?.data?.balances) ? payload.data.balances : [];
  const windows = balances.map((balance) => zcodeBalanceWindow(balance, periodByEntitlement)).filter(Boolean);
  const plan = Array.isArray(payload?.data?.plans)
    ? payload.data.plans.find((entry) => entry?.status === 'active')
    : null;
  return { plan: String(plan?.name || '').trim(), windows };
}

function zcodeStatusProvider(status, options = {}, deps = {}) {
  const now = (deps.now || Date.now)();
  return normalizeLimitProvider({
    provider: 'zai',
    source: 'api',
    status,
    updatedAt: new Date(now).toISOString(),
    windows: [],
    region: zaiRegion(options, deps.env || process.env)
  });
}

// Start/Weekend plans authorize with ZCode's own login token rather than the
// console API key, so this lane runs only when the console key is absent and
// discovery found an entitled local ZCode login. 401/403 fall back to the
// not-configured state: the token is ZCode-managed and will be rotated there.
async function fetchZcodeStartPlanLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const discovery = discoverZcodeConnection(options, {
    readFileSync: deps.readFileSync || fs.readFileSync,
    homeDir: deps.homeDir || options.homeDir || os.homedir()
  });
  if (discovery.kind !== 'start-billing' || !discovery.entitled || !discovery.credential) {
    return zcodeStatusProvider('notConfigured', options, deps);
  }

  try {
    const payload = await runWithProbeDeadline(async ({ signal }) => {
      const deviceMid = zcodeDeviceMid(deps);
      const response = await (deps.fetch || fetch)(zcodeStartPlanBalanceUrl(), {
        headers: {
          Authorization: `Bearer ${discovery.credential.token}`,
          Accept: 'application/json',
          ...(deviceMid ? { 'X-Device-Mid': deviceMid } : {})
        },
        signal
      });
      if (!response.ok) {
        const error = new Error(`zcode billing returned ${response.status}`);
        error.status = response.status === 401 || response.status === 403
          ? 'unauthorized'
          : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
        throw error;
      }
      return response.json();
    }, { signal: deps.signal, deadlineMs: Number(deps.zaiFetchTimeoutMs || deps.fetchTimeoutMs || ZAI_FETCH_TIMEOUT_MS) });
    const usage = parseZcodeStartPlanBalances(payload);
    return normalizeLimitProvider({
      provider: 'zai',
      accountKey: hashKey('zai', discovery.credential.token),
      accountLabel: usage.plan,
      source: 'api',
      status: usage.windows.length ? 'ok' : 'unavailable',
      updatedAt: new Date(now).toISOString(),
      windows: usage.windows,
      region: zaiRegion(options, env)
    });
  } catch (error) {
    if (error?.status === 'unauthorized') return zcodeStatusProvider('notConfigured', options, deps);
    return zcodeStatusProvider(error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable', options, deps);
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
  parseZcodeStartPlanBalances,
  fetchZcodeStartPlanLimits,
  fetchZaiLimits
};
