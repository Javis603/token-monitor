'use strict';

const { createOutboundFetch } = require('./outboundFetch');
const { hashKey } = require('./hashKey');
const { normalizeLimitProvider } = require('./limits');
const { normalizeNamedProfileName } = require('./namedProfile');

const DEFAULT_QUOTA_PER_UNIT = 500_000;
const THIRD_PARTY_PROVIDER_ID = 'thirdparty';
const THIRD_PARTY_ENV_ACCOUNT_NAME = 'environment';
const NEWAPI_ACCOUNT_ADAPTER = 'newapi-account';
const NEWAPI_TOKEN_ADAPTER = 'newapi-token';
const CUSTOM_BALANCE_ADAPTER = 'custom';
const THIRD_PARTY_ADAPTER_IDS = Object.freeze([
  NEWAPI_ACCOUNT_ADAPTER,
  NEWAPI_TOKEN_ADAPTER,
  CUSTOM_BALANCE_ADAPTER
]);
const NEWAPI_STATUS_PATH = '/api/status';
const NEWAPI_ACCOUNT_PATH = '/api/user/self';
const NEWAPI_TOKEN_USAGE_PATH = '/api/usage/token/';
const DEFAULT_CUSTOM_ENDPOINT_PATH = '/user/balance';
const DEFAULT_CUSTOM_CURRENCY = 'USD';
const DEFAULT_CUSTOM_DIVISOR = 1;
const CUSTOM_AUTH_MODES = Object.freeze(['bearer', 'x-api-key']);

function cleanValue(value) {
  let raw = typeof value === 'string' ? value.trim() : '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function normalizeAdapterId(value) {
  const adapter = cleanValue(value);
  return THIRD_PARTY_ADAPTER_IDS.includes(adapter) ? adapter : '';
}

function normalizeThirdPartyBaseUrl(value, options = {}) {
  const raw = cleanValue(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
    if (options.stripTerminalV1 !== false) {
      parsed.pathname = parsed.pathname.replace(/\/v1$/iu, '') || '/';
    }
    return parsed.toString().replace(/\/$/u, '');
  } catch (_) {
    return '';
  }
}

function normalizeCustomEndpointPath(value) {
  const raw = cleanValue(value) || DEFAULT_CUSTOM_ENDPOINT_PATH;
  if (
    raw.length > 256
    || !raw.startsWith('/')
    || raw.startsWith('//')
    || raw.includes('\\')
  ) return '';
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch (_) {
    return '';
  }
  if (
    decoded.includes('\\')
    || decoded.split('/').some((segment) => segment === '.' || segment === '..')
  ) return '';
  try {
    const parsed = new URL(raw, 'https://token-monitor.invalid');
    if (
      parsed.origin !== 'https://token-monitor.invalid'
      || parsed.search
      || parsed.hash
    ) return '';
    return parsed.pathname;
  } catch (_) {
    return '';
  }
}

function normalizeCustomAuthMode(value) {
  const mode = cleanValue(value) || 'bearer';
  return CUSTOM_AUTH_MODES.includes(mode) ? mode : '';
}

function normalizeCustomJsonPath(value) {
  const raw = cleanValue(value);
  if (!raw || raw.length > 160) return '';
  const blocked = new Set(['__proto__', 'prototype', 'constructor']);
  const segments = raw.split('.');
  if (
    segments.length > 12
    || segments.some((segment) => (
      !/^[A-Za-z0-9_-]+$/u.test(segment)
      || blocked.has(segment)
    ))
  ) return '';
  return segments.join('.');
}

function normalizeCustomCurrency(value) {
  const currency = cleanValue(value || DEFAULT_CUSTOM_CURRENCY).toUpperCase();
  return /^[A-Z]{3,8}$/u.test(currency) ? currency : '';
}

function normalizeCustomDivisor(value) {
  const normalized = typeof value === 'string' ? value.trim() : value;
  const divisor = finiteNumber(
    normalized === '' || normalized === null || normalized === undefined
      ? DEFAULT_CUSTOM_DIVISOR
      : normalized
  );
  return divisor !== null && divisor > 0 && divisor <= 1e15 ? divisor : null;
}

