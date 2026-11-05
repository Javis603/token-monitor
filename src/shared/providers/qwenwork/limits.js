'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const { cleanSecret, errorWithStatus, numberOrNull, toIso } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');
const { refreshQwenworkSession } = require('./deviceFlow');

const QWENWORK_DEFAULT_BASE_URL = 'https://gateway.qwenwork.cn';
const QWENWORK_DEFAULT_AUTH_URL = 'https://gateway.qwenwork.cn';
const QWENWORK_QUOTA_PATH = '/api/v2/quota/usage';
const QWENWORK_ACCOUNT_PATH = '/api/v1/adapter/user/account-context?include=user,plan,quota';
const QWENWORK_FETCH_TIMEOUT_MS = 12_000;
const MAGPIE_TOKEN_SKEW_MS = 60_000;

function qwenworkTokenWithSource(env = process.env) {
  for (const name of ['TOKEN_MONITOR_QWENWORK_TOKEN', 'QWENWORK_TOKEN']) {
    const token = cleanSecret(env[name]);
    if (token) return { token, source: 'environment' };
  }
  const homes = [];
  const explicitHome = cleanSecret(env.MAGPIE_HOME);
  if (explicitHome) {
    homes.push(path.resolve(explicitHome));
  } else {
    homes.push(path.join(os.homedir(), '.config', 'magpie'));
    if (process.platform === 'win32' && cleanSecret(env.APPDATA)) homes.push(path.join(cleanSecret(env.APPDATA), 'magpie'));
  }
  for (const home of homes) {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(home, 'plugin-auth.json'), 'utf8'));
      const entry = auth?.qwenwork;
      const access = cleanSecret(entry?.access);
      if (!access) continue;
      const expires = Number(entry?.expires);
      if (Number.isFinite(expires) && expires > 0 && expires <= Date.now() + MAGPIE_TOKEN_SKEW_MS) continue;
      return { token: access, source: 'magpie' };
    } catch {
      // Missing or unreadable sign-in files are one of the supported absent
      // states, not a provider failure.
    }
  }
  return { token: '', source: '' };
}

function qwenworkToken(env = process.env) {
  return qwenworkTokenWithSource(env).token;
}

function discoverQwenworkSignIn(env = process.env) {
  const resolved = qwenworkTokenWithSource(env);
  return resolved.token ? { source: resolved.source } : null;
}

function normalizeQwenworkSession(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { return null; }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const access = cleanSecret(source.access);
  const refresh = cleanSecret(source.refresh);
  const expiresAt = Number(source.expiresAt);
  if (!access) return null;
  return {
    access,
    refresh,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    deviceToken: cleanSecret(source.deviceToken),
    deviceRefresh: cleanSecret(source.deviceRefresh),
    machineId: cleanSecret(source.machineId)
  };
}

function qwenworkAuthBaseUrl(env = process.env) {
  const raw = cleanSecret(env.TOKEN_MONITOR_QWENWORK_AUTH_URL) || cleanSecret(env.QWENWORK_AUTH_URL);
  if (!raw) return QWENWORK_DEFAULT_AUTH_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw errorWithStatus('unavailable', 'QWENWORK_AUTH_URL must be an https origin');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || (host !== 'qwenwork.cn' && !host.endsWith('.qwenwork.cn')
      && host !== 'qwenwork.ai' && !host.endsWith('.qwenwork.ai'))) {
    throw errorWithStatus('unavailable', 'QWENWORK_AUTH_URL must be an https origin on qwenwork.cn or qwenwork.ai');
  }
  return url.origin;
}

function qwenworkBaseUrl(env = process.env) {
  const raw = cleanSecret(env.TOKEN_MONITOR_QWENWORK_BASE_URL) || cleanSecret(env.QWENWORK_BASE_URL);
  if (!raw) return QWENWORK_DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw errorWithStatus('unavailable', 'QWENWORK_BASE_URL must be an https origin');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || (host !== 'qwenwork.cn' && !host.endsWith('.qwenwork.cn')
      && host !== 'qwenwork.ai' && !host.endsWith('.qwenwork.ai'))) {
    throw errorWithStatus('unavailable', 'QWENWORK_BASE_URL must be an https origin on qwenwork.cn or qwenwork.ai');
  }
  return url.origin;
}

