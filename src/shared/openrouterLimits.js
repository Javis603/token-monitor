'use strict';

const { createOutboundFetch } = require('./outboundFetch');
const { hashKey } = require('./hashKey');
const { normalizeLimitProvider } = require('./limits');

const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

function cleanSecret(value) {
  let raw = typeof value === 'string' ? value.trim() : '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function openrouterToken(env = process.env, explicitKey = '') {
  return cleanSecret(explicitKey)
    || cleanSecret(env.TOKEN_MONITOR_OPENROUTER_API_KEY)
    || cleanSecret(env.OPENROUTER_API_KEY);
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusForHttp(code) {
  if (code === 401 || code === 403) return 'unauthorized';
  if (code === 429) return 'sourceRateLimited';
  return 'unavailable';
}

async function requestJson(url, apiKey, deps = {}) {
  const fetchFn = createOutboundFetch(deps.env || process.env, deps);
  const response = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'HTTP-Referer': 'https://github.com/Javis603/token-monitor',
      'X-Title': 'Token Monitor'
    },
    signal: deps.signal
  });
  if (!response?.ok) {
    const error = new Error(`OpenRouter request failed (${response?.status || 'unknown'})`);
    error.status = statusForHttp(Number(response?.status));
    error.statusCode = Number(response?.status) || null;
    throw error;
  }
  return response.json();
}

function keyLimitWindow(data) {
  const limit = finiteNumber(data?.limit);
  if (!(limit > 0)) return null;
  const used = Math.max(0, finiteNumber(data?.usage) || 0);
  const providedRemaining = finiteNumber(data?.limit_remaining);
  const remaining = providedRemaining === null ? Math.max(0, limit - used) : Math.max(0, providedRemaining);
  const reset = String(data?.limit_reset || '').trim().toLowerCase();
  const kind = reset === 'daily' ? 'session' : reset === 'weekly' ? 'weekly' : 'billing';
  const label = reset === 'daily'
    ? 'Daily limit'
    : reset === 'weekly'
      ? 'Weekly limit'
      : reset === 'monthly'
        ? 'Monthly limit'
        : 'API key limit';
  return { kind, label, used, limit, remaining, showMeter: true };
}

function creditsWindow(data) {
  const totalCredits = finiteNumber(data?.total_credits);
  const totalUsage = finiteNumber(data?.total_usage);
  if (!(totalCredits > 0) || totalUsage === null) return null;
  return {
    kind: 'billing',
    label: 'Credits',
    used: Math.max(0, totalUsage),
    limit: totalCredits,
    remaining: Math.max(0, totalCredits - totalUsage),
    showMeter: true
  };
}

function spendDetail(data) {
  const rows = [
    ['Today', finiteNumber(data?.usage_daily)],
    ['Week', finiteNumber(data?.usage_weekly)],
    ['Month', finiteNumber(data?.usage_monthly)],
    ['All time', finiteNumber(data?.usage)]
  ].filter(([, value]) => value !== null);
  return rows.map(([label, value]) => `${label} $${Math.max(0, value).toFixed(2)}`).join(' · ');
}

async function fetchOpenRouterAccount(name, apiKey, deps = {}) {
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const [keyResult, creditsResult] = await Promise.allSettled([
    requestJson(OPENROUTER_KEY_URL, apiKey, deps),
    requestJson(OPENROUTER_CREDITS_URL, apiKey, deps)
  ]);

  if (keyResult.status === 'rejected' && creditsResult.status === 'rejected') {
    const keyStatus = keyResult.reason?.status;
    const creditsStatus = creditsResult.reason?.status;
    const status = keyStatus === 'unauthorized' && creditsStatus === 'unauthorized'
      ? 'unauthorized'
      : keyStatus === 'sourceRateLimited' || creditsStatus === 'sourceRateLimited'
        ? 'sourceRateLimited'
        : 'unavailable';
    return normalizeLimitProvider({
      provider: 'openrouter',
      accountKey: hashKey('openrouter', apiKey),
      accountName: name,
      accountLabel: name,
      source: 'api',
      status,
      updatedAt,
      windows: []
    });
  }

  const keyData = keyResult.status === 'fulfilled' ? keyResult.value?.data : null;
  const creditsData = creditsResult.status === 'fulfilled' ? creditsResult.value?.data : null;
  const windows = [keyLimitWindow(keyData), creditsWindow(creditsData)].filter(Boolean);
  const detail = spendDetail(keyData);
  if (detail) windows.push({ kind: 'billing', label: 'Spend', detail, showMeter: false });

  const totalCredits = finiteNumber(creditsData?.total_credits);
  const totalUsage = finiteNumber(creditsData?.total_usage);
  const amount = totalCredits === null || totalUsage === null
    ? null
    : Math.max(0, totalCredits - totalUsage);

  return normalizeLimitProvider({
    provider: 'openrouter',
    accountKey: hashKey('openrouter', apiKey),
    accountName: name,
    accountLabel: name,
    planLabel: keyData?.is_management_key === true
      ? 'Management'
      : keyData?.is_free_tier === true
        ? 'Free'
        : '',
    source: 'api',
    status: 'ok',
    updatedAt,
    windows,
    balance: {
      amount,
      currency: 'USD',
      todaySpend: finiteNumber(keyData?.usage_daily),
      monthSpend: finiteNumber(keyData?.usage_monthly)
    }
  });
}

function configuredAccounts(options = {}, deps = {}) {
  const accounts = [];
  const seenKeys = new Set();
  for (const [name, profile] of Object.entries(options.openrouterProfiles || {})) {
    const apiKey = cleanSecret(profile?.apiKey);
    if (profile?.enabled !== false && apiKey && !seenKeys.has(apiKey)) {
      accounts.push({ name: String(name).trim(), apiKey });
      seenKeys.add(apiKey);
    }
  }
  const envKey = openrouterToken(deps.env || process.env);
  if (envKey && !seenKeys.has(envKey)) {
    accounts.push({ name: 'default (env)', apiKey: envKey });
  }
  return accounts.filter((account) => account.name);
}

async function fetchOpenRouterLimits(options = {}, deps = {}) {
  let accounts = configuredAccounts(options, deps);
  const scope = options.limitRefreshScope?.provider === 'openrouter'
    ? options.limitRefreshScope
    : null;
  if (scope) {
    const name = String(scope.accountName || scope.accountLabel || '').trim();
    accounts = name ? accounts.filter((account) => account.name === name) : [];
  }
  if (accounts.length === 0) {
    return normalizeLimitProvider({
      provider: 'openrouter',
      source: 'api',
      status: 'notConfigured',
      updatedAt: new Date((deps.now || Date.now)()).toISOString(),
      windows: []
    });
  }
  return Promise.all(accounts.map((account) => fetchOpenRouterAccount(account.name, account.apiKey, deps)));
}

module.exports = {
  OPENROUTER_CREDITS_URL,
  OPENROUTER_KEY_URL,
  configuredAccounts,
  creditsWindow,
  fetchOpenRouterAccount,
  fetchOpenRouterLimits,
  keyLimitWindow,
  openrouterToken,
  spendDetail
};
