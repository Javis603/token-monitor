'use strict';

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { runWithProbeDeadline } = require('./probeDeadline');
const { BROWSER_USER_AGENT } = require('./browserUserAgent');

const COMMANDCODE_FETCH_TIMEOUT_MS = 12_000;
// The plan lookup only enriches the monthly window, so it gets a shorter budget
// than the credits read it runs beside: a stalled subscriptions call must not
// hold back quota numbers that already arrived.
const COMMANDCODE_SUBSCRIPTION_TIMEOUT_MS = 6_000;
const COMMANDCODE_API_BASE = 'https://api.commandcode.ai';
const COMMANDCODE_CREDITS_URL = `${COMMANDCODE_API_BASE}/internal/billing/credits`;
const COMMANDCODE_SUBSCRIPTIONS_URL = `${COMMANDCODE_API_BASE}/internal/billing/subscriptions`;
const COMMANDCODE_WEB_ORIGIN = 'https://commandcode.ai';
const COMMANDCODE_USAGE_URL = `${COMMANDCODE_WEB_ORIGIN}/settings/usage`;

// better-auth names its session cookie by deployment: the `__Secure-`/`__Host-`
// prefixes are what browsers require over HTTPS, and Command Code additionally
// namespaces production under `commandcode_prod_`. Any of these identifies a
// signed-in session; a pasted header without one is not a Command Code session.
const COMMANDCODE_SESSION_COOKIE_NAMES = new Set([
  '__secure-commandcode_prod_.session_token',
  '__host-commandcode_prod_.session_token',
  'commandcode_prod_.session_token',
  '__secure-better-auth.session_token',
  '__host-better-auth.session_token',
  'better-auth.session_token'
]);

// `/internal/billing/credits` reports what is *left* of the monthly grant and
// never the plan's allowance, so the denominator has to come from the plan id on
// `/internal/billing/subscriptions` matched against the published pricing
// (https://commandcode.ai/docs/plans/*, checked 2026-08-15). An unrecognized id
// is deliberately not an error: the monthly window then ships the remaining
// money with no meter, rather than a percentage derived from a guessed total.
// The 5-hour and weekly caps are *not* here — those come off the wire.
const COMMANDCODE_PLANS = Object.freeze({
  'individual-go': { label: 'Go', monthlyCreditsUsd: 10 },
  'individual-goat': { label: 'GOAT', monthlyCreditsUsd: 70 },
  'individual-pro': { label: 'Pro', monthlyCreditsUsd: 80 },
  'individual-max': { label: 'Max 10x', monthlyCreditsUsd: 150 },
  'individual-ultra': { label: 'Max 20x', monthlyCreditsUsd: 300 }
});

function cleanSecret(value) {
  if (typeof value !== 'string') return '';
  let raw = value.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

// A cookie value may not carry control characters; a pasted header that does is
// a mangled copy rather than a session, and forwarding it would build an
// invalid request header.
function hasControlCharacters(text) {
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function cookiePairs(value) {
  let header = cleanSecret(value);
  if (/^cookie\s*:/i.test(header)) header = header.replace(/^cookie\s*:/i, '').trim();
  if (!header) return [];
  return header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    const validName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
    const validValue = Boolean(cookieValue) && !hasControlCharacters(cookieValue);
    return validName && validValue ? { name, value: cookieValue } : null;
  }).filter(Boolean);
}

function looksLikeCurlCapture(raw) {
  return /^curl(\.exe)?\s/i.test(raw.trimStart());
}