function unwrap(body) {
  return body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;
}

function creditAllowance(raw, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw errorWithStatus('unavailable', `QwenWork returned an invalid ${name}`);
  }
  const total = numberOrNull(raw.total ?? raw.cap);
  const used = numberOrNull(raw.used);
  if (total === null || used === null || total <= 0 || used < 0 || used > total + 0.01) {
    throw errorWithStatus('unavailable', `QwenWork returned an inconsistent ${name}`);
  }
  const remaining = numberOrNull(raw.remaining);
  const explicitPercent = numberOrNull(raw.percentage);
  let usedPercent = explicitPercent === null ? (used / total) * 100 : explicitPercent;
  // The gateway reports 0.9893 for 98.93%. Multiply only when the value
  // matches the raw fraction; a genuine sub-1% percentage stays as reported.
  if (usedPercent >= 0 && usedPercent <= 1 && Math.abs(usedPercent - (used / total)) < 1e-6) {
    usedPercent *= 100;
  }
  return {
    total,
    used,
    remaining: remaining === null ? Math.max(0, total - used) : Math.max(0, Math.min(remaining, total)),
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    unit: typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim().slice(0, 32) : 'credits'
  };
}

function parseQwenworkQuota(body) {
  const payload = unwrap(body);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw errorWithStatus('unavailable', 'QwenWork returned an invalid quota response');
  }
  const primary = creditAllowance(payload.user_quota ?? payload.userQuota ?? payload.quota, 'user quota');
  const windows = [{
    kind: 'billing',
    label: 'Credits',
    used: primary.used,
    limit: primary.total,
    remaining: primary.remaining,
    usedPercent: primary.usedPercent,
    showMeter: true
  }];
  const pools = [
    ['add_on_quota', 'Add-on credits'],
    ['org_resource_package', 'Team credits'],
    ['shared_quota', 'Team credits']
  ];
  const seen = new Set();
  for (const [key, label] of pools) {
    if (seen.has(label)) continue;
    const raw = payload[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    let allowance;
    try {
      allowance = creditAllowance(raw, key);
    } catch {
      continue;
    }
    seen.add(label);
    windows.push({
      kind: 'billing',
      label,
      additional: true,
      used: allowance.used,
      limit: allowance.total,
      remaining: allowance.remaining,
      usedPercent: allowance.usedPercent,
      showMeter: true
    });
  }
  return {
    windows,
    exceeded: payload.is_quota_exceeded === true || payload.isQuotaExceeded === true
  };
}

function parseQwenworkAccount(body) {
  const payload = unwrap(body);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const user = payload.user && typeof payload.user === 'object' && !Array.isArray(payload.user) ? payload.user : null;
  const organization = user?.organization && typeof user.organization === 'object' && !Array.isArray(user.organization)
    ? user.organization : null;
  const plan = payload.plan && typeof payload.plan === 'object' && !Array.isArray(payload.plan) ? payload.plan : null;
  const reset = toIso(plan?.next_refresh_date ?? plan?.next_due_date);
  return {
    user: user ? {
      id: typeof user.id === 'string' ? user.id : '',
      name: typeof user.name === 'string' ? user.name : '',
      email: typeof user.email === 'string' ? user.email : '',
      organization: organization && typeof organization.name === 'string' ? organization.name : ''
    } : null,
    plan: plan ? {
      name: typeof plan.name === 'string' ? plan.name : '',
      resetsAt: reset
    } : null
  };
}

