'use strict';

const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const { cleanSecret, numberOrNull } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');

const WORKBUDDY_FETCH_TIMEOUT_MS = 12_000;
const WORKBUDDY_ACCOUNT_CONCURRENCY = 4;
// Match the limits collector's physical bound; its cleanup grace is not work time.
const WORKBUDDY_PROBE_BUDGET_MS = 120_000;
const WORKBUDDY_DEFAULT_ENDPOINT = 'https://copilot.tencent.com';
const WORKBUDDY_AI_ENDPOINT = 'https://www.workbuddy.ai';
const WORKBUDDY_PERSONAL_PATH = '/v2/billing/meter/get-user-resource';
const WORKBUDDY_ENTERPRISE_PATH = '/v2/billing/meter/get-enterprise-user-usage';
const WORKBUDDY_PRODUCT_CODE = 'p_tcaca';
const WORKBUDDY_PERSONAL_RANGE_MS = 101 * 365 * 24 * 60 * 60 * 1000;
// The Electron reader reports why the app-owned session is unusable. Only the
// encrypted case changes the limits outcome — signing in again cannot fix a
// credential the app sealed with a key Token Monitor does not hold — so it is
// the one reason both layers have to agree on.
const WORKBUDDY_SESSION_REASON_ENCRYPTED = 'encrypted';
const WORKBUDDY_SESSION_ENCRYPTED_ACTION = 'appSessionEncrypted';

// WorkBuddy is the only provider reading a credential this way: Trae needs the
// same precedence but its own stricter cleaner, so this stays local rather than
// becoming a shared helper with one caller.
function firstSetting(options, env, settingName, envNames) {
  const explicit = cleanSecret(options?.[settingName]);
  if (explicit) return explicit;
  for (const name of envNames) {
    const value = cleanSecret(env?.[name]);
    if (value) return value;
  }
  return '';
}

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

function formatWorkbuddyDateTime(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  ].join(' ');
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
    ['data', 'Accounts'],
    ['data', 'data', 'Accounts'],
    ['Accounts'],
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
    // The official client requests Status 3 packages for its wider UI, but
    // those historical rows are not part of the currently spendable balance.
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
  error.httpStatus = status;
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
  error.applicationCode = code;
  error.status = code === 401 || code === 403
    ? 'unauthorized'
    : code === 429
      ? 'sourceRateLimited'
      : code >= 500 || code === 408
        ? 'unavailable'
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
  // Optional descriptive header: preserve ASCII compatibility without inventing
  // an encoding the official API does not declare. Identity uses uid/enterprise.
  if (departmentInfo && /^[\x20-\x7e]+$/.test(departmentInfo)) headers['X-Department-Info'] = departmentInfo;
  if (locale) headers['Accept-Language'] = locale;
  return headers;
}

function workbuddyStatus(error) {
  if (['notConfigured', 'unauthorized', 'sourceRateLimited', 'unavailable', 'error'].includes(error?.status)) return error.status;
  if (error?.status === 'timeout' || error?.name === 'AbortError') return 'unavailable';
  return 'unavailable';
}

// Accept metadata for the managed/OAuth lane, while preserving the legacy
// positional API and every existing CN identity hash.
function workbuddyAccountKey(token, userId, enterpriseId, identity = '', realm = 'cn') {
  if (token && typeof token === 'object') {
    const account = token;
    return workbuddyAccountKey('', cleanSecret(account.userId), cleanSecret(account.enterpriseId), '', account.realm);
  }
  const prefix = realm === 'ai' ? 'ai:' : '';
  if (enterpriseId && userId) return hashKey('workbuddy', `${prefix}enterprise:${enterpriseId}:${userId}`);
  if (userId) return hashKey('workbuddy', `${prefix}user:${userId}`);
  if (identity) return hashKey('workbuddy', `${prefix}account:${identity}`);
  return hashKey('workbuddy', `${prefix}${token ? `token:${token}` : 'local-app'}`);
}

function workbuddyBillingPaths(realm, enterprise = false) {
  const path = enterprise ? WORKBUDDY_ENTERPRISE_PATH : WORKBUDDY_PERSONAL_PATH;
  return realm === 'ai' ? [path.slice(3), path] : [path];
}

// Domains are header metadata only. A contradictory realm is refused before
// dispatch, and no domain ever selects an arbitrary billing host.
function workbuddyDomainMatchesRealm(domain, realm) {
  const value = cleanSecret(domain).toLowerCase();
  if (!value) return true;
  const ai = value === 'www.workbuddy.ai' || value === 'workbuddy.ai';
  const international = ai || value.endsWith('.workbuddy.ai')
    || value === 'codebuddy.ai' || value.endsWith('.codebuddy.ai');
  return realm === 'ai' ? ai : realm === 'cn' && !international;
}

