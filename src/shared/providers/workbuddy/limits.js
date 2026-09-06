'use strict';

const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const {
  cleanSecret,
  firstSetting,
  numberOrNull
} = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');

const WORKBUDDY_FETCH_TIMEOUT_MS = 12_000;
const WORKBUDDY_DEFAULT_ENDPOINT = 'https://copilot.tencent.com';
const WORKBUDDY_PERSONAL_PATH = '/v2/billing/meter/get-user-resource';
const WORKBUDDY_ENTERPRISE_PATH = '/v2/billing/meter/get-enterprise-user-usage';
const WORKBUDDY_PRODUCT_CODE = 'p_tcaca';

function workbuddyAccessToken(env = process.env, options = {}) {
  return firstSetting(options, env, 'workbuddyAccessToken', [
    'TOKEN_MONITOR_WORKBUDDY_ACCESS_TOKEN',
    'WORKBUDDY_ACCESS_TOKEN'
  ]).replace(/^authorization\s*:\s*/i, '').replace(/^bearer\s+/i, '').trim();
}

function workbuddyUserId(env = process.env, options = {}) {
  return firstSetting(options, env, 'workbuddyUserId', [
    'TOKEN_MONITOR_WORKBUDDY_USER_ID',
    'WORKBUDDY_USER_ID'
  ]);
}

function workbuddyEnterpriseId(env = process.env, options = {}) {
  return firstSetting(options, env, 'workbuddyEnterpriseId', [
    'TOKEN_MONITOR_WORKBUDDY_ENTERPRISE_ID',
    'WORKBUDDY_ENTERPRISE_ID'
  ]);
}

function workbuddyDomain(env = process.env, options = {}) {
  return firstSetting(options, env, 'workbuddyDomain', [
    'TOKEN_MONITOR_WORKBUDDY_DOMAIN',
    'WORKBUDDY_DOMAIN'
  ]);
}

function workbuddyDepartmentInfo(env = process.env, options = {}) {
  return firstSetting(options, env, 'workbuddyDepartmentInfo', [
    'TOKEN_MONITOR_WORKBUDDY_DEPARTMENT_INFO',
    'WORKBUDDY_DEPARTMENT_INFO'
  ]);
}

function workbuddyLocale(env = process.env, options = {}) {
  const value = firstSetting(options, env, 'workbuddyLocale', [
    'TOKEN_MONITOR_WORKBUDDY_LOCALE',
    'WORKBUDDY_LOCALE'
  ]).toLowerCase();
  if (value.startsWith('en')) return 'en';
  if (value.startsWith('zh')) return 'zh';
  return '';
}

// WorkBuddy's numeric timestamp strings are milliseconds, unlike the Unix
// seconds convention used by a few other providers.
function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number' || /^\d+$/.test(String(value).trim())
    ? new Date(Number(value))
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pickValue(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return null;
}

function accountIdentity(source) {
  return String(pickValue(source, [
    'AccountId', 'accountId', 'UserId', 'userId', 'Uid', 'uid', 'TenantId', 'tenantId'
  ]) || '').trim();
}