// DevTools' "Copy as cURL" is the only paste that already carries the exact
// header the browser sent, so accept it rather than making someone pick the
// Cookie line out of it by hand. The instructions still ask for the header
// itself; this is here so the shortcut does not fail silently. Values arrive
// single-quoted, double-quoted, ANSI-C quoted ($'...'), or bare.
const CURL_HEADER_ARGUMENT = /(?:^|\s)(-H|--header|-b|--cookie)(?:\s+|=)\$?(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/g;

function cookieHeaderFromCurl(raw) {
  for (const match of raw.matchAll(CURL_HEADER_ARGUMENT)) {
    const [, flag, single, double, bare] = match;
    // Only a double-quoted shell word carries escapes; inside single quotes a
    // backslash is literal and must survive into the cookie value.
    const value = single ?? (double === undefined ? bare : double.replace(/\\(.)/g, '$1'));
    if (!value) continue;
    if (flag === '-b' || flag === '--cookie') return value.trim();
    const separator = value.indexOf(':');
    if (separator <= 0) continue;
    if (value.slice(0, separator).trim().toLowerCase() !== 'cookie') continue;
    const header = value.slice(separator + 1).trim();
    if (header) return header;
  }
  // A cURL capture with no Cookie header is a capture of the wrong request.
  // Returning it whole would parse the command line itself as cookie pairs.
  return '';
}

// The whole header is forwarded, not just the session token: better-auth pairs
// the token with a `.session_data` cookie cache, and dropping it would make the
// API re-read the session on every poll.
function normalizeCommandcodeCookieHeader(rawCookie) {
  const raw = cleanSecret(rawCookie);
  const pairs = cookiePairs(looksLikeCurlCapture(raw) ? cookieHeaderFromCurl(raw) : raw);
  if (!pairs.some((pair) => COMMANDCODE_SESSION_COOKIE_NAMES.has(pair.name.toLowerCase()))) return '';
  return pairs.map((pair) => `${pair.name}=${pair.value}`).join('; ');
}

function commandcodeCookie(env = process.env, options = {}) {
  const explicit = normalizeCommandcodeCookieHeader(options.commandcodeCookie);
  if (explicit) return explicit;
  for (const name of ['COMMANDCODE_COOKIE', 'TOKEN_MONITOR_COMMANDCODE_COOKIE']) {
    const header = normalizeCommandcodeCookieHeader(env[name]);
    if (header) return header;
  }
  return '';
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toIso(value) {
  const numeric = numberOrNull(value);
  if (numeric !== null) {
    if (numeric <= 0) return null;
    // The API mixes seconds and milliseconds, and both spellings arrive as
    // strings often enough that sniffing the magnitude is the only safe read.
    const date = new Date(numeric > 20_000_000_000 ? numeric : numeric * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function planFor(planId) {
  const id = String(planId || '').trim().toLowerCase();
  return COMMANDCODE_PLANS[id] || null;
}

function rollingWindow(kind, raw, windowMinutes) {
  if (!raw || typeof raw !== 'object') return null;
  const limit = numberOrNull(raw.cap ?? raw.limit);
  if (limit === null || limit <= 0) return null;
  const used = Math.max(0, numberOrNull(raw.used) ?? 0);
  return {
    kind,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    usedPercent: clampPercent((used / limit) * 100),
    resetsAt: toIso(raw.resetAt ?? raw.reset_at),
    windowMinutes,
    showMeter: true
  };
}

// The rolling limits moved from the response root into `credits` at some point,
// and both shapes are live in the wild, so read either.
function parseCommandcodeCredits(body) {
  const credits = body?.credits;
  if (!credits || typeof credits !== 'object') throw new Error('missing credits object');
  const monthlyRemaining = numberOrNull(credits.monthlyCredits ?? credits.monthly_credits);
  if (monthlyRemaining === null) throw new Error('missing monthlyCredits');
  const windowLimits = (credits.windowLimits ?? credits.window_limits)
    || (body?.windowLimits ?? body?.window_limits)
    || null;
  return {
    monthlyRemaining,
    // `premiumMonthlyCredits` / `opensourceMonthlyCredits` split the same
    // remaining grant into two buckets (they sum to monthlyCredits), so neither
    // is a total and treating one as a denominator inverts the meter.
    purchasedCredits: Math.max(0, numberOrNull(credits.purchasedCredits ?? credits.purchased_credits) ?? 0),
    fiveHour: rollingWindow('session', windowLimits?.fiveHour ?? windowLimits?.five_hour, 5 * 60),
    weekly: rollingWindow('weekly', windowLimits?.weekly, 7 * 24 * 60)
  };
}

// Only an explicit `{"success":true,"data":null}` identifies the free tier. A
// failure envelope is transient and must not be read as "no subscription", or a
// paying account loses its plan denominator on a hiccup.
function parseCommandcodeSubscription(body) {
  if (!body || typeof body !== 'object') throw new Error('invalid subscriptions response');
  if (body.success !== true) throw new Error('unsuccessful subscriptions response');
  if (!('data' in body)) throw new Error('missing subscriptions data');
  if (body.data === null) return null;
  if (typeof body.data !== 'object') throw new Error('invalid subscriptions data');
  const planId = String(body.data.planId ?? body.data.plan_id ?? '').trim();
  if (!planId) throw new Error('missing planId');
  return {
    planId,
    status: String(body.data.status || '').trim().toLowerCase(),
    currentPeriodEnd: toIso(body.data.currentPeriodEnd ?? body.data.current_period_end)
  };
}

function errorWithStatus(status, message) {
  const error = new Error(message || status);
  error.status = status;
  return error;
}

function requestHeaders(cookie) {
  return {
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': BROWSER_USER_AGENT,
    Origin: COMMANDCODE_WEB_ORIGIN,
    Referer: `${COMMANDCODE_WEB_ORIGIN}/`
  };
}

async function fetchJson(url, cookie, deadlineMs, deps) {
  return runWithProbeDeadline(
    async ({ signal }) => {
      const response = await (deps.fetch || fetch)(url, { headers: requestHeaders(cookie), signal });
      if (response.status === 401 || response.status === 403) {
        throw errorWithStatus('unauthorized', `Command Code ${url} returned ${response.status}`);
      }
      if (response.status === 429) {
        throw errorWithStatus('sourceRateLimited', `Command Code ${url} returned 429`);
      }
      if (!response.ok) {
        throw errorWithStatus('unavailable', `Command Code ${url} returned ${response.status}`);
      }
      return response.json();
    },
    { signal: deps.signal, deadlineMs }
  );
}

// The plan allowance is the one number here that is not read off the wire, so it
// can go stale silently. Two wire values bound it from below and neither can
// legitimately exceed it: the remaining grant is part of the allowance, and a
// rolling weekly cap above the monthly grant could never be reached. When either
// does, the catalogue entry is wrong — drop the denominator and show money
// rather than a meter derived from a bad total.
//
// There is deliberately no check the other way. Nothing on the wire contradicts
// an allowance that is too LARGE, so an entry that under-reports usage would
// pass this and still be wrong. That is why the values come from the published
// plan pages: verify them there, not against a ratio invented here.
function trustedMonthlyAllowance(plan, { monthlyRemaining, weeklyCap }) {
  const allowance = plan?.monthlyCreditsUsd ?? null;
  if (allowance === null || allowance <= 0) return null;
  if (monthlyRemaining > allowance) return null;
  if (weeklyCap !== null && weeklyCap > allowance) return null;
  return allowance;
}

// Monthly grant and rollover top-ups are separate pools with separate lifetimes:
// the grant resets with the billing cycle, top-ups never expire. They ship as
// two `credits` windows so an exhausted grant cannot read as "out of money"
// while purchased credits are still funding requests.
function billingWindows({ monthlyRemaining, purchasedCredits, limit, periodEnd }) {
  const windows = [{
    kind: 'billing',
    metric: 'credits',
    label: 'Monthly',
    remaining: monthlyRemaining,
    ...(limit ? { limit, used: Math.max(0, Math.min(limit, limit - monthlyRemaining)) } : {}),
    currency: 'USD',
    resetsAt: periodEnd,
    // Without a plan allowance there is no denominator, and an empty bar would
    // read as an exhausted grant. Show the money and no meter instead.
    showMeter: Boolean(limit)
  }];
  if (purchasedCredits > 0) {
    windows.push({
      kind: 'billing',
      metric: 'credits',
      label: 'Top-up',
      remaining: purchasedCredits,
      currency: 'USD',
      showMeter: false
    });
  }
  return windows;
}

async function fetchCommandcodeLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const cookie = commandcodeCookie(env, options);
  if (!cookie) {
    return normalizeLimitProvider({
      provider: 'commandcode',
      source: 'web',
      status: 'notConfigured',
      updatedAt,
      windows: []
    });
  }

  const creditsDeadline = Number(deps.commandcodeFetchTimeoutMs || deps.fetchTimeoutMs || COMMANDCODE_FETCH_TIMEOUT_MS);
  const subscriptionDeadline = Math.min(
    creditsDeadline,
    Number(deps.commandcodeSubscriptionTimeoutMs || COMMANDCODE_SUBSCRIPTION_TIMEOUT_MS)
  );
  // Both reads start together: the plan lookup is optional enrichment, so its
  // failure resolves to null rather than rejecting the credits read beside it.
  const creditsRequest = fetchJson(COMMANDCODE_CREDITS_URL, cookie, creditsDeadline, deps);
  const subscriptionRequest = fetchJson(COMMANDCODE_SUBSCRIPTIONS_URL, cookie, subscriptionDeadline, deps)
    .then(parseCommandcodeSubscription)
    .catch(() => null);

  try {
    const [creditsBody, subscription] = await Promise.all([creditsRequest, subscriptionRequest]);
    const credits = parseCommandcodeCredits(creditsBody);
    const plan = planFor(subscription?.planId);
    const windows = [
      credits.fiveHour,
      credits.weekly,
      ...billingWindows({
        monthlyRemaining: credits.monthlyRemaining,
        purchasedCredits: credits.purchasedCredits,
        limit: trustedMonthlyAllowance(plan, {
          monthlyRemaining: credits.monthlyRemaining,
          weeklyCap: credits.weekly?.limit ?? null
        }),
        periodEnd: subscription?.currentPeriodEnd || null
      })
    ].filter(Boolean);
    return normalizeLimitProvider({
      provider: 'commandcode',
      accountKey: hashKey('commandcode', cookie),
      accountLabel: plan?.label || '',
      source: 'web',
      status: 'ok',
      updatedAt,
      windows
    });
  } catch (error) {
    // The optional read already swallowed its own failures, so anything landing
    // here came from the credits call or from parsing it.
    await subscriptionRequest;
    return normalizeLimitProvider({
      provider: 'commandcode',
      source: 'web',
      status: error?.status === 'timeout' ? 'unavailable' : (error?.status || 'unavailable'),
      updatedAt,
      windows: []
    });
  }
}

module.exports = {
  COMMANDCODE_CREDITS_URL,
  COMMANDCODE_FETCH_TIMEOUT_MS,
  COMMANDCODE_PLANS,
  COMMANDCODE_SESSION_COOKIE_NAMES,
  COMMANDCODE_SUBSCRIPTIONS_URL,
  COMMANDCODE_USAGE_URL,
  commandcodeCookie,
  fetchCommandcodeLimits,
  normalizeCommandcodeCookieHeader,
  parseCommandcodeCredits,
  parseCommandcodeSubscription
};