function workbuddyRowKey(account) {
  return cleanSecret(account.userId)
    ? workbuddyAccountKey(account)
    : cleanSecret(account.accountKey) || hashKey('workbuddy', `${account.realm || 'cn'}:managed:${account.id}`);
}

async function fetchWorkbuddyAccount(options, deps, account = null, managed = false) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const explicitToken = managed ? '' : workbuddyAccessToken(env, options);
  const userId = account ? cleanSecret(account.userId) : workbuddyUserId(env, options);
  const enterpriseId = account ? cleanSecret(account.enterpriseId) : workbuddyEnterpriseId(env, options);
  const domain = account ? cleanSecret(account.domain) : workbuddyDomain(env, options);
  const departmentInfo = account ? cleanSecret(account.departmentInfo) : workbuddyDepartmentInfo(env, options);
  const accountType = cleanSecret(account?.accountType || options.workbuddyAccountType);
  const realm = account?.realm || options.workbuddyRealm || 'cn';
  const sessionReason = cleanSecret(account?.reason || options.workbuddyLocalSessionReason);
  const localAppUnsupported = !managed && !explicitToken && options.workbuddyDesktopSessionSupported === false;
  const useLocalApp = !managed && !localAppUnsupported && !explicitToken
    && options.workbuddyDesktopSessionEnabled === true && typeof deps.workbuddyFetch === 'function';
  const accountKey = managed ? workbuddyRowKey(account)
    : workbuddyAccountKey(explicitToken, userId, enterpriseId, '', realm);
  const source = {
    provider: 'workbuddy',
    region: realm,
    source: useLocalApp || localAppUnsupported ? 'local' : 'api',
    sourceDetail: managed ? 'managed' : useLocalApp || localAppUnsupported ? 'app' : 'unknown',
    accountKey,
    accountName: account?.accountName || '',
    accountEmail: managed ? account?.accountEmail || '' : '',
    accountLabel: enterpriseId ? 'Enterprise' : 'Personal',
    updatedAt,
    windows: []
  };
  const row = (status, extra = {}) => normalizeLimitProvider({ ...source, status, ...extra });
  if (deps.signal?.aborted) return row('unavailable');
  if (localAppUnsupported) return row('unavailable');
  if (!managed && !explicitToken && options.workbuddyDesktopSessionEnabled === true
    && sessionReason === WORKBUDDY_SESSION_REASON_ENCRYPTED) {
    return row('notConfigured', { actionRequired: WORKBUDDY_SESSION_ENCRYPTED_ACTION });
  }
  if (!managed && !explicitToken && !useLocalApp) return row('notConfigured');
  const expectedSession = useLocalApp ? {
    authenticated: true, userId, enterpriseId, departmentInfo, domain, accountType, realm,
    ...(account?.accountKey ? { accountKey: account.accountKey } : {})
  } : null;
  const deadlineMs = Number(deps.workbuddyFetchTimeoutMs || deps.fetchTimeoutMs || WORKBUDDY_FETCH_TIMEOUT_MS);
  try {
    return await runWithProbeDeadline(async ({ signal }) => {
      const requestDeps = { ...deps, signal,
        ...(useLocalApp ? { fetch: (url, init) => deps.workbuddyFetch(url, init, expectedSession) } : {}) };
      if (!['cn', 'ai'].includes(realm) || !workbuddyDomainMatchesRealm(domain, realm)) {
        throw Object.assign(new Error('WorkBuddy credential realm mismatch'), { status: 'unavailable' });
      }
      const resolveCredential = async (forceRefresh) => {
        if (typeof deps.resolveWorkbuddyManagedCredential !== 'function') {
          throw Object.assign(new Error('WorkBuddy managed credential is missing'), { status: 'notConfigured' });
        }
        return runWithProbeDeadline(({ signal }) => deps.resolveWorkbuddyManagedCredential(account, { signal, forceRefresh }),
          { signal, deadlineMs });
      };
      let credential = managed ? await resolveCredential(false) : { accessToken: explicitToken, domain };
      const requestQuota = async () => {
        const token = cleanSecret(credential?.accessToken);
        const credentialDomain = cleanSecret(credential?.domain) || domain;
        if (managed && !token) throw Object.assign(new Error('WorkBuddy managed credential is missing'), { status: 'notConfigured' });
        if (!workbuddyDomainMatchesRealm(credentialDomain, realm)) {
          throw Object.assign(new Error('WorkBuddy credential realm mismatch'), { status: 'unavailable' });
        }
        const headers = useLocalApp ? requestHeaders('', '', '', '', '', '')
          : requestHeaders(token, userId, enterpriseId, workbuddyLocale(env, options), credentialDomain, departmentInfo);
        const init = {
          method: 'POST', redirect: 'error', credentials: 'omit', headers,
          body: enterpriseId ? '{}' : JSON.stringify({
            PageNumber: 1, PageSize: 100, ProductCode: WORKBUDDY_PRODUCT_CODE, Status: [0, 3],
            PackageEndTimeRangeBegin: formatWorkbuddyDateTime(now),
            PackageEndTimeRangeEnd: formatWorkbuddyDateTime(now + WORKBUDDY_PERSONAL_RANGE_MS)
          })
        };
        const endpoint = realm === 'ai' ? WORKBUDDY_AI_ENDPOINT : WORKBUDDY_DEFAULT_ENDPOINT;
        const paths = workbuddyBillingPaths(realm, Boolean(enterpriseId));
        for (let index = 0; index < paths.length; index += 1) {
          try { return await fetchJson(`${endpoint}${paths[index]}`, init, requestDeps); }
          catch (error) {
            if (error.httpStatus !== 404 || index === paths.length - 1) throw error;
          }
        }
      };
      let body;
      try { body = await requestQuota(); }
      catch (error) {
        // The resolver owns serialization and durable rotation. Await its
        // completion before retrying billing, and renew at most once per row.
        const expiredToken = error.httpStatus === 401 || error.applicationCode === 401;
        if (!managed || !expiredToken) throw error;
        credential = await resolveCredential(true);
        body = await requestQuota();
      }
      const usage = enterpriseId ? parseEnterpriseUsage(body) : parsePersonalUsage(body);
      return row('ok', {
        accountKey: managed || userId ? accountKey : workbuddyAccountKey(explicitToken, userId, enterpriseId, usage.accountId, realm),
        windows: usage.window ? [usage.window] : [],
        ...(usage.window ? { balance: { amount: usage.remaining, currency: 'CREDITS' } } : {})
      });
    }, { signal: deps.signal, deadlineMs: deps.workbuddyAccountTimeoutMs || WORKBUDDY_PROBE_BUDGET_MS });
  } catch (error) { return row(workbuddyStatus(error)); }
}

