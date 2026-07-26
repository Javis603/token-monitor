'use strict';

const { createOutboundFetch } = require('./outboundFetch');
const { hashKey } = require('./hashKey');
const { normalizeLimitProvider } = require('./limits');
const { normalizeNamedProfileName } = require('./namedProfile');

const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const OPENROUTER_ENV_ACCOUNT_NAME = 'environment';

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
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function openrouterProfileName(value) {
  return normalizeNamedProfileName(value, {
    reservedNames: [OPENROUTER_ENV_ACCOUNT_NAME, 'default (env)']
  });
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
      'X-OpenRouter-Title': 'Token Monitor'
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
  const providedUsed = finiteNumber(data?.usage);
  const providedRemaining = finiteNumber(data?.limit_remaining);
  if (providedUsed === null && providedRemaining === null) return null;
  const used = providedUsed === null
    ? Math.max(0, limit - providedRemaining)
    : Math.max(0, providedUsed);
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
  if (totalCredits === null || totalCredits < 0 || totalUsage === null || totalUsage < 0) return null;
  return {
    kind: 'billing',
    metric: 'credits',
    label: 'Credits',
    used: Math.max(0, totalUsage),
    limit: totalCredits,
    remaining: Math.max(0, totalCredits - totalUsage),
    usedPercent: totalCredits > 0
      ? Math.min(100, Math.max(0, (totalUsage / totalCredits) * 100))
      : 100,
    showMeter: true
  };
}

function spendAmounts(data) {
  const amount = (value) => {
    const number = finiteNumber(value);
    return number === null ? null : Math.max(0, number);
  };
  return {
    todaySpend: amount(data?.usage_daily),
    weekSpend: amount(data?.usage_weekly),
    monthSpend: amount(data?.usage_monthly),
    allTimeSpend: amount(data?.usage)
  };
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
  const spend = spendAmounts(keyData);

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
        : keyData?.is_free_tier === false
          ? 'Pay-as-you-go'
          : '',
    source: 'api',
    status: 'ok',
    updatedAt,
    windows,
    balance: {
      amount,
      currency: 'USD',
      ...spend
    }
  });
}

function configuredAccounts(options = {}, deps = {}) {
  const accounts = [];
  const seenKeys = new Set();
  for (const [name, profile] of Object.entries(options.openrouterProfiles || {})) {
    const profileName = openrouterProfileName(name);
    const apiKey = cleanSecret(profile?.apiKey);
    if (profile?.enabled !== false && profileName && apiKey && !seenKeys.has(apiKey)) {
      accounts.push({ name: profileName, apiKey });
      seenKeys.add(apiKey);
    }
  }
  const envKey = openrouterToken(deps.env || process.env);
  if (envKey && !seenKeys.has(envKey)) {
    accounts.push({ name: OPENROUTER_ENV_ACCOUNT_NAME, apiKey: envKey });
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
  OPENROUTER_ENV_ACCOUNT_NAME,
  OPENROUTER_CREDITS_URL,
  OPENROUTER_KEY_URL,
  configuredAccounts,
  creditsWindow,
  fetchOpenRouterAccount,
  fetchOpenRouterLimits,
  keyLimitWindow,
  openrouterProfileName,
  openrouterToken,
  spendAmounts
};
