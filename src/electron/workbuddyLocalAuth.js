'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readRegularFileNoFollow } = require('../shared/credentialStore');

const WORKBUDDY_AUTH_FILE_NAME = 'workbuddy-desktop.info';
const WORKBUDDY_LOGOUT_MARKER_SUFFIX = '.logged-out';
const WORKBUDDY_AUTH_FILE_MAX_BYTES = 1024 * 1024;
const WORKBUDDY_SESSION_EXPIRY_SKEW_MS = 30 * 1000;
const WORKBUDDY_API_HOSTS = new Set([
  'copilot.tencent.com'
]);
const WORKBUDDY_PROTECTED_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-refresh-token',
  'x-user-id',
  'x-enterprise-id',
  'x-tenant-id',
  'x-domain',
  'x-department-info',
  'x-no-authorization',
  'x-no-user-id',
  'x-no-enterprise-id',
  'x-no-department-info'
]);

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAllowedWorkbuddyApiUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && WORKBUDDY_API_HOSTS.has(url.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function sanitizeRequestInit(init = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(init.headers || {})) {
    if (WORKBUDDY_PROTECTED_HEADERS.has(String(key || '').toLowerCase())) continue;
    headers[key] = String(value);
  }
  const body = typeof init.body === 'string' ? init.body : undefined;
  return {
    method: String(init.method || 'GET').toUpperCase(),
    headers,
    ...(body === undefined ? {} : { body }),
    ...(init.signal ? { signal: init.signal } : {})
  };
}