function pickArray(source, paths) {
  for (const path of paths) {
    let value = source;
    for (const key of path) value = value?.[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function parsePersonalAccounts(body) {
  const accounts = pickArray(body, [
    ['data', 'Response', 'Data', 'Accounts'],
    ['data', 'data', 'Response', 'Data', 'Accounts'],
    ['Response', 'Data', 'Accounts'],
    ['data', 'response', 'data', 'accounts'],
    ['response', 'data', 'accounts']
  ]);
  if (!accounts) throw new Error('WorkBuddy personal billing response has no Accounts array');
  return accounts;
}

function parsePersonalUsage(body) {
  const resources = parsePersonalAccounts(body);
  let used = 0;
  let limit = 0;
  let remaining = 0;
  let validResources = 0;
  let candidateResources = 0;
  const accountId = resources.map(accountIdentity).find(Boolean) || '';

  for (const resource of resources) {
    if (!resource || typeof resource !== 'object') {
      candidateResources += 1;
      continue;
    }
    const status = numberOrNull(pickValue(resource, ['Status', 'status']));
    // Status 3 is an exhausted/expired resource package. It is returned by
    // the endpoint even with OnlyValidPeriod=true, but it is not part of the
    // currently spendable balance shown by WorkBuddy's website.
    if (status !== null && status !== 0) continue;
    candidateResources += 1;
    const total = numberOrNull(pickValue(resource, ['CycleCapacitySizePrecise', 'cycleCapacitySizePrecise']));
    const left = numberOrNull(pickValue(resource, ['CycleCapacityRemainPrecise', 'cycleCapacityRemainPrecise']));
    if (total === null || left === null || total < 0 || left < 0) continue;
    const safeTotal = total;
    const safeRemaining = Math.min(safeTotal, left);
    const reportedUsed = numberOrNull(pickValue(resource, ['CycleCapacityUsedPrecise', 'cycleCapacityUsedPrecise']));
    const safeUsed = reportedUsed === null
      ? Math.max(0, safeTotal - safeRemaining)
      : Math.min(safeTotal, Math.max(0, reportedUsed));
    limit += safeTotal;
    remaining += safeRemaining;
    used += safeUsed;
    validResources += 1;
  }

  // Returning a partial aggregate is worse than returning no snapshot: the
  // omitted active package would make a plausible-looking balance incorrect.
  // Explicitly inactive rows were excluded before candidateResources increased.
  if (candidateResources > validResources) {
    throw new Error('WorkBuddy personal billing response contains unusable active resource packages');
  }

  if (validResources === 0) {
    return { used: 0, limit: 0, remaining: 0, resetsAt: null, resourceCount: 0, accountId, window: null };
  }

  const usedPercent = limit > 0 ? (used / limit) * 100 : null;
  return {
    used,
    limit,
    remaining,
    resetsAt: null,
    resourceCount: validResources,
    accountId,
    window: {
      kind: 'billing',
      label: 'Credits',
      metric: 'credits',
      currency: 'CREDITS',
      used,
      limit,
      remaining,
      usedPercent,
      // Each WorkBuddy resource package has its own expiry. There is no
      // single reset timestamp for this aggregate window.
      resetsAt: null,
      showMeter: usedPercent !== null
    }
  };
}

function unwrapEnterpriseUsage(body) {
  const candidates = [
    body?.data?.data,
    body?.data,
    body?.Data,
    body
  ];
  return candidates.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || null;
}

function parseEnterpriseUsage(body) {
  const usage = unwrapEnterpriseUsage(body);
  const rawLimit = pickValue(usage, ['limitNum', 'limit_num']);
  const limit = numberOrNull(rawLimit);
  if (limit === null) throw new Error('WorkBuddy enterprise billing response has no limitNum');
  if (limit < 0 && limit !== -1) {
    throw new Error('WorkBuddy enterprise billing response has an invalid limitNum');
  }
  const rawUsed = numberOrNull(pickValue(usage, [
    'credit', 'used', 'usedNum', 'used_num'
  ]));
  if (rawUsed === null) throw new Error('WorkBuddy enterprise billing response has no usage value');
  if (rawUsed < 0) {
    throw new Error('WorkBuddy enterprise billing response has an invalid usage value');
  }
  const used = rawUsed;
  const resetsAt = toIso(pickValue(usage, ['cycleResetTime', 'cycle_reset_time']));
  const accountId = accountIdentity(usage);

  if (limit === -1) {
    return {
      used,
      limit: null,
      remaining: null,
      resetsAt,
      accountId,
      window: {
        kind: 'billing',
        label: 'Credits',
        metric: 'credits',
        currency: 'CREDITS',
        used,
        detail: 'unlimited',
        resetsAt,
        showMeter: false
      }
    };
  }

  const safeLimit = Math.max(0, limit);
  const remaining = Math.max(0, safeLimit - used);
  return {
    used,
    limit: safeLimit,
    remaining,
    resetsAt,
    accountId,
    window: {
      kind: 'billing',
      label: 'Credits',
      metric: 'credits',
      currency: 'CREDITS',
      used,
      limit: safeLimit,
      remaining,
      usedPercent: safeLimit > 0 ? (used / safeLimit) * 100 : null,
      resetsAt,
      showMeter: safeLimit > 0
    }
  };
}

function httpError(status) {
  const error = new Error(`WorkBuddy billing request returned HTTP ${status}`);
  error.status = status === 401 || status === 403
    ? 'unauthorized'
    : status === 429
      ? 'sourceRateLimited'
      : status >= 500 || status === 408
        ? 'unavailable'
        : 'error';
  return error;
}

function applicationError(code) {
  const error = new Error(`WorkBuddy billing response returned application code ${code}`);
  error.status = code === 401 || code === 403
    ? 'unauthorized'
    : code === 429
      ? 'sourceRateLimited'
      : 'error';
  return error;
}

async function fetchJson(url, init, deps = {}) {
  const deadlineMs = Number(deps.workbuddyFetchTimeoutMs || deps.fetchTimeoutMs || WORKBUDDY_FETCH_TIMEOUT_MS);
  return runWithProbeDeadline(
    async ({ signal }) => {
      const response = await (deps.fetch || fetch)(url, { ...init, signal });
      const status = Number(response?.status || 0);
      let body = null;
      if (typeof response?.json === 'function') {
        try { body = await response.json(); } catch (_) { body = null; }
      }
      if (response?.ok === false || status >= 400) throw httpError(status);
      if (body && typeof body === 'object' && Object.hasOwn(body, 'code')) {
        const code = numberOrNull(body.code);
        if (code !== 0 && code !== 200) throw applicationError(code ?? 'invalid');
      }
      return body;
    },
    { signal: deps.signal, deadlineMs }
  );
}

function requestHeaders(token, userId, enterpriseId, locale, domain, departmentInfo) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (userId) headers['X-User-Id'] = userId;
  if (enterpriseId) {
    headers['X-Enterprise-Id'] = enterpriseId;
    headers['X-Tenant-Id'] = enterpriseId;
  }
  if (domain) headers['X-Domain'] = domain;
  if (departmentInfo) headers['X-Department-Info'] = departmentInfo;
  if (locale) headers['Accept-Language'] = locale;
  return headers;
}

function workbuddyStatus(error) {
  if (['notConfigured', 'unauthorized', 'sourceRateLimited', 'unavailable', 'error'].includes(error?.status)) return error.status;
  if (error?.status === 'timeout' || error?.name === 'AbortError') return 'unavailable';
  return 'unavailable';
}

function workbuddyAccountKey(token, userId, enterpriseId, identity = '') {
  if (enterpriseId && userId) return hashKey('workbuddy', `enterprise:${enterpriseId}:${userId}`);
  if (userId) return hashKey('workbuddy', `user:${userId}`);
  if (identity) return hashKey('workbuddy', `account:${identity}`);
  return hashKey('workbuddy', token ? `token:${token}` : 'local-app');
}

async function fetchWorkbuddyLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const token = workbuddyAccessToken(env, options);
  const userId = workbuddyUserId(env, options);
  const enterpriseId = workbuddyEnterpriseId(env, options);
  const domain = workbuddyDomain(env, options);
  const departmentInfo = workbuddyDepartmentInfo(env, options);
  const accountType = cleanSecret(options.workbuddyAccountType);
  const localAppUnsupported = !token && options.workbuddyDesktopSessionSupported === false;
  // The desktop widget reads the session owned by the installed WorkBuddy
  // app. If an advanced/headless token is present, keep the explicit token
  // path deterministic rather than mixing its metadata with the app session.
  const useLocalApp = !localAppUnsupported
    && !token
    && options.workbuddyDesktopSessionEnabled === true
    && typeof deps.workbuddyFetch === 'function';
  const source = {
    provider: 'workbuddy',
    source: useLocalApp || localAppUnsupported ? 'local' : 'api',
    sourceDetail: useLocalApp || localAppUnsupported ? 'app' : 'unknown',
    updatedAt,
    windows: []
  };

  if (localAppUnsupported) return normalizeLimitProvider({ ...source, status: 'unavailable' });
  if (!token && !useLocalApp) return normalizeLimitProvider({ ...source, status: 'notConfigured' });

  const endpoint = WORKBUDDY_DEFAULT_ENDPOINT;
  const headers = useLocalApp
    ? requestHeaders('', '', '', '', '', '')
    : requestHeaders(token, userId, enterpriseId, workbuddyLocale(env, options), domain, departmentInfo);
  const expectedSession = useLocalApp
    ? {
        authenticated: true,
        userId,
        enterpriseId,
        departmentInfo,
        domain,
        accountType
      }
    : null;
  const requestDeps = useLocalApp
    ? {
        ...deps,
        fetch: (url, init) => deps.workbuddyFetch(url, init, expectedSession)
      }
    : deps;
  const accountKey = workbuddyAccountKey(token, userId, enterpriseId, '');
  try {
    const isEnterprise = Boolean(enterpriseId);
    const body = isEnterprise
      ? await fetchJson(`${endpoint}${WORKBUDDY_ENTERPRISE_PATH}`, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: '{}'
      }, requestDeps)
      : await fetchJson(`${endpoint}${WORKBUDDY_PERSONAL_PATH}`, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify({
          PageNumber: 1,
          PageSize: 100,
          ProductCode: WORKBUDDY_PRODUCT_CODE,
          // The endpoint can return exhausted/expired packages even when
          // OnlyValidPeriod is true. The website's spendable balance is the
          // active Status=0 set, so avoid downloading the historical rows too.
          Status: [0],
          OnlyValidPeriod: true
        })
      }, requestDeps);
    const usage = isEnterprise ? parseEnterpriseUsage(body) : parsePersonalUsage(body);
    const resolvedAccountKey = workbuddyAccountKey(token, userId, enterpriseId, usage.accountId);
    const balance = usage.window
      ? { amount: usage.remaining, currency: 'CREDITS' }
      : null;
    return normalizeLimitProvider({
      ...source,
      accountKey: resolvedAccountKey,
      accountLabel: isEnterprise ? 'Enterprise' : 'Personal',
      status: 'ok',
      windows: usage.window ? [usage.window] : [],
      ...(balance ? { balance } : {})
    });
  } catch (error) {
    return normalizeLimitProvider({ ...source, accountKey, status: workbuddyStatus(error) });
  }
}

module.exports = {
  WORKBUDDY_DEFAULT_ENDPOINT,
  WORKBUDDY_ENTERPRISE_PATH,
  WORKBUDDY_FETCH_TIMEOUT_MS,
  WORKBUDDY_PERSONAL_PATH,
  WORKBUDDY_PRODUCT_CODE,
  fetchWorkbuddyLimits,
  parseEnterpriseUsage,
  parsePersonalAccounts,
  parsePersonalUsage,
  workbuddyAccessToken,
  workbuddyAccountKey,
  workbuddyDepartmentInfo,
  workbuddyDomain,
  workbuddyEnterpriseId,
  workbuddyLocale,
  workbuddyUserId
};
