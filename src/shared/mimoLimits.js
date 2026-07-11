'use strict';

// Xiaomi MiMo Token Plan balance & quota lookup.
//
// MiMo uses cookie-based authentication (not API key):
//   - Cookie: api-platform_serviceToken=<token>; userId=<uid>
//   - Optional: api-platform_ph, api-platform_slh
//
// Balance endpoint: https://platform.xiaomimimo.com/api/v1/balance
// Token Plan detail: https://platform.xiaomimimo.com/api/v1/tokenPlan/detail
// Token Plan usage:  https://platform.xiaomimimo.com/api/v1/tokenPlan/usage

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');

const MIMO_BALANCE_URL = 'https://platform.xiaomimimo.com/api/v1/balance';
const MIMO_TOKEN_PLAN_DETAIL_URL = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/detail';
const MIMO_TOKEN_PLAN_USAGE_URL = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage';
const MIMO_LOGIN_URL = 'https://platform.xiaomimimo.com/#/console/balance';

const MIMO_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

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
  const timeoutMs = Number(deps.fetchTimeoutMs || 15000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await (deps.fetch || fetch)(url, {
      headers: {
        Cookie: cookies,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'x-timeZone': 'UTC+08:00',
        Origin: 'https://platform.xiaomimimo.com',
        Referer: 'https://platform.xiaomimimo.com/#/console/balance',
        'User-Agent': MIMO_USER_AGENT
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

// Parse balance response: { code: 0, data: { balance: "string", currency: "string", cashBalance?: "string", giftBalance?: "string" } }
function parseBalance(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.code !== 0) return null;
  const data = body.data;
  if (!data || typeof data !== 'object') return null;

  const balance = parseFloat(data.balance);
  if (!Number.isFinite(balance)) return null;

  return {
    balance,
    currency: (data.currency || 'CNY').trim(),
    cashBalance: data.cashBalance ? parseFloat(data.cashBalance) : null,
    giftBalance: data.giftBalance ? parseFloat(data.giftBalance) : null
  };
}

// Parse token plan detail: { code: 0, data: { planCode?: "string", currentPeriodEnd?: "string", expired: bool } }
function parseTokenPlanDetail(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.code !== 0) return null;
  const data = body.data;
  if (!data || typeof data !== 'object') return null;

  return {
    planCode: data.planCode || null,
    periodEnd: data.currentPeriodEnd || null,
    expired: Boolean(data.expired)
  };
}

// Parse token plan usage: { code: 0, data: { monthUsage: { percent: double, items: [{ name, used, limit, percent }] } } }
function parseTokenPlanUsage(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.code !== 0) return null;
  const data = body.data;
  if (!data || typeof data !== 'object') return null;
  const monthUsage = data.monthUsage;
  if (!monthUsage || typeof monthUsage !== 'object') return null;
  if (!Array.isArray(monthUsage.items) || monthUsage.items.length === 0) return null;

  const item = monthUsage.items[0];
  const used = parseNumberOrNull(item.used) || 0;
  const limit = parseNumberOrNull(item.limit) || 0;
  const percent = parseNumberOrNull(monthUsage.percent) || parseNumberOrNull(item.percent) || 0;

  return { used, limit, percent };
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
    // Fetch balance, token plan detail, and token plan usage in parallel
    const [balanceData, tokenPlanData, tokenUsageData] = await Promise.allSettled([
      fetchJson(MIMO_BALANCE_URL, cookie, deps),
      fetchJson(MIMO_TOKEN_PLAN_DETAIL_URL, cookie, deps),
      fetchJson(MIMO_TOKEN_PLAN_USAGE_URL, cookie, deps)
    ]);

    const balance = balanceData.status === 'fulfilled' ? parseBalance(balanceData.value) : null;
    const tokenPlanDetail = tokenPlanData.status === 'fulfilled' ? parseTokenPlanDetail(tokenPlanData.value) : null;
    const tokenUsage = tokenUsageData.status === 'fulfilled' ? parseTokenPlanUsage(tokenUsageData.value) : null;

    const accountKey = hashKey('mimo', cookie);

    // Build windows from usage data
    const windows = [];
    if (tokenUsage && tokenUsage.limit > 0) {
      windows.push({
        kind: 'monthly',
        label: 'Monthly',
        usedPercent: Math.max(0, Math.min(100, tokenUsage.percent)),
        remainingPercent: Math.max(0, Math.min(100, 100 - tokenUsage.percent)),
        resetsAt: tokenPlanDetail?.periodEnd || null,
        windowMinutes: 30 * 24 * 60, // monthly
        showMeter: true
      });
    }

    return normalizeLimitProvider({
      provider: 'mimo',
      accountKey,
      accountLabel: tokenPlanDetail?.planCode || 'Token Plan',
      source: 'api',
      status: (balance || tokenUsage) ? 'ok' : 'unavailable',
      updatedAt,
      windows,
      ...(balance ? {
        balance: {
          amount: balance.balance,
          currency: balance.currency
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
  MIMO_USER_AGENT,
  mimoCookie,
  validateMimoCookies,
  parseBalance,
  parseTokenPlanDetail,
  parseTokenPlanUsage,
  fetchMimoLimits
};