function isSupportedWorkbuddyLocalAppPlatform(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

function authDirectoryForPlatform(platform = process.platform, homeDir = os.homedir(), env = process.env) {
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  if (platform === 'win32') {
    const appData = cleanText(env?.APPDATA) || path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  return null;
}

function appCandidatesForPlatform(platform = process.platform, homeDir = os.homedir()) {
  if (platform === 'darwin') {
    return [
      '/Applications/WorkBuddy.app',
      path.join(homeDir, 'Applications', 'WorkBuddy.app')
    ];
  }
  return [];
}

function authPathCandidates(authDirectory) {
  if (!authDirectory) return [];
  return [path.join(authDirectory, WORKBUDDY_AUTH_FILE_NAME)];
}

function authError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.code = status === 'unauthorized'
    ? 'WORKBUDDY_LOCAL_AUTH_REQUIRED'
    : 'WORKBUDDY_LOCAL_APP_UNAVAILABLE';
  return error;
}

function normalizeStoredSession(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  const auth = value.auth && typeof value.auth === 'object' ? value.auth : {};
  const account = value.account && typeof value.account === 'object' ? value.account : {};
  const accessToken = cleanText(auth.accessToken);
  const userId = cleanText(account.uid);
  if (!accessToken || !userId) return null;

  const expiresAt = numberOrNull(auth.expiresAt);
  const enterpriseId = cleanText(account.enterpriseId);
  const departmentInfo = cleanText(account.departmentFullName);
  return {
    accessToken,
    userId,
    enterpriseId,
    departmentInfo,
    domain: cleanText(auth.domain),
    accountType: cleanText(account.accountType || account.type) || 'personal',
    expiresAt,
    expired: expiresAt !== null && expiresAt <= now + WORKBUDDY_SESSION_EXPIRY_SKEW_MS
  };
}

function readSessionFile(filePath, fsApi = fs, now = Date.now()) {
  if (!filePath) return null;
  if (fsApi.existsSync(`${filePath}${WORKBUDDY_LOGOUT_MARKER_SUFFIX}`)) return null;
  try {
    const raw = readRegularFileNoFollow(filePath, {
      fs: fsApi,
      description: 'WorkBuddy app authentication file',
      encoding: 'utf8',
      maxBytes: WORKBUDDY_AUTH_FILE_MAX_BYTES
    });
    return normalizeStoredSession(JSON.parse(raw), now);
  } catch (_) {
    return null;
  }
}

function sessionInfo(session) {
  if (!session) {
    return {
      authenticated: false,
      userId: '',
      enterpriseId: '',
      departmentInfo: '',
      domain: '',
      accountType: ''
    };
  }
  return {
    authenticated: true,
    userId: session.userId,
    enterpriseId: session.enterpriseId,
    departmentInfo: session.departmentInfo,
    domain: session.domain,
    accountType: session.accountType
  };
}

function matchesExpectedSession(expected, session) {
  if (!expected || typeof expected !== 'object') return true;
  const actual = sessionInfo(session);
  if (expected.authenticated !== true || actual.authenticated !== true) return false;
  return ['userId', 'enterpriseId', 'departmentInfo', 'domain', 'accountType']
    .every((field) => cleanText(expected[field]) === cleanText(actual[field]));
}

function createWorkbuddyLocalAuth(deps = {}) {
  const fsApi = deps.fs || fs;
  const platform = deps.platform || process.platform;
  const homeDir = deps.homeDir || os.homedir();
  const env = deps.env || process.env;
  const supported = isSupportedWorkbuddyLocalAppPlatform(platform);
  const authDirectory = supported
    ? deps.authDirectory || authDirectoryForPlatform(platform, homeDir, env)
    : null;
  const fetcher = typeof deps.fetch === 'function'
    ? deps.fetch
    : typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : null;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const openPath = typeof deps.openPath === 'function' ? deps.openPath : null;
  const openExternal = typeof deps.openExternal === 'function' ? deps.openExternal : null;
  let lastCheckedAt = 0;

  function locateSession() {
    lastCheckedAt = now();
    if (!supported) return null;
    for (const filePath of authPathCandidates(authDirectory)) {
      const session = readSessionFile(filePath, fsApi, lastCheckedAt);
      if (session) return session;
    }
    return null;
  }

  function status() {
    if (!supported) {
      lastCheckedAt = now();
      return {
        appInstalled: false,
        authenticated: false,
        status: 'unsupported',
        checkedAt: lastCheckedAt
      };
    }
    const appInstalled = fsApi.existsSync(authDirectory)
      || appCandidatesForPlatform(platform, homeDir).some((candidate) => fsApi.existsSync(candidate));
    const session = locateSession();
    return {
      appInstalled,
      authenticated: Boolean(session && !session.expired),
      status: !appInstalled ? 'notDetected' : session && !session.expired ? 'connected' : 'signInRequired',
      checkedAt: lastCheckedAt
    };
  }

  function getSessionInfo() {
    return sessionInfo(locateSession());
  }

  async function request(url, init = {}, expectedSession = null) {
    if (!isAllowedWorkbuddyApiUrl(url)) throw authError('unavailable', 'WorkBuddy billing endpoint is not allowed');
    const session = locateSession();
    if (!session || session.expired) throw authError('unauthorized', 'WorkBuddy app sign-in is required');
    if (!matchesExpectedSession(expectedSession, session)) {
      throw authError('unauthorized', 'WorkBuddy app session changed during the billing request');
    }
    if (!fetcher) throw authError('unavailable', 'WorkBuddy billing transport is unavailable');

    const requestInit = sanitizeRequestInit(init);
    const headers = {
      ...requestInit.headers,
      Accept: requestInit.headers.Accept || 'application/json',
      'Content-Type': requestInit.headers['Content-Type'] || 'application/json',
      Authorization: `Bearer ${session.accessToken}`,
      'X-User-Id': session.userId
    };
    if (session.enterpriseId) {
      headers['X-Enterprise-Id'] = session.enterpriseId;
      headers['X-Tenant-Id'] = session.enterpriseId;
    }
    if (session.domain) headers['X-Domain'] = session.domain;
    if (session.departmentInfo) headers['X-Department-Info'] = session.departmentInfo;
    const response = await fetcher(url, { ...requestInit, headers });
    if (expectedSession) {
      const latestSession = locateSession();
      if (!latestSession || latestSession.expired || !matchesExpectedSession(expectedSession, latestSession)) {
        throw authError('unauthorized', 'WorkBuddy app session changed during the billing request');
      }
    }
    return response;
  }

  async function openApp() {
    if (!supported) throw new Error('WorkBuddy local app balance monitoring is not supported on this platform');
    const candidates = appCandidatesForPlatform(platform, homeDir);
    const appPath = candidates.find((candidate) => fsApi.existsSync(candidate));
    if (appPath && openPath) {
      const error = await openPath(appPath);
      if (error) throw new Error(String(error));
      return { ok: true };
    }
    if (openExternal) {
      await openExternal('workbuddy://');
      return { ok: true };
    }
    throw new Error('WorkBuddy app cannot be opened on this device');
  }

  return {
    getSessionInfo,
    openApp,
    request,
    status,
    dispose() {}
  };
}

module.exports = {
  WORKBUDDY_AUTH_FILE_NAME,
  WORKBUDDY_AUTH_FILE_MAX_BYTES,
  WORKBUDDY_LOGOUT_MARKER_SUFFIX,
  WORKBUDDY_SESSION_EXPIRY_SKEW_MS,
  appCandidatesForPlatform,
  authDirectoryForPlatform,
  createWorkbuddyLocalAuth,
  isAllowedWorkbuddyApiUrl,
  isSupportedWorkbuddyLocalAppPlatform,
  normalizeStoredSession,
  sanitizeRequestInit
};
