'use strict';

const { BROWSER_USER_AGENT } = require('../../browserUserAgent');
const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const { numberOrNull, toIso } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');
const { readManusDesktopSession } = require('./desktop');

const MANUS_FETCH_TIMEOUT_MS = 12_000;
const MANUS_API_ORIGIN = 'https://api.manus.im';
// The Connect RPC the desktop app's account menu calls (`UserService.getAvailableCredits`).
// Undocumented: observed in the Manus Studio 2.0.9 client and confirmed with one
// read-only request against a signed-in account.
const MANUS_CREDITS_PATH = '/user.v1.UserService/GetAvailableCredits';

const CREDIT_FIELDS = ['totalCredits', 'freeCredits', 'refreshCredits', 'maxRefreshCredits'];

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

async function fetchManusLimits(_options = {}, deps = {}) {
  const updatedAt = new Date((deps.now || Date.now)()).toISOString();
  const base = { provider: 'manus', source: 'api', updatedAt, windows: [] };

  let session;
  try {
    session = (deps.readManusDesktopSession || readManusDesktopSession)(deps.manusDesktopOptions || {});
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
  parseManusCredits
};
