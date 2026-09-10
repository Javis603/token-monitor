'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normalizeLimitProvider } = require('../../limits/core');
const {
  cleanSecret,
  numberOrNull,
  toIso
} = require('../../limits/providerHelpers');
const { hashKey } = require('../../hashKey');
const { runWithProbeDeadline } = require('../../probeDeadline');
const { readJson, writeJsonAtomic, sharedDataDir } = require('../../config');
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
// An empty lane: attempted marks a lane that ran and found nothing, so the
// row reports unavailable rather than contradicting the detected-login pill.
const emptyLane = (attempted = false) => ({ windows: [], plan: '', accountKey: '', hasAnything: false, attempted });

// Maps a lane error onto a provider status: timeouts degrade to unavailable,
// every other classified status (unauthorized, sourceRateLimited, …) passes
// through so the pill can say what actually happened.
const laneErrorStatus = (error) => (error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable');

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
      let usage = quotaResult.status === 'fulfilled'
        ? parseZaiUsage(quotaResult.value)
        : { plan: '', windows: [] };
      // Subscription only enriches usable quota; a revoked key or no-plan
      // response must not start another request (and another deadline).
      if (usage.windows.length) {
        try {
          const subscription = await fetchJson(zaiSubscriptionUrl(region), key, deps);
          usage = parseZaiUsage(quotaResult.value, subscription);
        } catch (_) {}
      }
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
      const keyWindows = balanceWindow ? [...usage.windows, balanceWindow] : usage.windows;
      return {
        windows: keyWindows,
        plan: usage.plan,
        accountKey: hashKey('zai', key),
        balance,
        error: quotaResult.status === 'rejected' ? quotaResult.reason : null,
        hasAnything: usage.windows.length > 0 || Boolean(balanceWindow)
      };
    })()
    : Promise.resolve(emptyLane());

  // The billing query shared by both discovery shapes: an account-level
  // endpoint answering with every plan's buckets regardless of which
  // provider is selected in ZCode.
  const fetchZcodeBilling = async (token) => {
    const payload = await runWithProbeDeadline(async ({ signal }) => {
      const deviceMid = zcodeDeviceMid({ ...deps, env, homeDir: deps.homeDir || options.homeDir });
      const response = await (deps.fetch || fetch)(zcodeStartPlanBalanceUrl(), {
        headers: {
          Authorization: `Bearer ${token}`,
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
    // yet effective), so a fulfilled-but-empty query still counts as attempted.
    return {
      windows: usage.windows,
      plan: usage.plan,
      accountKey: hashKey('zai', token),
      hasAnything: usage.windows.length > 0,
      attempted: true
    };
  };

  const planLane = (async () => {
    const discovery = discoverZcodeConnection(options, {
      readFileSync: deps.readFileSync || fs.readFileSync,
      env,
      homeDir: deps.homeDir || options.homeDir || os.homedir()
    });
    // Mirror-key quota on the console-key endpoint; classified errors (429,
    // auth) propagate, empty results keep the lane attempted, not unconfigured.
    if (discovery.kind === 'coding-quota' && discovery.entitled) {
      const mirrorKey = discovery.credential?.token;
      if (mirrorKey) {
        const mirrorRegion = discovery.family === 'bigmodel' ? 'bigmodel-cn' : 'global';
        // Billing is account-level, so it runs alongside quota; failures never
        // block the quota answer. Subscription only enriches usable quota.
        const [quotaResult, billingResult] = await Promise.allSettled([
          mirrorKey === key && mirrorRegion === region
            ? Promise.resolve(null)
            : fetchJson(zaiQuotaUrl(mirrorRegion), mirrorKey, deps),
          discovery.billing ? fetchZcodeBilling(discovery.billing.credential.token) : Promise.resolve(null),
        ]);
        let usage = { plan: '', windows: [] };
        if (quotaResult.status === 'fulfilled' && quotaResult.value !== null) {
          usage = parseZaiUsage(quotaResult.value);
          if (usage.windows.length) {
            try {
              const subscription = await fetchJson(zaiSubscriptionUrl(mirrorRegion), mirrorKey, deps);
              usage = parseZaiUsage(quotaResult.value, subscription);
            } catch (_) {}
          }
        }
        const billing = billingResult.status === 'fulfilled' ? billingResult.value : null;
        return {
          windows: [...usage.windows, ...(billing ? billing.windows : [])],
          plan: usage.plan || (billing ? billing.plan : ''),
          accountKey: mirrorKey === key && mirrorRegion === region ? '' : hashKey('zai', mirrorKey),
          hasAnything: usage.windows.length > 0 || Boolean(billing?.hasAnything),
          attempted: true,
          error: quotaResult.status === 'rejected' ? quotaResult.reason : null
        };
      }
      return emptyLane(true);
    }
    if (discovery.kind !== 'start-billing' || !discovery.entitled || !discovery.credential) {
      return emptyLane();
    }
    return fetchZcodeBilling(discovery.credential.token);
  })();

  const [keyResult, planResult] = await Promise.allSettled([keyLane, planLane]);

  const lanes = [keyResult, planResult].filter((result) => result.status === 'fulfilled');
  const windows = lanes.flatMap((result) => result.value.windows);
  const accountKey = lanes.map((result) => result.value.accountKey).filter(Boolean)[0] || '';
  const accountLabel = lanes.map((result) => result.value.plan).filter(Boolean)[0] || '';
  // Errors affect status, never the data from a healthy request. The user's
  // console-key quota error takes precedence over a ZCode-managed failure.
  const keyError = keyResult.status === 'rejected' ? keyResult.reason : keyResult.value.error;
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
  const planError = planResult.status === 'rejected'
    ? planResult.reason
    : planResult.value?.error || null;
  const planAttempted = !key && planResult.status === 'fulfilled' && Boolean(planResult.value.attempted);
  const source = key ? 'api' : (hasAnything || planError || planAttempted ? 'oauth' : '');
  return normalizeLimitProvider({
    provider: 'zai',
    ...(accountKey ? { accountKey } : {}),
    ...(accountLabel ? { accountLabel } : {}),
    ...(balance ? { balance } : {}),
    source,
    status: keyError ? laneErrorStatus(keyError)
      : planError ? (planError.status === 'sourceRateLimited' ? 'sourceRateLimited' : 'unavailable')
        : hasAnything ? 'ok'
          : key || planAttempted ? 'unavailable' : 'notConfigured',
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

function startOfLocalMonth(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  return date.getTime();
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
  if (!store || typeof store !== 'object' || Array.isArray(store)
    || !store.accounts || typeof store.accounts !== 'object' || Array.isArray(store.accounts)) {
    store = { version: ZAI_SPEND_STORE_VERSION, accounts: {} };
  }
  let entry = store.accounts[accountKey];
  let changed = false;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    entry = { lastTotal: null, allTimeSpend: 0, dailySpend: {}, trackingSince: nowMs };
    changed = true;
  }
  if (!entry.dailySpend || typeof entry.dailySpend !== 'object' || Array.isArray(entry.dailySpend)) {
    entry.dailySpend = {};
    changed = true;
  }
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
  // The spend record is best-effort: a failed write (read-only dir, disk
  // full) must not reject the key lane and discard a successful quota and
  // balance response — the next round re-reads the old baseline and its
  // delta still lands.
  if (changed) {
    try {
      write(storePath, store);
    } catch (_) {}
  }

  const todayKey = zaiLocalDayKey(nowMs);
  const monthKey = todayKey.slice(0, 7);
  // Rolling 7 days, matching DeepSeek's balance history so the same wire
  // field means the same thing across providers.
  const weekStart = new Date(nowMs);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - 6);
  const weekKey = zaiLocalDayKey(weekStart.getTime());
  const sumSince = (predicate) => Object.entries(entry.dailySpend)
    .filter(([key]) => predicate(key))
    .reduce((sum, [, amount]) => sum + amount, 0);
  return {
    todaySpend: entry.dailySpend[todayKey] || 0,
    weekSpend: Math.round(sumSince((key) => key >= weekKey) * 100) / 100,
    monthSpend: Math.round(sumSince((key) => key.startsWith(monthKey)) * 100) / 100,
    allTimeSpend: entry.allTimeSpend,
    trackingSince: entry.trackingSince,
    // Same rule as DeepSeek's balance history: true while tracking began
    // within the current local month.
    monthSinceTracking: Number(entry.trackingSince) > startOfLocalMonth(nowMs)
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
function zcodePlanBucketWindow(balance, periodByEntitlement = new Map()) {
  const total = numberOrNull(balance?.total_units);
  let used = numberOrNull(balance?.used_units);
  let remaining = numberOrNull(balance?.remaining_units);
  if (used === null && total !== null && remaining !== null) used = Math.max(0, total - remaining);
  if (remaining === null && total !== null && used !== null) remaining = Math.max(0, total - used);
  if (total === null && used === null && remaining === null) return null;
  let usedPercent = null;
  if (total !== null && total > 0) {
    if (remaining !== null) usedPercent = clampPercent(100 - (remaining / total) * 100);
    else if (used !== null) usedPercent = clampPercent((used / total) * 100);
  }
  if (usedPercent === null) usedPercent = clampPercent(balance?.percentage);
  const period = periodByEntitlement.get(JSON.stringify([balance?.plan_id || '', balance?.entitlement_id || '']))
    || String(balance?.period || '');
  const label = String(balance?.show_name || '').trim() || 'Start Plan';
  const resetsAt = toIso(balance?.expires_at ?? balance?.period_end);
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
  if (resetsAt) {
    window.resetsAt = resetsAt;
    window.boundaryKind = period === 'daily' ? 'reset' : 'expiry';
  }
  return window;
}

function zcodePeriodByEntitlement(payload) {
  const periodByEntitlement = new Map();
  const plans = Array.isArray(payload?.data?.plans) ? payload.data.plans : [];
  for (const plan of plans) {
    const entitlements = Array.isArray(plan?.entitlements) ? plan.entitlements : [];
    for (const entitlement of entitlements) {
      const id = String(entitlement?.entitlement_id || '').trim();
      const period = String(entitlement?.period || '').trim();
      if (id && period) periodByEntitlement.set(JSON.stringify([plan?.plan_id || '', id]), period);
    }
  }
  return periodByEntitlement;
}

function parseZcodeStartPlanBalances(payload) {
  const periodByEntitlement = zcodePeriodByEntitlement(payload);
  const balances = Array.isArray(payload?.data?.balances) ? payload.data.balances : [];
  const groups = new Map();
  for (const [index, balance] of balances.entries()) {
    const window = zcodePlanBucketWindow(balance, periodByEntitlement);
    if (!window) continue;
    // The API model name is the aggregation grain, independent of the
    // Start/Weekend grant and of any present or future model version.
    const identity = String(balance.show_name || '').trim().toLowerCase();
    const period = periodByEntitlement.get(JSON.stringify([balance.plan_id || '', balance.entitlement_id || '']))
      || String(balance.period || '');
    const complete = Number.isFinite(window.limit) && window.limit > 0 && Number.isFinite(window.remaining);
    const key = JSON.stringify([identity,
      // Unknown identity or incomplete numbers cannot safely be added.
      identity.length && complete ? '' : index]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ window, period });
  }
  const windows = [...groups.entries()].map(([key, entries]) => {
    // Sort before picking the representative so payload order changes no UI.
    entries.sort((a, b) => a.window.label.localeCompare(b.window.label)
      || a.window.limitId.localeCompare(b.window.limitId));
    const window = { ...entries[0].window };
    if (entries.length > 1) {
      window.limit = entries.reduce((sum, entry) => sum + entry.window.limit, 0);
      window.remaining = entries.reduce((sum, entry) => sum + entry.window.remaining, 0);
      window.used = entries.reduce((sum, entry) => sum + entry.window.used, 0);
      window.usedPercent = clampPercent(window.used / window.limit * 100);
      window.remainingPercent = 100 - window.usedPercent;
      window.limitId = `zcode-model:${hashKey(key)}`;
    } else if (!window.limitId) {
      window.limitId = `zcode-bucket:${hashKey(key)}`;
    }
    const periods = [...new Set(entries.map(entry => entry.period))].sort();
    const boundaries = [...new Map(entries
      .filter(entry => entry.window.resetsAt)
      .map(entry => {
        const boundary = {
          at: entry.window.resetsAt,
          kind: entry.window.boundaryKind || 'reset'
        };
        return [`${boundary.at}:${boundary.kind}`, boundary];
      })).values()]
      .sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind));
    const nextAt = boundaries[0]?.at || null;
    const nextKinds = new Set(boundaries
      .filter(boundary => boundary.at === nextAt)
      .map(boundary => boundary.kind));
    if (nextAt) {
      window.resetsAt = nextAt;
      window.boundaryKind = nextKinds.size > 1 ? 'mixed' : [...nextKinds][0];
    }
    const uniformDaily = periods.length === 1 && periods[0] === 'daily'
      && new Set(boundaries.map(boundary => boundary.at)).size === 1;
    if (!uniformDaily) {
      window.kind = 'billing';
      delete window.windowMinutes;
      // resetsAt remains the compatibility/scheduling timestamp. boundaryKind
      // tells every presentation surface whether that earliest change is a
      // replenishing reset, a grant expiry, or both at the same instant.
    }
    return window;
  }).sort((a, b) => a.label.localeCompare(b.label) || a.limitId.localeCompare(b.limitId));
  // Prefer renewing daily entitlements, then a stable identity as a tie-break.
  // Weekend ids also contain start-plan, so matching that substring is not
  // enough to choose the account header.
  const plans = (Array.isArray(payload?.data?.plans) ? payload.data.plans : [])
    .filter(entry => entry?.status === 'active')
    .sort((a, b) => Number(Array.isArray(b.entitlements) && b.entitlements.some(entry => entry?.period === 'daily'))
      - Number(Array.isArray(a.entitlements) && a.entitlements.some(entry => entry?.period === 'daily'))
      || String(a.plan_id || a.name || '').localeCompare(String(b.plan_id || b.name || '')));
  return { plan: String(plans[0]?.name || '').trim(), windows };
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
