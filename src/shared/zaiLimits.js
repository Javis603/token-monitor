'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { runWithProbeDeadline } = require('./probeDeadline');
const { readJson, writeJsonAtomic, sharedDataDir } = require('./config');
const { discoverZcodeConnection, zcodeDataBaseDir } = require('./zcodeDiscovery');

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
        ? zaiCashBalanceWindow(balanceResult.value, region)
        : null;
      // The finance report exposes a cumulative spend total; the today/week/
      // month deltas come from tracking that total locally. A report without
      // the total yields no spend fields — the balance row alone remains.
      let balance = null;
      if (balanceWindow) {
        const balanceData = balanceResult.status === 'fulfilled' ? balanceResult.value?.data : null;
        balance = {
          amount: balanceWindow.remaining,
          currency: balanceWindow.currency,
          ...zcodeRecordCumulativeSpend({
            accountKey: hashKey('zai', key),
            totalSpent: numberOrNull(balanceData?.totalSpendAmount),
            now,
            storePath: deps.zaiBalanceStorePath || path.join(sharedDataDir({ env }), 'zai-balance.json'),
            readJson: deps.readJson,
            writeJsonAtomic: deps.writeJsonAtomic
          })
        };
      }
      // Window-level source only exists for non-console origins ('local' is
      // the sole whitelisted value) — key-lane windows carry no source.
      const keyWindows = balanceWindow ? [...usage.windows, balanceWindow] : usage.windows;
      return {
        windows: keyWindows,
        plan: usage.plan,
        accountKey: hashKey('zai', key),
        balance,
        hasAnything: usage.windows.length > 0 || Boolean(balanceWindow)
      };
    })()
    : Promise.resolve({ windows: [], plan: '', accountKey: '', hasAnything: false });

  const planLane = (async () => {
    const discovery = discoverZcodeConnection(options, {
      readFileSync: deps.readFileSync || fs.readFileSync,
      homeDir: deps.homeDir || options.homeDir || os.homedir()
    });
    // Coding Plan quota rides the same quota endpoint the console key uses,
    // keyed by the mirror key ZCode stores on the provider entry. The lane is
    // best-effort (failures keep it empty) but marks itself attempted: a
    // detected ZCode login must not read as not-configured while its query
    // fails or reports no subscription under that key.
    if (discovery.kind === 'coding-quota' && discovery.entitled) {
      const mirrorKey = discovery.credential?.token;
      if (mirrorKey) {
        try {
          const quotaHost = discovery.family === 'bigmodel' ? 'https://open.bigmodel.cn' : 'https://api.z.ai';
          const quota = await fetchJson(`${quotaHost}/api/monitor/usage/quota/limit`, mirrorKey, deps);
          const usage = parseZaiUsage(quota, null);
          return {
            windows: usage.windows.map((window) => ({ ...window, source: 'local' })),
            plan: usage.plan,
            accountKey: hashKey('zai', mirrorKey),
            hasAnything: usage.windows.length > 0,
            attempted: true
          };
        } catch (_) {}
      }
      return { windows: [], plan: '', accountKey: '', hasAnything: false, attempted: true };
    }
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
    // Empty balances with an active plan are a legal mid-state (a grant not
    // yet effective), so a fulfilled-but-empty lane still counts as attempted.
    return {
      windows: usage.windows.map((window) => ({ ...window, source: 'local' })),
      plan: usage.plan,
      accountKey: hashKey('zai', discovery.credential.token),
      hasAnything: usage.windows.length > 0,
      attempted: true
    };
  })();

  const [keyResult, planResult] = await Promise.allSettled([keyLane, planLane]);

  if (keyResult.status === 'rejected' && planResult.status === 'rejected') {
    const error = keyResult.reason;
    if (error?.status === 'unauthorized') return zaiStatusProvider('notConfigured', options, deps);
    return zaiStatusProvider(error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable', options, deps);
  }

  const lanes = [keyResult, planResult].filter((result) => result.status === 'fulfilled');
  const windows = lanes.flatMap((result) => result.value.windows);
  const accountKey = lanes.map((result) => result.value.accountKey).filter(Boolean)[0] || '';
  const accountLabel = lanes.map((result) => result.value.plan).filter(Boolean)[0] || '';
  // The console key's quota is the authoritative failure signal for its own
  // lane, but plan buckets that did load still render — an unavailable key
  // does not erase a live Weekend bucket.
  if (key && keyResult.status === 'rejected') {
    const error = keyResult.reason;
    return normalizeLimitProvider({
      provider: 'zai',
      ...(accountKey ? { accountKey } : {}),
      ...(accountLabel ? { accountLabel } : {}),
      source: 'api',
      status: error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable',
      updatedAt,
      windows,
      region
    });
  }
  const hasAnything = lanes.some((result) => result.value.hasAnything);
  const balance = lanes.map((result) => result.value.balance).filter(Boolean)[0] || null;
  // The plan buckets come from the local ZCode login, not the console key, so
  // a ZCode-only row reports oauth while a keyed row reports api. A lane that
  // ran but produced nothing — an entitled plan whose grants are not yet
  // effective, or a mirror key with no subscription under it — reports
  // unavailable rather than notConfigured: the login is detected, so "not
  // configured" would contradict the settings pill. Billing 401/403 also maps
  // to unavailable, mirroring ZCode's own classifyAvailabilityError: the
  // mirror token is ZCode-managed and rotates there, not here.
  const planError = !key && planResult.status === 'rejected' ? planResult.reason : null;
  const planAttempted = !key && planResult.status === 'fulfilled' && Boolean(planResult.value.attempted);
  const source = key ? 'api' : (hasAnything || planError || planAttempted ? 'oauth' : '');
  return normalizeLimitProvider({
    provider: 'zai',
    ...(accountKey ? { accountKey } : {}),
    ...(accountLabel ? { accountLabel } : {}),
    ...(balance ? { balance } : {}),
    source,
    status: hasAnything ? 'ok'
      : key || planAttempted ? 'unavailable'
        : planError
          ? (planError?.status === 'sourceRateLimited' ? 'sourceRateLimited' : 'unavailable')
          : 'notConfigured',
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

function zaiCashBalanceWindow(payload, region) {
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

const ZAI_SPEND_STORE_VERSION = 1;
// Same retention window as DeepSeek's balance history: today/week/month
// aggregates never need anything older, and the store stops growing.
const ZAI_SPEND_RETENTION_MS = 40 * 24 * 60 * 60 * 1000;

function zaiLocalDayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// The report's spend total only ever grows in normal use, so consumption is
// the positive delta between observations. A drop (refund, plan reset) moves
// the baseline without recording negative spend.
function zcodeRecordCumulativeSpend({ accountKey, totalSpent, now, storePath, readJson: readOverride, writeJsonAtomic: writeOverride }) {
  // totalSpent is null when the report omits the cumulative total; Number(null)
  // is 0, so the null check must come before the finite check or a missing
  // field would silently rebase the tracked total to zero.
  if (!accountKey || totalSpent === null || !Number.isFinite(totalSpent) || !storePath) return null;
  const read = readOverride || readJson;
  const write = writeOverride || writeJsonAtomic;
  const nowMs = Number(now);
  const total = Math.max(0, totalSpent);
  let store;
  try {
    // config.readJson returns null on ENOENT instead of throwing, so a null
    // check — not just the try/catch — is what makes a fresh store.
    store = read(storePath, 'utf8');
  } catch (_) {}
  if (!store || typeof store !== 'object') {
    store = { version: ZAI_SPEND_STORE_VERSION, accounts: {} };
  }
  const entry = store.accounts[accountKey] || { lastTotal: null, allTimeSpend: 0, dailySpend: {}, trackingSince: nowMs };
  let changed = false;
  if (entry.lastTotal === null) {
    entry.lastTotal = total;
    changed = true;
  } else if (entry.lastTotal !== total) {
    const consumed = Math.max(0, total - entry.lastTotal);
    const dayKey = zaiLocalDayKey(nowMs);
    entry.dailySpend[dayKey] = Math.round(((entry.dailySpend[dayKey] || 0) + consumed) * 100) / 100;
    entry.allTimeSpend = Math.round((Number(entry.allTimeSpend || 0) + consumed) * 100) / 100;
    entry.lastTotal = total;
    changed = true;
  }
  // Prune day buckets past the retention window; allTimeSpend keeps
  // accumulating after the buckets are gone, as on DeepSeek.
  const cutoff = nowMs - ZAI_SPEND_RETENTION_MS;
  const pruned = {};
  for (const [key, amount] of Object.entries(entry.dailySpend || {})) {
    if (key >= zaiLocalDayKey(cutoff)) pruned[key] = amount;
  }
  if (Object.keys(pruned).length !== Object.keys(entry.dailySpend || {}).length) {
    entry.dailySpend = pruned;
    changed = true;
  }
  store.accounts[accountKey] = entry;
  if (changed) write(storePath, store);

  const todayKey = zaiLocalDayKey(nowMs);
  const monthKey = todayKey.slice(0, 7);
  const todayDate = new Date(nowMs);
  const monday = new Date(todayDate);
  monday.setDate(todayDate.getDate() - ((todayDate.getDay() + 6) % 7));
  const weekKey = zaiLocalDayKey(monday.getTime());
  const sumSince = (predicate) => Object.entries(entry.dailySpend)
    .filter(([key]) => predicate(key))
    .reduce((sum, [, amount]) => sum + amount, 0);
  return {
    todaySpend: entry.dailySpend[todayKey] || 0,
    weekSpend: Math.round(sumSince((key) => key >= weekKey) * 100) / 100,
    monthSpend: Math.round(sumSince((key) => key.startsWith(monthKey)) * 100) / 100,
    allTimeSpend: entry.allTimeSpend,
    trackingSince: entry.trackingSince,
    monthSinceTracking: monthKey === zaiLocalDayKey(entry.trackingSince)
  };
}

// ZCode Start/Weekend plan quota lives on ZCode's own billing endpoint, not
// the shared subscription quota above. Single origin, no region split; the
// gateway rejects requests without the ZCode client's device id (code 3001
// "parameter error"), so the id rides along from ZCode's own telemetry state.
function zcodeDeviceMid(deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const env = deps.env || process.env;
  const homeDir = deps.homeDir || os.homedir();
  try {
    const state = JSON.parse(readFileSync(
      path.join(zcodeDataBaseDir(env, homeDir), '.zcode', 'v2', 'telemetry-state.json'),
      'utf8'
    ));
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
function zcodePlanBucketWindow(balance, periodByEntitlement = {}) {
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
    // One-time grants never renew; the description keeps that visible on
    // surfaces that render resets as text.
    ...(period !== 'daily' ? { resetDescription: 'One-time' } : {}),
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
  const windows = balances.map((balance) => zcodePlanBucketWindow(balance, periodByEntitlement)).filter(Boolean);
  // Mirrors ZCode's pickCurrentZaiStartPlan: the first active plan whose
  // plan_id or name carries the start-plan identity — Weekend ids do
  // ("zcode-v3-start-plan-wk-…"), and a non-start plan must not steal the
  // label even if it sorts first.
  const startIdentity = (entry) => [entry?.plan_id, entry?.name]
    .some((value) => /start[- ]plan/.test(String(value || '').toLowerCase()));
  const plan = Array.isArray(payload?.data?.plans)
    ? payload.data.plans.find((entry) => entry?.status === 'active' && startIdentity(entry))
    : null;
  return { plan: String(plan?.name || '').trim(), windows };
}

function zaiStatusProvider(status, options = {}, deps = {}) {
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
  fetchZaiLimits
};
