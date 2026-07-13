'use strict';

const crypto = require('node:crypto');
const { hashKey } = require('./hashKey');
const { normalizeLimitProvider } = require('./limits');

const MIMO_PLATFORM_CONSOLE_URL = 'https://platform.xiaomimimo.com/#/console/balance';
const MIMO_API_BASE_URL = 'https://platform.xiaomimimo.com/api/v1';
const MIMO_ACCOUNT_TIMEOUT_MS = 15_000;
const MIMO_COOKIE_NAMES = new Set([
  'api-platform_serviceToken',
  'userId',
  'api-platform_ph',
  'api-platform_slh'
]);
const MIMO_REQUIRED_COOKIE_NAMES = new Set(['api-platform_serviceToken', 'userId']);
const MIMO_NO_PLAN_CODES = new Set([
  'default',
  'none',
  'no_plan',
  'not_subscribed',
  'unsubscribed'
]);
const MIMO_ACTIVE_STATUSES = new Set(['active', 'subscribed']);
const MIMO_EXPIRED_STATUSES = new Set(['expired', 'ended']);

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlanValue(value) {
  return cleanText(value).toLowerCase().replace(/[\s-]+/g, '_');
}

function cookiePairs(value) {
  let raw = cleanText(value);
  if (!raw) return [];
  raw = raw.replace(/^cookie\s*:\s*/i, '');
  const pairs = [];
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (!MIMO_COOKIE_NAMES.has(name) || !cookieValue) continue;
    pairs.push([name, cookieValue]);
  }
  return pairs;
}

function normalizeMimoCookieHeader(value) {
  const byName = new Map(cookiePairs(value));
  for (const required of MIMO_REQUIRED_COOKIE_NAMES) {
    if (!byName.has(required)) return '';
  }
  return [...byName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, cookieValue]) => `${name}=${cookieValue}`)
    .join('; ');
}

function mimoAccountKey(cookieHeader, account = {}) {
  const identity = cleanText(account.userId || account.user_id || account.id)
    || new Map(cookiePairs(cookieHeader)).get('userId')
    || cookieHeader;
  return hashKey(`mimo:${identity}`);
}

function numberFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(/[,%$]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function unwrapApiBody(value) {
  if (!value || typeof value !== 'object') return {};
  return value.data && typeof value.data === 'object' ? value.data : value;
}

function normalizePercent(value, used, limit) {
  const explicit = numberFrom(value);
  if (explicit !== null) return Math.max(0, Math.min(100, explicit <= 1 ? explicit * 100 : explicit));
  if (used !== null && limit !== null && limit > 0) return Math.max(0, Math.min(100, (used / limit) * 100));
  return null;
}

function parseMimoBalance(body) {
  const data = unwrapApiBody(body);
  return {
    amount: numberFrom(data.balance),
    currency: cleanText(data.currency).toUpperCase(),
    cashBalance: numberFrom(data.cashBalance ?? data.cash_balance),
    giftBalance: numberFrom(data.giftBalance ?? data.gift_balance)
  };
}

function parseMimoProfile(body) {
  const data = unwrapApiBody(body);
  return {
    email: cleanText(data.email ?? data.platformEmail).slice(0, 254)
  };
}

function parseMimoPlanDetail(body, now = Date.now()) {
  const data = unwrapApiBody(body);
  const label = cleanText(
    data.planCode
    ?? data.plan_code
    ?? data.planName
    ?? data.plan_name
  );
  const normalizedLabel = normalizePlanValue(label);
  const rawStatus = normalizePlanValue(
    data.planStatus
    ?? data.plan_status
    ?? data.subscriptionStatus
    ?? data.subscription_status
    ?? data.status
    ?? data.state
  );
  const rawEnd = data.currentPeriodEnd ?? data.current_period_end;
  const parsedEnd = rawEnd
    ? Date.parse(
      String(rawEnd).replace(' ', 'T')
      + (/Z$|[+-]\d\d:?\d\d$/.test(String(rawEnd)) ? '' : 'Z')
    )
    : NaN;
  const hasFuturePeriod = Number.isFinite(parsedEnd) && parsedEnd > now;
  const hasExpiredPeriod = Number.isFinite(parsedEnd) && parsedEnd <= now;
  const isKnownNoPlan = MIMO_NO_PLAN_CODES.has(normalizedLabel)
    || MIMO_NO_PLAN_CODES.has(rawStatus);
  const hasRealPlanIdentity = Boolean(normalizedLabel) && !MIMO_NO_PLAN_CODES.has(normalizedLabel);
  const hasExplicitActiveFlag = typeof data.active === 'boolean'
    || typeof data.isActive === 'boolean';
  const explicitActive = MIMO_ACTIVE_STATUSES.has(rawStatus)
    || data.active === true
    || data.isActive === true;
  const explicitExpired = MIMO_EXPIRED_STATUSES.has(rawStatus)
    || data.expired === true
    || String(data.expired).toLowerCase() === 'true';
  const hasExplicitStatus = Boolean(rawStatus) || hasExplicitActiveFlag;
  const expired = !isKnownNoPlan && (
    explicitExpired
    || (hasRealPlanIdentity && hasExpiredPeriod)
  );
  const active = !isKnownNoPlan
    && !expired
    && (
      explicitActive
      || (!hasExplicitStatus && hasRealPlanIdentity && hasFuturePeriod)
    );
  return {
    label,
    resetsAt: Number.isFinite(parsedEnd) ? new Date(parsedEnd).toISOString() : null,
    active,
    expired
  };
}

function parseMimoPlanUsage(body) {
  const data = unwrapApiBody(body);
  const month = data.monthUsage ?? data.month_usage ?? {};
  const items = Array.isArray(month.items) ? month.items : [];
  const totalItem = items.find(
    (entry) => cleanText(entry?.name).toLowerCase() === 'month_total_token'
  );
  if (items.length > 0 && !totalItem) {
    return { used: null, limit: null, usedPercent: null };
  }
  const item = totalItem || month;
  const used = numberFrom(item.used);
  const limit = numberFrom(item.limit);
  const usedPercent = normalizePercent(item.percent, used, limit);
  return { used, limit, usedPercent };
}

function requestHeaders(cookieHeader) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: cookieHeader,
    Origin: 'https://platform.xiaomimimo.com',
    Referer: MIMO_PLATFORM_CONSOLE_URL,
    'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/143 Safari/537.36'
  };
}