function readCustomJsonPath(payload, path) {
  const normalized = normalizeCustomJsonPath(path);
  if (!normalized) return undefined;
  let current = payload;
  for (const segment of normalized.split('.')) {
    if (
      current === null
      || typeof current !== 'object'
      || !Object.prototype.hasOwnProperty.call(current, segment)
    ) return undefined;
    current = current[segment];
  }
  return current;
}

function thirdPartyProfileName(value) {
  return normalizeNamedProfileName(value, {
    reservedNames: [THIRD_PARTY_ENV_ACCOUNT_NAME]
  });
}

function newapiBaseUrl(env = process.env, explicitUrl = '') {
  return normalizeThirdPartyBaseUrl(explicitUrl)
    || normalizeThirdPartyBaseUrl(env.TOKEN_MONITOR_NEWAPI_BASE_URL);
}

function newapiApiKey(env = process.env, explicitKey = '') {
  return cleanValue(explicitKey)
    || cleanValue(env.TOKEN_MONITOR_NEWAPI_API_KEY);
}

function newapiAccessToken(env = process.env, explicitToken = '') {
  return cleanValue(explicitToken)
    || cleanValue(env.TOKEN_MONITOR_NEWAPI_ACCESS_TOKEN);
}

function newapiUserId(env = process.env, explicitUserId = '') {
  return cleanValue(explicitUserId)
    || cleanValue(env.TOKEN_MONITOR_NEWAPI_USER_ID);
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function responseData(payload) {
  if (payload?.code === false || payload?.success === false) return null;
  return payload && typeof payload.data === 'object' && payload.data !== null
    ? payload.data
    : null;
}

function quotaPerUnit(statusPayload) {
  const value = finiteNumber(responseData(statusPayload)?.quota_per_unit);
  return value && value > 0 ? value : DEFAULT_QUOTA_PER_UNIT;
}

function quotaAmount(value, unit) {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, number) / unit;
}

