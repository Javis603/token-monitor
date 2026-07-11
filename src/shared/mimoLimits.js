'use strict';

// Xiaomi MiMo Token Plan balance & quota lookup.
//
// MiMo uses cookie-based authentication (not API key):
//   - Cookie: api-platform_serviceToken=<token>; userId=<uid>
//   - Optional: api-platform_ph, api-platform_slh
//
// Balance endpoint: https://platform.xiaomimimo.com/api/v1/balance
// Token Plan detail: https://platform.xiaomimimo.com/api/v1/token-plan/detail
// Token Plan usage:  https://platform.xiaomimimo.com/api/v1/token-plan/usage

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');

const MIMO_BALANCE_URL = 'https://platform.xiaomimimo.com/api/v1/balance';
const MIMO_TOKEN_PLAN_DETAIL_URL = 'https://platform.xiaomimimo.com/api/v1/token-plan/detail';
const MIMO_TOKEN_PLAN_USAGE_URL = 'https://platform.xiaomimimo.com/api/v1/token-plan/usage';
const MIMO_LOGIN_URL = 'https://platform.xiaomimimo.com/#/console/balance';

const MIMO_WINDOW_MINUTES_5H = 5 * 60;
const MIMO_WINDOW_MINUTES_WEEKLY = 7 * 24 * 60;

function cleanSecret(value) {
  let raw = value;
  if (typeof raw !== 'string') return '';
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function mimoCookie(env = process.env, explicitCookie = '') {
  const explicit = cleanSecret(explicitCookie);
  if (explicit) return explicit;
  for (const name of ['MIMO_COOKIE', 'XIAOMI_MIMO_COOKIE']) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

function parseNumberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function millisToIso8601(value) {
  const ms = parseNumberOrNull(value);
  if (ms === null) return null;
  const normalized = ms < 1_000_000_000_000 ? ms * 1000 : ms;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Parse cookie header string into key-value pairs
function parseCookies(cookieStr) {
  const cookies = {};
  if (!cookieStr || typeof cookieStr !== 'string') return cookies;
  for (const part of cookieStr.split(';')) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key) cookies[key] = value;
    }
  }
  return cookies;
}

// Validate that required cookies are present
function validateMimoCookies(cookieStr) {
  const cookies = parseCookies(cookieStr);
  return Boolean(cookies['api-platform_serviceToken'] && cookies['userId']);
}

async function fetchJson(url, cookies, deps = {}) {
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await (deps.fetch || fetch)(url, {
      headers: {
        Cookie: cookies,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) {
      const status = (response.status === 401 || response.status === 403) ? 'unauthorized' : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      const error = new Error(`${url} returned ${response.status}`);
      error.status = status;
      error.statusCode = response.status;
      throw error;
    }
    return response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Parse balance response
function parseBalance(body) {
  if (!body || typeof body !== 'object') return null;
  // Try nested data shape first
  const data = body.data || body;
  if (typeof data !== 'object') return null;

  const result = {
    balance: parseNumberOrNull(data.balance) || parseNumberOrNull(data.totalBalance) || 0,
    currency: data.currency || 'CNY',
    todaySpend: parseNumberOrNull(data.todaySpend) || 0,
    monthSpend: parseNumberOrNull(data.monthSpend) || 0
  };

  return result.balance > 0 || result.todaySpend > 0 ? result : null;
}

// Parse token plan detail response
function parseTokenPlanDetail(body) {
  if (!body || typeof body !== 'object') return null;
  const data = body.data || body;
  if (typeof data !== 'object') return null;

  const windows = [];

  // 5-hour window
  const intervalRemaining = parseNumberOrNull(data.intervalRemainingPercent ?? data.interval_remaining_percent);
  if (intervalRemaining !== null) {
    const used = Math.max(0, Math.min(100, 100 - intervalRemaining));
    windows.push({
      kind: 'session',
      label: '5h',
      usedPercent: used,
      remainingPercent: Math.max(0, Math.min(100, intervalRemaining)),
      resetsAt: millisToIso8601(data.intervalEndTime ?? data.interval_end_time),
      windowMinutes: MIMO_WINDOW_MINUTES_5H,
      showMeter: true
    });
  }

  // Weekly window
  const weeklyRemaining = parseNumberOrNull(data.weeklyRemainingPercent ?? data.weekly_remaining_percent);
  if (weeklyRemaining !== null) {
    const used = Math.max(0, Math.min(100, 100 - weeklyRemaining));
    windows.push({
      kind: 'weekly',
      label: 'Weekly',
      usedPercent: used,
      remainingPercent: Math.max(0, Math.min(100, weeklyRemaining)),
      resetsAt: millisToIso8601(data.weeklyEndTime ?? data.weekly_end_time),
      windowMinutes: MIMO_WINDOW_MINUTES_WEEKLY,
      showMeter: true
    });
  }

  return windows;
}

async function fetchMimoLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const cookie = mimoCookie(env, options.mimoCookie);

  if (!cookie) {
    return normalizeLimitProvider({
      provider: 'mimo',
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: []
    });
  }

  if (!validateMimoCookies(cookie)) {
    return normalizeLimitProvider({
      provider: 'mimo',
      source: 'api',
      status: 'unauthorized',
      updatedAt,
      windows: []
    });
  }

  try {
    // Fetch balance and token plan in parallel
    const [balanceData, tokenPlanData] = await Promise.allSettled([
      fetchJson(MIMO_BALANCE_URL, cookie, deps),
      fetchJson(MIMO_TOKEN_PLAN_DETAIL_URL, cookie, deps)
    ]);

    const balance = balanceData.status === 'fulfilled' ? parseBalance(balanceData.value) : null;
    const tokenPlanWindows = tokenPlanData.status === 'fulfilled' ? parseTokenPlanDetail(tokenPlanData.value) : [];

    const accountKey = hashKey('mimo', cookie);
    const windows = tokenPlanWindows.length > 0 ? tokenPlanWindows : [];

    return normalizeLimitProvider({
      provider: 'mimo',
      accountKey,
      accountLabel: 'Token Plan',
      source: 'api',
      status: (balance || windows.length) ? 'ok' : 'unavailable',
      updatedAt,
      windows,
      ...(balance ? {
        balance: {
          amount: balance.balance,
          currency: balance.currency,
          todaySpend: balance.todaySpend,
          monthSpend: balance.monthSpend
        }
      } : {})
    });
  } catch (error) {
    const status = error && error.status;
    if (['disabled', 'notConfigured', 'unauthorized', 'rateLimited', 'sourceRateLimited', 'unavailable', 'error'].includes(status)) {
      return normalizeLimitProvider({ provider: 'mimo', source: 'api', status, updatedAt, windows: [] });
    }
    return normalizeLimitProvider({ provider: 'mimo', source: 'api', status: 'unavailable', updatedAt, windows: [] });
  }
}

module.exports = {
  MIMO_BALANCE_URL,
  MIMO_TOKEN_PLAN_DETAIL_URL,
  MIMO_TOKEN_PLAN_USAGE_URL,
  MIMO_LOGIN_URL,
  mimoCookie,
  validateMimoCookies,
  parseBalance,
  parseTokenPlanDetail,
  fetchMimoLimits
};