async function requestMimo(pathname, cookieHeader, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const response = await fetchFn(`${MIMO_API_BASE_URL}${pathname}`, {
    headers: requestHeaders(cookieHeader),
    redirect: 'manual',
    signal: deps.signal
  });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    const error = new Error('MiMo browser session expired');
    error.code = 'MIMO_UNAUTHORIZED';
    throw error;
  }
  if (response.status === 429) {
    const error = new Error('MiMo is rate limited');
    error.code = 'MIMO_RATE_LIMITED';
    throw error;
  }
  if (!response.ok) throw new Error(`MiMo request failed: HTTP ${response.status}`);
  const body = await response.json();
  const bodyCode = Number(body?.code);
  if (bodyCode === 401 || bodyCode === 403) {
    const error = new Error('MiMo browser session expired');
    error.code = 'MIMO_UNAUTHORIZED';
    throw error;
  }
  if (body?.code !== undefined && body?.code !== null && Number(body.code) !== 0) {
    throw new Error(`MiMo API rejected the request: ${cleanText(body.message) || body.code}`);
  }
  return body;
}

function statusProvider(status, updatedAt, account = {}) {
  return normalizeLimitProvider({
    provider: 'mimo',
    source: 'web',
    sourceDetail: 'managed',
    status,
    updatedAt,
    accountKey: account.accountKey,
    accountName: account.accountName,
    accountEmail: account.accountEmail,
    windows: []
  });
}