function unixTimestampIso(value) {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function quotaResult({
  label,
  remaining,
  used,
  total = null,
  unlimited = false,
  requestCount = null,
  quotaGroup = '',
  expiresAt = null
}) {
  const remainingAmount = quotaAmount(remaining, 1);
  const usedAmount = quotaAmount(used, 1);
  const explicitTotalAmount = quotaAmount(total, 1);
  const normalizedRequestCount = finiteNumber(requestCount);
  const normalizedQuotaGroup = cleanValue(quotaGroup).slice(0, 64);
  const balance = {
    amount: unlimited ? null : remainingAmount,
    currency: 'USD',
    allTimeSpend: usedAmount,
    requestCount: normalizedRequestCount === null
      ? null
      : Math.max(0, Math.trunc(normalizedRequestCount)),
    quotaGroup: normalizedQuotaGroup,
    expiresAt: unixTimestampIso(expiresAt)
  };
  if (unlimited) {
    return {
      window: {
        kind: 'billing',
        metric: 'credits',
        label,
        detail: 'Unlimited',
        showMeter: false
      },
      balance
    };
  }
  if (remainingAmount === null) return null;
  if (explicitTotalAmount !== null && explicitTotalAmount < remainingAmount) return null;
  const totalAmount = explicitTotalAmount
    ?? (usedAmount === null ? null : remainingAmount + usedAmount);
  const meterUsedAmount = usedAmount
    ?? (totalAmount === null ? null : Math.max(0, totalAmount - remainingAmount));
  return {
    window: {
      kind: 'billing',
      metric: 'credits',
      label,
      ...(meterUsedAmount !== null ? { used: meterUsedAmount } : {}),
      ...(totalAmount !== null ? { limit: totalAmount } : {}),
      remaining: remainingAmount,
      ...(totalAmount !== null
        ? {
            usedPercent: totalAmount > 0
              ? Math.min(100, Math.max(0, (meterUsedAmount / totalAmount) * 100))
              : 100
          }
        : {}),
      showMeter: totalAmount !== null
    },
    balance
  };
}

function newapiAccountQuota(accountData, unit) {
  const rawQuota = finiteNumber(accountData?.quota);
  const unlimited = accountData?.unlimited_quota === true || rawQuota === -1;
  return quotaResult({
    label: 'Balance',
    remaining: unlimited ? null : quotaAmount(rawQuota, unit),
    used: quotaAmount(accountData?.used_quota, unit),
    unlimited,
    requestCount: accountData?.request_count,
    quotaGroup: accountData?.group
  });
}

function newapiTokenQuota(tokenData, unit) {
  return quotaResult({
    label: 'Token quota',
    remaining: quotaAmount(tokenData?.total_available, unit),
    used: quotaAmount(tokenData?.total_used, unit),
    unlimited: tokenData?.unlimited_quota === true,
    expiresAt: tokenData?.expires_at
  });
}

function customBalanceQuota(payload, account) {
  if (payload?.success === false || payload?.code === false) return null;
  const divisor = account.divisor;
  const mappedNumber = (path) => {
    if (!path) return null;
    const value = finiteNumber(readCustomJsonPath(payload, path));
    return value === null ? null : value / divisor;
  };
  const remaining = mappedNumber(account.remainingPath);
  if (remaining === null) return null;
  return quotaResult({
    label: 'Balance',
    remaining,
    used: mappedNumber(account.usedPath),
    total: mappedNumber(account.totalPath)
  });
}

function statusForHttp(code) {
  if (code === 401 || code === 403) return 'unauthorized';
  if (code === 429) return 'sourceRateLimited';
  return 'unavailable';
}

const THIRD_PARTY_ADAPTERS = Object.freeze({
  [NEWAPI_ACCOUNT_ADAPTER]: Object.freeze({
    platform: 'newapi',
    mode: 'account',
    normalizeCredentials(profile) {
      const accessToken = cleanValue(profile.accessToken);
      const userId = cleanValue(profile.userId);
      return accessToken
        ? { accessToken, ...(userId ? { userId } : {}) }
        : null;
    },
    identity(account) {
      return [account.baseUrl, account.userId || '', account.accessToken];
    },
    request(account) {
      return {
        path: NEWAPI_ACCOUNT_PATH,
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          ...(account.userId ? { 'New-Api-User': account.userId } : {})
        }
      };
    },
    statusRequest() {
      return { path: NEWAPI_STATUS_PATH, headers: {} };
    },
    unit(statusPayload) {
      return quotaPerUnit(statusPayload);
    },
    quota(payload, unit) {
      const data = responseData(payload);
      return data ? newapiAccountQuota(data, unit) : null;
    },
    planLabel() {
      return 'Account';
    }
  }),
  [NEWAPI_TOKEN_ADAPTER]: Object.freeze({
    platform: 'newapi',
    mode: 'token',
    normalizeCredentials(profile) {
      const apiKey = cleanValue(profile.apiKey);
      return apiKey ? { apiKey } : null;
    },
    identity(account) {
      return [account.baseUrl, account.apiKey];
    },
    request(account) {
      return {
        path: NEWAPI_TOKEN_USAGE_PATH,
        headers: {
          Authorization: `Bearer ${account.apiKey}`
        }
      };
    },
    statusRequest() {
      return { path: NEWAPI_STATUS_PATH, headers: {} };
    },
    unit(statusPayload) {
      return quotaPerUnit(statusPayload);
    },
    quota(payload, unit) {
      const data = responseData(payload);
      return data ? newapiTokenQuota(data, unit) : null;
    },
    planLabel() {
      return 'API key';
    }
  }),
  [CUSTOM_BALANCE_ADAPTER]: Object.freeze({
    platform: 'custom',
    mode: 'custom',
    normalizeCredentials(profile) {
      const apiKey = cleanValue(profile.apiKey);
      const endpointPath = normalizeCustomEndpointPath(profile.endpointPath);
      const authMode = normalizeCustomAuthMode(profile.authMode);
      const remainingPath = normalizeCustomJsonPath(profile.remainingPath);
      const usedRaw = cleanValue(profile.usedPath);
      const totalRaw = cleanValue(profile.totalPath);
      const usedPath = usedRaw ? normalizeCustomJsonPath(usedRaw) : '';
      const totalPath = totalRaw ? normalizeCustomJsonPath(totalRaw) : '';
      const currency = normalizeCustomCurrency(profile.currency);
      const divisor = normalizeCustomDivisor(profile.divisor);
      return (
        apiKey
        && endpointPath
        && authMode
        && remainingPath
        && (!usedRaw || usedPath)
        && (!totalRaw || totalPath)
        && currency
        && divisor !== null
      )
        ? {
            apiKey,
            endpointPath,
            authMode,
            remainingPath,
            usedPath,
            totalPath,
            currency,
            divisor
          }
        : null;
    },
    identity(account) {
      return [
        account.baseUrl,
        account.endpointPath,
        account.authMode,
        account.apiKey
      ];
    },
    request(account) {
      const headers = account.authMode === 'x-api-key'
        ? { 'x-api-key': account.apiKey }
        : { Authorization: `Bearer ${account.apiKey}` };
      return {
        path: account.endpointPath,
        headers
      };
    },
    unit() {
      return 1;
    },
    quota(payload, _unit, account) {
      const quota = customBalanceQuota(payload, account);
      if (quota) quota.balance.currency = account.currency;
      return quota;
    },
    planLabel() {
      return 'Custom';
    }
  })
});