async function runWorkbuddyAccounts(jobs, deps) {
  const configured = Number(deps.providerPhysicalBounds?.workbuddy);
  const budgetMs = Number.isFinite(configured) && configured > 0 ? configured : WORKBUDDY_PROBE_BUDGET_MS;
  const startedAt = performance.now();
  const controller = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;
  const concurrency = Math.min(WORKBUDDY_ACCOUNT_CONCURRENCY, jobs.length);
  const rows = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      const remainingMs = budgetMs - (performance.now() - startedAt);
      if (remainingMs <= 0) controller.abort();
      // Bound the entire resolve/refresh/billing sequence, reserving time for
      // later waves. Quick accounts leave their unused time for queued ones.
      const waves = Math.ceil((jobs.length - index) / concurrency);
      rows[index] = await jobs[index]({ ...deps, signal,
        workbuddyAccountTimeoutMs: Math.max(1, Math.floor(remainingMs / waves)) });
      // With an aborted signal, remaining jobs produce identity-only unavailable
      // rows without resolving credentials or dispatching requests.
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return rows;
}

// Removal uses only the runtime's accepted snapshot. Probe-local caches can
// consume a deletion in a superseded request before it is ever committed.
function appendWorkbuddyRemovals(rows, options, deps, accountScoped) {
  if (accountScoped || deps.signal?.aborted) return rows;
  const represented = new Set(rows.map((row) => row.accountKey));
  const rawManaged = options.workbuddyManagedAccounts;
  const managedComplete = Array.isArray(rawManaged) && rawManaged.every((account) =>
    account && cleanSecret(account.id) && cleanSecret(account.userId) && ['cn', 'ai'].includes(account.realm));
  const sessions = options.workbuddyLocalSessions;
  const localComplete = (realm) => {
    if (options.workbuddyDesktopSessionEnabled !== true || options.workbuddyLocalSessionsComplete === false) return false;
    if (Array.isArray(sessions)) {
      return sessions.filter((session) => (session?.realm || 'cn') === realm).every((session) =>
        session && session.discoveryComplete !== false
        && (session.authenticated === true || session.reason === 'absent'
          || (cleanSecret(session.userId) && ['expired', 'encrypted'].includes(session.reason))));
    }
    return (options.workbuddyRealm || 'cn') === realm
      && (options.workbuddyLocalSessionReason === 'absent'
        || (cleanSecret(options.workbuddyUserId) && !options.workbuddyLocalSessionReason));
  };
  const disabled = new Set((Array.isArray(rawManaged) ? rawManaged : [])
    .filter((account) => account?.enabled === false && cleanSecret(account.userId)).map(workbuddyRowKey));
  const removals = (options.previousLimits?.providers || []).filter((previous) => {
    if (previous?.provider !== 'workbuddy' || !previous.accountKey || represented.has(previous.accountKey)) return false;
    if (disabled.has(previous.accountKey)) return true;
    if (previous.sourceDetail === 'managed') return managedComplete;
    if (previous.sourceDetail === 'app') return localComplete(previous.region || 'cn');
    // An explicit headless token lane has a complete credential snapshot.
    return previous.sourceDetail === 'unknown' && !options.workbuddyDesktopSessionEnabled;
  }).map((previous) => ({ provider: 'workbuddy', accountKey: previous.accountKey, removed: true }));
  return [...rows, ...removals];
}

