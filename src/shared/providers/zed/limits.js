'use strict';

const { BROWSER_USER_AGENT } = require('../../browserUserAgent');
const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits');
const { runWithProbeDeadline } = require('../../probeDeadline');

const ZED_FETCH_TIMEOUT_MS = 12_000;
const ZED_SUBSCRIPTION_TIMEOUT_MS = 6_000;
const ZED_DASHBOARD_URL = 'https://dashboard.zed.dev/';
const ZED_BILLING_USAGE_URL = 'https://cloud.zed.dev/frontend/billing/usage';
const ZED_BILLING_SUBSCRIPTION_URL = 'https://cloud.zed.dev/frontend/billing/subscriptions/current';

// Forward only cookies observed on Zed's dashboard billing request. Requiring
// the namespaced session cookie prevents a header copied from another site from
// ever being sent to cloud.zed.dev; the Cloudflare cookies are optional helpers.
const ZED_SESSION_COOKIE = 'zed.session';
const ZED_FORWARDED_COOKIE_NAMES = new Set([
  ZED_SESSION_COOKIE,
  'c15t',
  '__cf_bm',
  'cf_clearance'
]);

function cleanSecret(value) {
  if (typeof value !== 'string') return '';
  let raw = value.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function cookiePairs(value) {
  let header = cleanSecret(value);
  if (/^cookie\s*:/iu.test(header)) header = header.replace(/^cookie\s*:/iu, '').trim();
  if (!header || hasControlCharacters(header)) return [];
  return header.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return [];
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || !cookieValue) return [];
    return [{ name, value: cookieValue }];
  });
}

function normalizeZedCookieHeader(value) {
  const pairs = cookiePairs(value);
  if (!pairs.some((pair) => pair.name.toLowerCase() === ZED_SESSION_COOKIE)) return '';
  return pairs
    .filter((pair) => ZED_FORWARDED_COOKIE_NAMES.has(pair.name.toLowerCase()))
    .map((pair) => `${pair.name}=${pair.value}`)
    .join('; ');
}

function zedCookie(env = process.env, options = {}) {
  const explicit = normalizeZedCookieHeader(options.zedCookie);
  if (explicit) return explicit;
  for (const name of ['TOKEN_MONITOR_ZED_COOKIE', 'ZED_COOKIE']) {
    const cookie = normalizeZedCookieHeader(env?.[name]);
    if (cookie) return cookie;
  }
  return '';
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatPlanLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cleaned = raw
    .replace(/^token_based_/iu, '')
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()).slice(0, 32);
}

function parseSubscription(body) {
  const subscription = body?.subscription;
  if (!subscription || typeof subscription !== 'object') return null;
  return {
    planLabel: formatPlanLabel(subscription.name),
    resetsAt: toIso(subscription?.period?.end_at)
  };
}

function parseEditPredictionsWindow(currentUsage) {
  const input = currentUsage?.edit_predictions;
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'limit')) return null;
  if (input.limit === null) {
    return {
      kind: 'billing',
      limitId: 'zed.edit-predictions',
      label: 'Edit Predictions',
      resetDescription: '',
      detail: 'Unlimited',
      showMeter: false
    };
  }
  const used = numberOrNull(input.used);
  const limit = numberOrNull(input.limit);
  if (used === null || limit === null || limit <= 0) return null;
  const remaining = numberOrNull(input.remaining) ?? Math.max(0, limit - used);
  const usedPercent = Math.min(100, (used / limit) * 100);
  return {
    kind: 'billing',
    limitId: 'zed.edit-predictions',
    label: 'Edit Predictions',
    used,
    limit,
    remaining,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetDescription: '',
    showMeter: true
  };
}