function endpoint(baseUrl, path) {
  return `${baseUrl}${path}`;
}

async function requestJson(url, options = {}, deps = {}) {
  const fetchFn = createOutboundFetch(deps.env || process.env, deps);
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.headers || {})
    },
    redirect: 'error',
    signal: deps.signal
  });
  if (!response?.ok) {
    const error = new Error(`Third-party API request failed (${response?.status || 'unknown'})`);
    error.status = statusForHttp(Number(response?.status));
    error.statusCode = Number(response?.status) || null;
    throw error;
  }
  return response.json();
}

function normalizeThirdPartyProfile(profile = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const adapter = normalizeAdapterId(profile.adapter);
  const baseUrl = normalizeThirdPartyBaseUrl(profile.baseUrl, {
    stripTerminalV1: adapter !== CUSTOM_BALANCE_ADAPTER
  });
  const enabled = profile.enabled !== false;
  const credentials = THIRD_PARTY_ADAPTERS[adapter]?.normalizeCredentials(profile);
  return adapter && baseUrl && credentials
    ? { adapter, baseUrl, ...credentials, enabled }
    : null;
}

function accountIdentity(account) {
  const identity = THIRD_PARTY_ADAPTERS[account.adapter]?.identity(account) || [];
  return [account.adapter, ...identity].join('\0');
}

function configuredAccounts(options = {}, deps = {}) {
  const accounts = [];
  const seen = new Set();
  for (const [name, profile] of Object.entries(options.thirdPartyProfiles || {})) {
    const profileName = thirdPartyProfileName(name);
    const normalized = normalizeThirdPartyProfile(profile);
    if (!profileName || !normalized?.enabled) continue;
    const identity = accountIdentity(normalized);
    if (seen.has(identity)) continue;
    accounts.push({ name: profileName, ...normalized });
    seen.add(identity);
  }

  const env = deps.env || process.env;
  const baseUrl = newapiBaseUrl(env);
  const accessToken = newapiAccessToken(env);
  const userId = newapiUserId(env);
  const apiKey = newapiApiKey(env);
  const environmentProfile = accessToken
    ? normalizeThirdPartyProfile({
      adapter: NEWAPI_ACCOUNT_ADAPTER,
      baseUrl,
      accessToken,
      userId
    })
    : normalizeThirdPartyProfile({
      adapter: NEWAPI_TOKEN_ADAPTER,
      baseUrl,
      apiKey
    });
  if (environmentProfile) {
    const identity = accountIdentity(environmentProfile);
    if (!seen.has(identity)) {
      accounts.push({ name: THIRD_PARTY_ENV_ACCOUNT_NAME, ...environmentProfile });
    }
  }
  return accounts;
}