async function fetchWorkbuddyLimits(options = {}, deps = {}) {
  const managed = Array.isArray(options.workbuddyManagedAccounts)
    ? options.workbuddyManagedAccounts.filter((account) => account && typeof account === 'object' && cleanSecret(account.id)) : [];
  const token = workbuddyAccessToken(deps.env || process.env, options);
  const locals = !token && options.workbuddyDesktopSessionEnabled === true && Array.isArray(options.workbuddyLocalSessions)
    ? options.workbuddyLocalSessions.filter((account) => account && typeof account === 'object'
      && (cleanSecret(account.userId) || !managed.length
        || !['absent', 'unsupported'].includes(account.reason))) : [];
  const scope = options.limitRefreshScope?.provider === 'workbuddy' ? options.limitRefreshScope : null;
  const targeted = scope && (scope.accountId || scope.accountKey);
  const namesOnly = scope && ['accountName', 'accountEmail', 'accountLabel', 'name', 'email', 'managedAccountId', 'id'].some((field) => scope[field]);
  const matches = (account, key) => !scope || (!targeted && !namesOnly) || (
    (cleanSecret(scope.accountId) || cleanSecret(scope.accountKey))
    && (!scope.accountId || cleanSecret(scope.accountId) === cleanSecret(account?.id))
    && (!scope.accountKey || cleanSecret(scope.accountKey) === key)
  );
  // Disabled managed identities still suppress the equivalent local source.
  // Only verified user/enterprise identity can deduplicate a local session.
  const managedIdentities = new Set(managed.filter((account) => cleanSecret(account.userId)).map(workbuddyRowKey));
  const jobs = [];
  const seen = new Set();
  for (const account of managed) {
    const key = workbuddyRowKey(account);
    if (seen.has(key)) continue;
    seen.add(key);
    if (account.enabled !== false && matches(account, key)) jobs.push((jobDeps) => fetchWorkbuddyAccount(options, jobDeps, account, true));
  }
  for (const account of locals) {
    const key = workbuddyAccountKey(account);
    if ((cleanSecret(account.userId) && managedIdentities.has(key)) || seen.has(key)) continue;
    seen.add(key);
    if (matches(account, key)) jobs.push((jobDeps) => fetchWorkbuddyAccount(options, jobDeps, account));
  }
  if (!locals.length) {
    const identity = {
      realm: options.workbuddyRealm || 'cn',
      userId: workbuddyUserId(deps.env || process.env, options),
      enterpriseId: workbuddyEnterpriseId(deps.env || process.env, options)
    };
    const key = workbuddyAccountKey(token, identity.userId, identity.enterpriseId, '', identity.realm);
    const legacyLocal = options.workbuddyDesktopSessionEnabled === true;
    if ((!managed.length || token || (legacyLocal && identity.userId))
      && !managedIdentities.has(key) && matches(null, key)) {
      jobs.push((jobDeps) => fetchWorkbuddyAccount(options, jobDeps));
    }
  }
  const currentRows = await runWorkbuddyAccounts(jobs, deps);
  const rows = appendWorkbuddyRemovals(currentRows, options, deps, targeted || namesOnly);
  // Keep the legacy single-object return when there is no managed account
  // configuration and at most one local discovery row.
  return !managed.length && !scope && rows.length === 1 ? rows[0] : rows;
}

module.exports = {
  WORKBUDDY_DEFAULT_ENDPOINT,
  WORKBUDDY_AI_ENDPOINT,
  WORKBUDDY_ENTERPRISE_PATH,
  WORKBUDDY_FETCH_TIMEOUT_MS,
  WORKBUDDY_PERSONAL_PATH,
  WORKBUDDY_PRODUCT_CODE,
  WORKBUDDY_SESSION_ENCRYPTED_ACTION,
  WORKBUDDY_SESSION_REASON_ENCRYPTED,
  fetchWorkbuddyLimits,
  parseEnterpriseUsage,
  parsePersonalAccounts,
  parsePersonalUsage,
  workbuddyAccessToken,
  workbuddyAccountKey,
  workbuddyBillingPaths,
  workbuddyDomainMatchesRealm,
  workbuddyDepartmentInfo,
  workbuddyDomain,
  workbuddyEnterpriseId,
  workbuddyLocale,
  workbuddyUserId
};