async function fetchMimoAccount(account, deps = {}) {
  const updatedAt = new Date((deps.now || Date.now)()).toISOString();
  const cookieHeader = normalizeMimoCookieHeader(account.cookieHeader);
  if (!cookieHeader) return statusProvider('notConfigured', updatedAt, account);
  try {
    const [balanceBody, profileBody, detailBody, usageBody] = await Promise.all([
      requestMimo('/balance', cookieHeader, deps),
      requestMimo('/userProfile', cookieHeader, deps).catch(() => null),
      requestMimo('/tokenPlan/detail', cookieHeader, deps).catch(() => null),
      requestMimo('/tokenPlan/usage', cookieHeader, deps).catch(() => null)
    ]);
    const balance = parseMimoBalance(balanceBody);
    if (balance.amount === null) throw new Error('MiMo balance response is missing a balance');
    const profile = parseMimoProfile(profileBody);
    const accountEmail = profile.email || cleanText(account.accountEmail);
    const detail = parseMimoPlanDetail(detailBody, (deps.now || Date.now)());
    const usage = parseMimoPlanUsage(usageBody);
    const windows = [];
    const hasTokenPlan = detail.active && usage.limit !== null && usage.limit > 0;
    const hasExpiredTokenPlan = detail.expired && Boolean(detail.label || (usage.limit !== null && usage.limit > 0));
    if (hasTokenPlan) {
      windows.push({
        kind: 'billing',
        label: 'Token Plan',
        used: usage.used,
        limit: usage.limit,
        remaining: usage.used === null ? null : Math.max(0, usage.limit - usage.used),
        usedPercent: usage.usedPercent,
        resetsAt: detail.resetsAt
      });
    }
    return normalizeLimitProvider({
      provider: 'mimo',
      source: 'web',
      sourceDetail: 'managed',
      status: 'ok',
      updatedAt,
      accountKey: cleanText(account.accountKey) || mimoAccountKey(cookieHeader),
      accountName: '',
      accountEmail,
      accountLabel: hasTokenPlan || hasExpiredTokenPlan
        ? (detail.label || 'Token Plan')
        : '',
      windows,
      balance: {
        ...balance,
        planStatus: hasExpiredTokenPlan ? 'expired' : null,
        planUsed: hasTokenPlan ? usage.used : null,
        planLimit: hasTokenPlan ? usage.limit : null,
        planPercent: hasTokenPlan ? usage.usedPercent : null
      }
    });
  } catch (error) {
    const status = error?.code === 'MIMO_UNAUTHORIZED'
      ? 'unauthorized'
      : error?.code === 'MIMO_RATE_LIMITED' ? 'sourceRateLimited' : 'unavailable';
    return statusProvider(status, updatedAt, account);
  }
}

async function fetchMimoAccountWithTimeout(account, deps = {}) {
  const timeoutMs = Number(deps.accountTimeoutMs ?? MIMO_ACCOUNT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetchMimoAccount(account, deps);
  const AbortControllerImpl = deps.AbortController || globalThis.AbortController;
  const controller = AbortControllerImpl ? new AbortControllerImpl() : null;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimer(() => {
      controller?.abort();
      const updatedAt = new Date((deps.now || Date.now)()).toISOString();
      resolve(statusProvider('unavailable', updatedAt, account));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchMimoAccount(account, { ...deps, signal: controller?.signal || deps.signal }),
      timeout
    ]);
  } finally {
    if (timer) clearTimer(timer);
  }
}

function normalizeMimoManagedAccounts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const accounts = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || item.enabled === false) continue;
    const cookieHeader = normalizeMimoCookieHeader(item.cookieHeader);
    if (!cookieHeader) continue;
    const accountKey = cleanText(item.accountKey) || mimoAccountKey(cookieHeader);
    if (seen.has(accountKey)) continue;
    seen.add(accountKey);
    accounts.push({ ...item, accountKey, cookieHeader });
  }
  return accounts;
}

async function fetchMimoLimits(options = {}, deps = {}) {
  const accounts = normalizeMimoManagedAccounts(options.mimoManagedAccounts || deps.mimoManagedAccounts);
  if (!accounts.length) {
    return statusProvider('notConfigured', new Date((deps.now || Date.now)()).toISOString());
  }
  return Promise.all(accounts.map((account) => fetchMimoAccountWithTimeout(account, deps)));
}

function createMimoManagedAccount(cookieValue, existing = []) {
  const presentCookieNames = new Set(cookiePairs(cookieValue).map(([name]) => name));
  const missingCookies = [...MIMO_REQUIRED_COOKIE_NAMES]
    .filter((name) => !presentCookieNames.has(name));
  if (missingCookies.length) {
    return { ok: false, errorCode: 'missingRequiredCookies', missingCookies };
  }
  const cookieHeader = normalizeMimoCookieHeader(cookieValue);
  const accountKey = mimoAccountKey(cookieHeader);
  const duplicate = existing.find((account) => cleanText(account?.accountKey) === accountKey);
  return {
    ok: true,
    account: {
      id: duplicate?.id || `mimo-${crypto.randomUUID()}`,
      accountKey,
      accountEmail: cleanText(duplicate?.accountEmail),
      accountLabel: duplicate?.accountLabel || '',
      cookieHeader,
      addedAt: duplicate?.addedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      enabled: true
    }
  };
}

module.exports = {
  MIMO_API_BASE_URL,
  MIMO_ACCOUNT_TIMEOUT_MS,
  MIMO_COOKIE_NAMES,
  MIMO_PLATFORM_CONSOLE_URL,
  createMimoManagedAccount,
  fetchMimoLimits,
  mimoAccountKey,
  normalizeMimoCookieHeader,
  parseMimoBalance,
  parseMimoProfile,
  parseMimoPlanDetail,
  parseMimoPlanUsage
};