async function fetchThirdPartyAccount(account, deps = {}) {
  if (deps.signal?.aborted) {
    throw deps.signal.reason || Object.assign(new Error('Third-party API request aborted'), { name: 'AbortError' });
  }
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const adapter = THIRD_PARTY_ADAPTERS[account.adapter];
  if (!adapter) {
    return normalizeLimitProvider({
      provider: THIRD_PARTY_PROVIDER_ID,
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: []
    });
  }
  const request = adapter.request(account);
  const statusRequest = adapter.statusRequest?.(account);
  const [quotaResponse, statusResponse] = await Promise.allSettled([
    requestJson(endpoint(account.baseUrl, request.path), { headers: request.headers }, deps),
    statusRequest
      ? requestJson(endpoint(account.baseUrl, statusRequest.path), { headers: statusRequest.headers }, deps)
      : Promise.resolve(null)
  ]);
  if (deps.signal?.aborted) {
    throw deps.signal.reason || Object.assign(new Error('Third-party API request aborted'), { name: 'AbortError' });
  }

  const common = {
    provider: THIRD_PARTY_PROVIDER_ID,
    accountKey: hashKey(THIRD_PARTY_PROVIDER_ID, accountIdentity(account)),
    accountName: account.name,
    accountLabel: account.name,
    source: 'api',
    updatedAt
  };
  if (quotaResponse.status === 'rejected') {
    return normalizeLimitProvider({
      ...common,
      status: quotaResponse.reason?.status || 'unavailable',
      windows: []
    });
  }
  if (statusRequest && statusResponse.status === 'rejected') {
    return normalizeLimitProvider({
      ...common,
      status: 'unavailable',
      windows: []
    });
  }

  const unit = adapter.unit(
    statusResponse.status === 'fulfilled' ? statusResponse.value : null
  );
  const quota = adapter.quota(quotaResponse.value, unit, account);
  if (!quota) {
    return normalizeLimitProvider({
      ...common,
      status: 'unavailable',
      windows: []
    });
  }

  return normalizeLimitProvider({
    ...common,
    planLabel: adapter.planLabel(),
    status: 'ok',
    windows: [quota.window],
    balance: quota.balance
  });
}

async function fetchThirdPartyLimits(options = {}, deps = {}) {
  let accounts = configuredAccounts(options, deps);
  const scope = options.limitRefreshScope?.provider === THIRD_PARTY_PROVIDER_ID
    ? options.limitRefreshScope
    : null;
  if (scope) {
    const name = String(scope.accountName || scope.accountLabel || '').trim();
    accounts = name ? accounts.filter((account) => account.name === name) : [];
  }
  if (accounts.length === 0) {
    return normalizeLimitProvider({
      provider: THIRD_PARTY_PROVIDER_ID,
      source: 'api',
      status: 'notConfigured',
      updatedAt: new Date((deps.now || Date.now)()).toISOString(),
      windows: []
    });
  }
  return Promise.all(accounts.map((account) => fetchThirdPartyAccount(account, deps)));
}

module.exports = {
  DEFAULT_QUOTA_PER_UNIT,
  CUSTOM_AUTH_MODES,
  CUSTOM_BALANCE_ADAPTER,
  DEFAULT_CUSTOM_CURRENCY,
  DEFAULT_CUSTOM_DIVISOR,
  DEFAULT_CUSTOM_ENDPOINT_PATH,
  NEWAPI_ACCOUNT_ADAPTER,
  NEWAPI_ACCOUNT_PATH,
  NEWAPI_STATUS_PATH,
  NEWAPI_TOKEN_ADAPTER,
  NEWAPI_TOKEN_USAGE_PATH,
  THIRD_PARTY_ADAPTER_IDS,
  THIRD_PARTY_ADAPTERS,
  THIRD_PARTY_ENV_ACCOUNT_NAME,
  THIRD_PARTY_PROVIDER_ID,
  configuredAccounts,
  fetchThirdPartyAccount,
  fetchThirdPartyLimits,
  customBalanceQuota,
  newapiAccessToken,
  newapiAccountQuota,
  newapiApiKey,
  newapiBaseUrl,
  newapiTokenQuota,
  newapiUserId,
  normalizeAdapterId,
  normalizeCustomAuthMode,
  normalizeCustomCurrency,
  normalizeCustomDivisor,
  normalizeCustomEndpointPath,
  normalizeCustomJsonPath,
  normalizeThirdPartyBaseUrl,
  normalizeThirdPartyProfile,
  quotaPerUnit,
  readCustomJsonPath,
  thirdPartyProfileName
};
