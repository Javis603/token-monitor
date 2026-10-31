'use strict';

const { BROWSER_USER_AGENT } = require('../../browserUserAgent');
const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const { numberOrNull, toIso } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');
const { readManusDesktopSession, manusSessionClaims, SESSION_TOKEN_PATTERN } = require('./desktop');

const MANUS_FETCH_TIMEOUT_MS = 12_000;
const MANUS_API_ORIGIN = 'https://api.manus.im';
// The Connect RPC the desktop app's account menu calls (`UserService.getAvailableCredits`).
// Undocumented: observed in the Manus Studio 2.0.9 client and confirmed with one
// read-only request against a signed-in account.
const MANUS_CREDITS_PATH = '/user.v1.UserService/GetAvailableCredits';

const CREDIT_FIELDS = ['totalCredits', 'freeCredits', 'refreshCredits', 'maxRefreshCredits', 'proMonthlyCredits', 'periodicCredits'];

// Accept a bare session or a copied Cookie header; never forward other cookies.
function normalizeManusSessionToken(value) {
  const raw = String(value || '').trim();
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return '';
  const header = raw.replace(/^cookie\s*:\s*/iu, '');
  const match = /(?:^|;)\s*session_id\s*=\s*([^;]+)/u.exec(header);
  const token = match ? match[1].trim() : header;
  return SESSION_TOKEN_PATTERN.test(token) ? token : '';
}

function manusSessionValue(env, options) {
  return options.manusSessionToken
    || env?.TOKEN_MONITOR_MANUS_SESSION_TOKEN || env?.MANUS_SESSION_TOKEN || env?.MANUS_COOKIE;
}

function manusSessionToken(env = process.env, options = {}) {
  return normalizeManusSessionToken(manusSessionValue(env, options));
}

function manusCreditsUrl() {
  return `${MANUS_API_ORIGIN}${MANUS_CREDITS_PATH}`;
}

// Connect's JSON mapping omits zero-valued fields, so an absent count is zero.
// A body carrying none of the credit fields is a shape we do not know, and
// publishing zeros for it would misreport a balance.
function creditCount(body, key) {
  if (body[key] === undefined || body[key] === null) return 0;
  const value = numberOrNull(body[key]);
  if (value === null) throw new Error(`Manus credits field ${key} is not a number`);
  return value;
}

function parseManusCredits(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Manus credits response is not an object');
  }
  if (!CREDIT_FIELDS.some((key) => body[key] !== undefined && body[key] !== null)) {
    throw new Error('Manus credits response carries no credit fields');
  }
  const total = creditCount(body, 'totalCredits');
  const refresh = creditCount(body, 'refreshCredits');
  const maxRefresh = creditCount(body, 'maxRefreshCredits');
  const interval = typeof body.refreshInterval === 'string' ? body.refreshInterval.trim().toLowerCase() : '';

  const windows = [];
  const monthlyLimit = creditCount(body, 'proMonthlyCredits');
  const monthlyRemaining = creditCount(body, 'periodicCredits');
  if (monthlyLimit > 0) {
    const remaining = Math.max(0, Math.min(monthlyRemaining, monthlyLimit));
    const used = monthlyLimit - remaining;
    windows.push({
      kind: 'billing',
      label: 'Monthly credits',
      used,
      limit: monthlyLimit,
      remaining,
      usedPercent: used / monthlyLimit * 100,
      remainingPercent: remaining / monthlyLimit * 100,
      resetsAt: null
    });
  }
  // The refreshing allowance is the one that resets, so it gets the meter.
  // Without a positive ceiling there is no allowance to measure.
  if (maxRefresh > 0) {
    const remaining = Math.max(0, Math.min(refresh, maxRefresh));
    const used = maxRefresh - remaining;
    const usedPercent = (used / maxRefresh) * 100;
    const daily = interval === 'daily';
    windows.push({
      kind: daily ? 'daily' : 'billing',
      label: daily ? 'Daily credits' : 'Refresh credits',
      used,
      limit: maxRefresh,
      remaining,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: toIso(body.nextRefreshTime),
      ...(daily ? { windowMinutes: 24 * 60 } : {})
    });
  }
  // The spendable total (refreshing plus non-refreshing credits) is a points
  // balance, not a quota with a ceiling.
  windows.push({
    kind: 'billing',
    label: 'Credits',
    metric: 'credits',
    currency: 'CREDITS',
    remaining: total,
    resetsAt: null,
    showMeter: false
  });
  return { total, windows };
}

function fetchJsonWithDeadline(url, init, deps = {}) {
  const deadlineMs = Number(deps.manusFetchTimeoutMs || deps.fetchTimeoutMs || MANUS_FETCH_TIMEOUT_MS);
  return runWithProbeDeadline(
    async ({ signal }) => {
      const response = await (deps.fetch || fetch)(url, { ...init, signal });
      const body = response.ok ? await response.json() : null;
      return { response, body };
    },
    { signal: deps.signal, deadlineMs }
  );
}

function statusForResponse(status) {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'sourceRateLimited';
  return 'unavailable';
}

async function fetchManusLimits(options = {}, deps = {}) {
  const updatedAt = new Date((deps.now || Date.now)()).toISOString();
  const base = { provider: 'manus', source: 'api', updatedAt, windows: [] };

  let session;
  try {
    // An explicit session selects that account, including during a save probe.
    // Do not silently validate a different desktop account if it is rejected.
    const supplied = manusSessionValue(deps.env || process.env, options);
    const token = normalizeManusSessionToken(supplied);
    if (supplied && !token) return normalizeLimitProvider({ ...base, status: 'unauthorized' });
    if (token) {
      const claims = manusSessionClaims(token);
      session = {
        token,
        userId: typeof claims.user_id === 'string' || typeof claims.user_id === 'number' ? String(claims.user_id) : '',
        email: typeof claims.email === 'string' ? claims.email.trim() : ''
      };
    } else {
      session = (deps.readManusDesktopSession || readManusDesktopSession)(deps.manusDesktopOptions || {});
    }
  } catch (error) {
    return normalizeLimitProvider({ ...base, status: error?.status || 'unavailable' });
  }
  const accountKey = hashKey('manus', session.userId || session.token);
  const identity = { accountKey, ...(session.email ? { accountEmail: session.email } : {}) };

  try {
    const { response, body } = await fetchJsonWithDeadline(manusCreditsUrl(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        Authorization: `Bearer ${session.token}`,
        'User-Agent': BROWSER_USER_AGENT
      },
      body: '{}',
      redirect: 'error',
      credentials: 'omit'
    }, deps);
    if (!response.ok) {
      return normalizeLimitProvider({ ...base, ...identity, status: statusForResponse(response.status) });
    }
    const { total, windows } = parseManusCredits(body);
    return normalizeLimitProvider({
      ...base,
      ...identity,
      status: 'ok',
      windows,
      balance: { amount: total, currency: 'CREDITS' }
    });
  } catch (error) {
    return normalizeLimitProvider({
      ...base,
      ...identity,
      status: error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable'
    });
  }
}

module.exports = {
  MANUS_API_ORIGIN,
  MANUS_CREDITS_PATH,
  MANUS_FETCH_TIMEOUT_MS,
  fetchManusLimits,
  manusCreditsUrl,
  manusSessionToken,
  normalizeManusSessionToken,
  parseManusCredits
};
