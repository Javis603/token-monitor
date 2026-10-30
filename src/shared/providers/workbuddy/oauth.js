'use strict';

const { hashKey } = require('../../hashKey');

const REALMS = Object.freeze({
  cn: Object.freeze({ origin: 'https://www.codebuddy.cn', platform: 'workbuddy',
    domains: Object.freeze(['www.codebuddy.cn', 'codebuddy.cn', 'www.workbuddy.cn', 'workbuddy.cn', 'copilot.tencent.com']) }),
  ai: Object.freeze({ origin: 'https://www.workbuddy.ai', platform: 'workbuddy-ai',
    domains: Object.freeze(['www.workbuddy.ai', 'workbuddy.ai']) })
});

function authError(code, status = 'unavailable') {
  const error = new Error(`WorkBuddy authentication: ${code}`);
  error.code = code;
  error.status = status;
  return error;
}

function isSuccessCode(code) {
  // The reference client accepts both envelopes. Anonymous official state
  // probes return 0; neither success value bypasses token/identity validation.
  return code === 0 || code === 200;
}

function realmConfig(realm) {
  if (!Object.hasOwn(REALMS, realm)) throw authError('INVALID_REALM');
  return REALMS[realm];
}

function text(value) {
  return typeof value === 'string' && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value)
    ? value.trim() : '';
}

function safeId(value) {
  const id = text(value);
  return id && !['__proto__', 'prototype', 'constructor'].includes(id) ? id : '';
}

function normalizeDomain(value, realm) {
  const config = realmConfig(realm);
  const domain = value === undefined || value === '' ? new URL(config.origin).hostname : text(value);
  if (!config.domains.includes(domain)) throw authError('INVALID_DOMAIN');
  return domain;
}

function workbuddyAccountKey(metadata) {
  const userId = text(metadata?.userId);
  if (!userId) return '';
  realmConfig(metadata?.realm);
  const enterpriseId = text(metadata?.enterpriseId);
  const identity = enterpriseId ? `enterprise:${enterpriseId}:${userId}` : `user:${userId}`;
  // CN subscription bindings predate managed login. Preserve their exact hash.
  return hashKey('workbuddy', metadata.realm === 'cn' ? identity : `ai:${identity}`);
}

function normalizeManagedAccounts(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set();
  const keys = new Set();
  return value.flatMap((entry) => {
    try {
      const id = safeId(entry?.id);
      const userId = text(entry?.userId);
      if (entry?.enterpriseId !== undefined && typeof entry.enterpriseId !== 'string') return [];
      const realm = entry?.realm;
      const domain = normalizeDomain(entry?.domain, realm);
      const accountKey = workbuddyAccountKey(entry);
      if (!id || !userId || ids.has(id) || keys.has(accountKey)) return [];
      ids.add(id);
      keys.add(accountKey);
      return [{ id, realm, userId, enterpriseId: text(entry.enterpriseId),
        departmentInfo: text(entry.departmentInfo), domain, accountKey,
        accountName: text(entry.accountName), accountEmail: text(entry.accountEmail),
        enabled: entry.enabled !== false, addedAt: text(entry.addedAt), updatedAt: text(entry.updatedAt) }];
    } catch (_) { return []; }
  });
}

function expiry(value, absolute, relative, now, fallback = null) {
  if (Object.hasOwn(value, absolute) && value[absolute] !== null) {
    const number = value[absolute];
    if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) throw authError('INVALID_TOKEN');
    return number;
  }
  if (Object.hasOwn(value, relative)) {
    const seconds = value[relative];
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0
      || !Number.isSafeInteger(Math.ceil(now + seconds * 1000))) throw authError('INVALID_TOKEN');
    return now + seconds * 1000;
  }
  return fallback;
}

function normalizeCredential(value, { realm, now = Date.now(), previous = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw authError('INVALID_TOKEN');
  const secret = (token) => typeof token === 'string' && token.length <= 65536
    && !/[\x00-\x20\x7f]/.test(token) ? token : '';
  const accessToken = secret(value.accessToken);
  const refreshToken = value.refreshToken === undefined ? secret(previous?.refreshToken) : secret(value.refreshToken);
  const domain = normalizeDomain(value.domain === undefined ? previous?.domain : value.domain, realm);
  if (!accessToken || !refreshToken) throw authError('INVALID_TOKEN');
  if (previous && domain !== previous.domain) throw authError('CONTEXT_CHANGED');
  return { accessToken, refreshToken, domain,
    expiresAt: expiry(value, 'expiresAt', 'expiresIn', now),
    refreshExpiresAt: expiry(value, 'refreshExpiresAt', 'refreshExpiresIn', now, previous?.refreshExpiresAt ?? null) };
}

function verifyIdentity(value, credential, realm) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.enterpriseId !== undefined && typeof value.enterpriseId !== 'string')) throw authError('INVALID_IDENTITY');
  const userId = text(value?.uid);
  const enterpriseId = text(value?.enterpriseId);
  const type = text(value?.type || value?.accountType).toLowerCase();
  if (!userId || (type && !['personal', 'enterprise', 'ultimate', 'exclusive'].includes(type))
    || (type === 'personal' && enterpriseId) || (['enterprise', 'ultimate', 'exclusive'].includes(type) && !enterpriseId)) {
    throw authError('INVALID_IDENTITY');
  }
  if (value.domain !== undefined && normalizeDomain(value.domain, realm) !== credential.domain) {
    throw authError('CONTEXT_CHANGED');
  }
  const departmentInfo = text(value.departmentFullName || value.departmentInfo);
  for (const [field, actual] of [['uid', userId], ['userId', userId], ['enterpriseId', enterpriseId],
    ['departmentInfo', departmentInfo], ['departmentFullName', departmentInfo]]) {
    if (credential[field] !== undefined && text(credential[field]) !== actual) throw authError('CONTEXT_CHANGED');
  }
  const identity = { realm, userId, enterpriseId,
    departmentInfo, domain: credential.domain,
    accountName: text(value.name || value.nickname || value.accountName),
    accountEmail: text(value.email || value.accountEmail) };
  return { ...identity, accountKey: workbuddyAccountKey(identity) };
}

