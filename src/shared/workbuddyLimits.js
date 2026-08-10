'use strict';

// WorkBuddy (腾讯) credits/usage limits provider.
//
// Credits balance comes from the same endpoint the WorkBuddy desktop app
// uses for its account credits panel:
//   POST https://copilot.tencent.com/v2/billing/meter/get-user-resource
// with Authorization: Bearer <accessToken> and X-User-Id: <uid>.
//
// Credentials are the personal-account session accessToken + uid, entered
// manually in Settings (same pattern as the Qoder cookie provider). They are
// stored locally and only used to query the credits balance.

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { runWithProbeDeadline } = require('./probeDeadline');
const { BROWSER_USER_AGENT } = require('./browserUserAgent');

const WORKBUDDY_FETCH_TIMEOUT_MS = 12_000;
const WORKBUDDY_API_ORIGIN = 'https://copilot.tencent.com';
const WORKBUDDY_RESOURCE_PATH = '/v2/billing/meter/get-user-resource';
const WORKBUDDY_PRODUCT_CODE = 'p_tcaca';

function cleanSecret(value) {
  let raw = value;
  if (typeof raw !== 'string') return '';
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function workbuddyAccessToken(env = process.env, options = {}) {
  const explicit = cleanSecret(options.workbuddyAccessToken);
  if (explicit) return explicit;
  for (const name of ['WORKBUDDY_ACCESS_TOKEN', 'TOKEN_MONITOR_WORKBUDDY_ACCESS_TOKEN']) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

function workbuddyUid(env = process.env, options = {}) {
  const explicit = cleanSecret(options.workbuddyUid);
  if (explicit) return explicit;
  for (const name of ['WORKBUDDY_UID', 'TOKEN_MONITOR_WORKBUDDY_UID']) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

function workbuddyResourceUrl() {
  return `${WORKBUDDY_API_ORIGIN}${WORKBUDDY_RESOURCE_PATH}`;
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
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

// Read a field under several naming variants. The WorkBuddy billing API uses
// PascalCase fields (CycleCapacityRemainPrecise), while other clients may emit
// camelCase or snake_case, so all three are tried.
function read(obj, camel, snake) {
  if (!obj || typeof obj !== 'object') return undefined;
  const pascal = camel.charAt(0).toUpperCase() + camel.slice(1);
  return obj[camel] ?? obj[snake] ?? obj[pascal];
}

// Friendly display names for the package codes the app reports.
const PACKAGE_NAME_HINTS = {
  proMon: 'Pro Monthly',
  proMonPlus: 'Pro+ Monthly',
  proYear: 'Pro Yearly',
  proTrialMon: 'Pro Trial',
  proTrialYear: 'Pro Trial Year',
  freeMon: 'Free Monthly',
  freeMonIntl: 'Free Monthly',
  youth: 'Student',
  advanced: 'Advanced',
  flagship: 'Flagship',
  bonus28: 'Bonus',
  bonus29: 'Bonus',
  bonus30: 'Bonus',
  bonusIntl: 'Bonus',
  activity: 'Activity',
  extra: 'Extra',
  extra38: 'Extra'
};

function packageLabel(pack) {
  const code = String(read(pack, 'packageCode', 'package_code') || '');
  const name = String(read(pack, 'packageName', 'package_name') || '').trim();
  if (name && !name.includes('package')) return name;
  return PACKAGE_NAME_HINTS[code] || code || 'Credits';
}

function parseWorkbuddyResource(body) {
  const payload = body?.data && typeof body.data === 'object' ? body.data : body;
  const accounts = payload?.Response?.Data?.Accounts || payload?.response?.data?.accounts || [];
  if (!Array.isArray(accounts)) throw new Error('missing Response.Data.Accounts');
  const windows = [];
  for (const pack of accounts) {
    if (!pack || typeof pack !== 'object') continue;
    const total = numberOrNull(read(pack, 'cycleCapacitySizePrecise', 'cycle_capacity_size_precise'));
    const remain = numberOrNull(read(pack, 'cycleCapacityRemainPrecise', 'cycle_capacity_remain_precise'));
    if (total === null || total <= 0) continue;
    const used = Math.max(0, total - Math.max(0, remain ?? total));
    const usedPercent = total > 0 ? (used / total) * 100 : 0;
    const refreshAt = toIso(read(pack, 'cycleEndTime', 'cycle_end_time'));
    windows.push({
      kind: 'billing',
      label: packageLabel(pack),
      used,
      limit: total,
      remaining: Math.max(0, remain ?? total - used),
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
      resetsAt: refreshAt,
      showMeter: true
    });
  }
  if (windows.length === 0) throw new Error('no usable credit packages');
  return windows;
}

function fetchJsonWithDeadline(url, init, deps = {}) {
  const deadlineMs = Number(deps.workbuddyFetchTimeoutMs || deps.fetchTimeoutMs || WORKBUDDY_FETCH_TIMEOUT_MS);
  return runWithProbeDeadline(
    async ({ signal }) => {
      const response = await (deps.fetch || fetch)(url, { ...init, signal });
      const body = response.ok ? await response.json() : null;
      return { response, body };
    },
    { signal: deps.signal, deadlineMs }
  );
}

async function fetchWorkbuddyLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const accessToken = workbuddyAccessToken(env, options);
  const uid = workbuddyUid(env, options);
  if (!accessToken || !uid) {
    return normalizeLimitProvider({
      provider: 'workbuddy',
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: []
    });
  }
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'X-User-Id': uid,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'User-Agent': BROWSER_USER_AGENT
  };
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: 100,
    ProductCode: WORKBUDDY_PRODUCT_CODE,
    Status: [0, 3],
    OnlyValidPeriod: true
  });
  try {
    const { response, body: jsonBody } = await fetchJsonWithDeadline(workbuddyResourceUrl(), {
      method: 'POST',
      headers,
      body
    }, deps);
    if (!response.ok) {
      const error = new Error(`WorkBuddy resource returned ${response.status}`);
      error.status = response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw error;
    }
    const windows = parseWorkbuddyResource(jsonBody);
    return normalizeLimitProvider({
      provider: 'workbuddy',
      accountKey: hashKey('workbuddy', `${accessToken}:${uid}`),
      accountLabel: '',
      source: 'api',
      status: 'ok',
      updatedAt,
      windows
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'workbuddy',
      source: 'api',
      status: error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable',
      updatedAt,
      windows: []
    });
  }
}

module.exports = {
  WORKBUDDY_FETCH_TIMEOUT_MS,
  WORKBUDDY_API_ORIGIN,
  workbuddyAccessToken,
  workbuddyUid,
  workbuddyResourceUrl,
  parseWorkbuddyResource,
  fetchWorkbuddyLimits
};