function parseZedBillingUsage(body, subscriptionBody = null) {
  const currentUsage = body?.current_usage;
  if (!currentUsage || typeof currentUsage !== 'object') {
    throw new Error('unexpected Zed billing response shape');
  }
  const subscription = parseSubscription(subscriptionBody);
  const planLabel = subscription?.planLabel || formatPlanLabel(body.plan);
  const tokenSpend = currentUsage.token_spend;
  let tokenSpendWindow = null;
  if (tokenSpend && typeof tokenSpend === 'object') {
    const spendCents = numberOrNull(currentUsage.token_spend_in_cents)
      ?? numberOrNull(tokenSpend.spend_in_cents);
    const limitCents = numberOrNull(tokenSpend.limit_in_cents);
    if (spendCents !== null && limitCents !== null && limitCents > 0) {
      const used = spendCents / 100;
      const limit = limitCents / 100;
      const usedPercent = Math.min(100, (spendCents / limitCents) * 100);
      tokenSpendWindow = {
        kind: 'billing',
        limitId: 'zed.token-spend',
        label: 'Token Spend',
        used,
        limit,
        remaining: Math.max(0, limit - used),
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsAt: subscription?.resetsAt || null,
        currency: 'USD',
        showMeter: true
      };
    }
  }
  const editPredictionsWindow = parseEditPredictionsWindow(currentUsage);
  const windows = [tokenSpendWindow, editPredictionsWindow].filter(Boolean);
  if (windows.length === 0) throw new Error('Zed billing response is missing usage');
  return {
    planLabel,
    usageUpdatedAt: toIso(tokenSpend?.updated_at),
    window: windows[0],
    windows
  };
}

function errorWithStatus(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requestHeaders(cookie) {
  return {
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': BROWSER_USER_AGENT
  };
}

async function fetchJson(url, cookie, deadlineMs, deps = {}) {
  return runWithProbeDeadline(
    async ({ signal }) => {
      const response = await (deps.fetch || fetch)(url, {
        method: 'GET',
        headers: requestHeaders(cookie),
        credentials: 'omit',
        redirect: 'error',
        signal
      });
      if (response.status === 401 || response.status === 403) {
        throw errorWithStatus('unauthorized', `Zed billing request returned ${response.status}`);
      }
      if (response.status === 429) {
        throw errorWithStatus('sourceRateLimited', 'Zed billing request returned 429');
      }
      if (!response.ok) {
        throw errorWithStatus('unavailable', `Zed billing request returned ${response.status}`);
      }
      return response.json();
    },
    { signal: deps.signal, deadlineMs }
  );
}

function providerStatus(status, updatedAt) {
  return normalizeLimitProvider({
    provider: 'zed',
    source: 'web',
    status,
    updatedAt,
    windows: []
  });
}

async function fetchZedLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const cookie = zedCookie(env, options);
  if (!cookie) return providerStatus('notConfigured', updatedAt);

  try {
    const usagePromise = fetchJson(
      ZED_BILLING_USAGE_URL,
      cookie,
      Number(deps.zedFetchTimeoutMs || ZED_FETCH_TIMEOUT_MS),
      deps
    );
    const subscriptionPromise = fetchJson(
      ZED_BILLING_SUBSCRIPTION_URL,
      cookie,
      Number(deps.zedSubscriptionTimeoutMs || ZED_SUBSCRIPTION_TIMEOUT_MS),
      deps
    ).catch((error) => {
      if (error?.name === 'AbortError') throw error;
      return null;
    });
    const [usageBody, subscriptionBody] = await Promise.all([usagePromise, subscriptionPromise]);
    const parsed = parseZedBillingUsage(usageBody, subscriptionBody);
    const sessionSeed = cookiePairs(cookie)
      .find((pair) => pair.name.toLowerCase() === ZED_SESSION_COOKIE)?.value || cookie;
    return normalizeLimitProvider({
      provider: 'zed',
      accountKey: hashKey('zed', sessionSeed),
      planLabel: parsed.planLabel,
      source: 'web',
      status: 'ok',
      updatedAt,
      windows: parsed.windows
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return providerStatus(error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable', updatedAt);
  }
}

module.exports = {
  ZED_BILLING_SUBSCRIPTION_URL,
  ZED_BILLING_USAGE_URL,
  ZED_DASHBOARD_URL,
  ZED_FETCH_TIMEOUT_MS,
  ZED_SUBSCRIPTION_TIMEOUT_MS,
  fetchZedLimits,
  formatPlanLabel,
  normalizeZedCookieHeader,
  parseEditPredictionsWindow,
  parseSubscription,
  parseZedBillingUsage,
  zedCookie
};