// Also races transports/body readers which ignore AbortSignal. Raw transport
// errors and abort reasons never cross this boundary.
async function boundedOperation(operation, { signal, timeoutMs = 15_000 } = {}) {
  if (signal?.aborted) throw authError('CANCELED');
  const controller = new AbortController();
  let timer;
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(authError('CANCELED')); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(authError('TIMEOUT')); }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw authError('CANCELED');
      return operation(controller.signal);
    }), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function authRequest(realm, path, { fetch, signal, timeoutMs, method = 'GET', headers = {} } = {}) {
  const config = realmConfig(realm);
  if (typeof fetch !== 'function') throw authError('TRANSPORT_UNAVAILABLE');
  if (!/^\/v2\/plugin\/(?:auth\/state\?platform=(?:workbuddy|workbuddy-ai)|auth\/token\?state=[^&#]+|login\/account\?state=[^&#]+|auth\/token\/refresh)$/.test(path)) {
    throw authError('INVALID_ENDPOINT');
  }
  try {
    return await boundedOperation(async (requestSignal) => {
      const response = await fetch(`${config.origin}${path}`, {
        method, headers: { Accept: 'application/json', ...headers },
        ...(method === 'POST' ? { body: '{}', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers } } : {}),
        credentials: 'omit', redirect: 'error', signal: requestSignal
      });
      const status = response?.status;
      if (!Number.isInteger(status)) throw authError('INVALID_RESPONSE');
      // HTTP classification wins over untrusted error descriptions.
      if (status === 401 || status === 403) throw authError('AUTH_REQUIRED', 'unauthorized');
      if (status === 429) throw authError('RATE_LIMITED', 'sourceRateLimited');
      if (status >= 500) throw authError('NETWORK_UNAVAILABLE');
      const payload = await response.json();
      if (payload?.code === 12153 || payload?.error === 'invalid_grant' || payload?.data?.error === 'invalid_grant') {
        throw authError('AUTH_REQUIRED', 'unauthorized');
      }
      if (status < 200 || status >= 300 || !payload || typeof payload !== 'object') throw authError('INVALID_RESPONSE');
      return payload;
    }, { signal, timeoutMs });
  } catch (error) {
    if (error?.message === `WorkBuddy authentication: ${error?.code}`
      && ['CANCELED', 'TIMEOUT', 'AUTH_REQUIRED', 'RATE_LIMITED', 'NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code)) throw error;
    throw authError('NETWORK_UNAVAILABLE');
  }
}

async function refreshCredential(credential, account, deps = {}) {
  const current = normalizeCredential(credential, { realm: account.realm, now: (deps.now || Date.now)() });
  if (current.domain !== account.domain) throw authError('CONTEXT_CHANGED');
  const now = (deps.now || Date.now)();
  if (current.refreshExpiresAt !== null && current.refreshExpiresAt <= now) throw authError('AUTH_REQUIRED', 'unauthorized');
  const payload = await authRequest(account.realm, '/v2/plugin/auth/token/refresh', {
    ...deps, method: 'POST', headers: {
      Authorization: `Bearer ${current.accessToken}`, 'X-Refresh-Token': current.refreshToken,
      'X-Auth-Refresh-Source': 'plugin', 'X-Domain': current.domain,
      'X-User-Id': account.userId,
      ...(account.enterpriseId ? { 'X-Enterprise-Id': account.enterpriseId, 'X-Tenant-Id': account.enterpriseId } : {}),
      // Department is descriptive metadata, not the user/enterprise identity.
      // The official refresh endpoint needs no department header. Unicode names
      // cannot be a Fetch ByteString; keep them bound in metadata, not the wire.
    }
  });
  if (!isSuccessCode(payload.code)) throw authError('REFRESH_FAILED');
  const updated = normalizeCredential(payload.data, { realm: account.realm, now: (deps.now || Date.now)(), previous: current });
  for (const [field, expected] of [['uid', account.userId], ['userId', account.userId],
    ['enterpriseId', account.enterpriseId], ['departmentInfo', account.departmentInfo], ['departmentFullName', account.departmentInfo]]) {
    if (payload.data[field] !== undefined && text(payload.data[field]) !== expected) throw authError('CONTEXT_CHANGED');
  }
  if (payload.data.account !== undefined) {
    const identity = verifyIdentity(payload.data.account, updated, account.realm);
    if (identity.accountKey !== workbuddyAccountKey(account) || identity.departmentInfo !== account.departmentInfo) {
      throw authError('CONTEXT_CHANGED');
    }
  }
  return updated;
}

module.exports = { normalizeManagedAccounts, workbuddyAccountKey, realmConfig, normalizeCredential,
  normalizeDomain, verifyIdentity, authError, authRequest, boundedOperation, refreshCredential, isSuccessCode };