async function requestJson(fetchImpl, url, token, signal) {
  const response = await fetchImpl(url, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'error',
    signal,
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw errorWithStatus(response.status, `QwenWork request failed (HTTP ${response.status})`);
  return response.json();
}

async function fetchQwenworkLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const base = { provider: 'qwenwork', source: 'web', updatedAt };
  let baseUrl;
  try {
    baseUrl = qwenworkBaseUrl(env);
  } catch (error) {
    return normalizeLimitProvider({ ...base, status: error.status || 'unavailable', windows: [] });
  }

  let token = cleanSecret(options.qwenworkToken);
  let session = normalizeQwenworkSession(options.qwenworkSession);
  if (!token && session) {
    if (session.expiresAt > now + MAGPIE_TOKEN_SKEW_MS) {
      token = session.access;
    } else if (session.refresh) {
      try {
        const renewed = await refreshQwenworkSession(session, {
          apiBaseUrl: baseUrl,
          fetch: deps.fetch,
          signal: deps.signal,
          now: deps.now
        });
        try {
          await deps.onQwenworkSessionRenewed?.({ previousSession: session, session: renewed });
        } catch {
          // A rotation that cannot be persisted only costs one extra refresh
          // on the next poll; the quota itself is unaffected.
        }
        session = renewed;
        token = renewed.access;
      } catch (error) {
        const fallback = qwenworkTokenWithSource(env);
        if (!fallback.token) {
          return normalizeLimitProvider({
            ...base,
            status: error?.status === 'unauthorized' ? 'unauthorized' : 'unavailable',
            windows: []
          });
        }
        token = fallback.token;
      }
    } else {
      const fallback = qwenworkTokenWithSource(env);
      if (!fallback.token) return normalizeLimitProvider({ ...base, status: 'unauthorized', windows: [] });
      token = fallback.token;
    }
  }
  if (!token) {
    const resolved = qwenworkTokenWithSource(env);
    token = resolved.token;
  }
  if (!token) return normalizeLimitProvider({ ...base, status: 'notConfigured', windows: [] });

  const fetchImpl = deps.fetch || fetch;
  try {
    const result = await runWithProbeDeadline(async ({ signal }) => {
      let accountBody = null;
      let accountError = null;
      try {
        accountBody = await requestJson(fetchImpl, baseUrl + QWENWORK_ACCOUNT_PATH, token, signal);
      } catch (error) {
        if (error?.status === 401 || error?.status === 403) throw error;
        accountError = error;
      }
      let quotaBody = null;
      let quotaError = null;
      try {
        quotaBody = await requestJson(fetchImpl, baseUrl + QWENWORK_QUOTA_PATH, token, signal);
      } catch (error) {
        if (error?.status === 401 || error?.status === 403) throw error;
        quotaError = error;
      }
      if (!quotaBody && !accountBody) throw quotaError || accountError || errorWithStatus('unavailable', 'QwenWork returned no data');
      const account = parseQwenworkAccount(accountBody);
      const parsed = quotaBody ? parseQwenworkQuota(quotaBody)
        : parseQwenworkQuota({ quota: unwrap(accountBody)?.quota });
      return { parsed, account };
    }, { signal: deps.signal, deadlineMs: deps.qwenworkFetchTimeoutMs || QWENWORK_FETCH_TIMEOUT_MS });

    const user = result.account?.user || null;
    const plan = result.account?.plan || null;
    const identity = user?.id || user?.email || '';
    const windows = result.parsed.windows.map((window, index) => (
      index === 0 && plan?.resetsAt ? { ...window, resetsAt: plan.resetsAt } : window
    ));
    return normalizeLimitProvider({
      ...base,
      status: 'ok',
      accountKey: identity ? hashKey('qwenwork', identity) : '',
      accountName: user?.name || user?.organization || '',
      accountEmail: user?.email || '',
      planLabel: plan?.name || '',
      windows
    });
  } catch (error) {
    const status = error?.status === 401 || error?.status === 403 ? 'unauthorized'
      : error?.status === 429 ? 'sourceRateLimited'
        : 'unavailable';
    return normalizeLimitProvider({ ...base, status, windows: [] });
  }
}

module.exports = {
  MAGPIE_TOKEN_SKEW_MS,
  QWENWORK_ACCOUNT_PATH,
  QWENWORK_DEFAULT_AUTH_URL,
  QWENWORK_DEFAULT_BASE_URL,
  QWENWORK_FETCH_TIMEOUT_MS,
  QWENWORK_QUOTA_PATH,
  discoverQwenworkSignIn,
  fetchQwenworkLimits,
  normalizeQwenworkSession,
  parseQwenworkAccount,
  parseQwenworkQuota,
  qwenworkAuthBaseUrl,
  qwenworkBaseUrl,
  qwenworkToken,
  qwenworkTokenWithSource
};
