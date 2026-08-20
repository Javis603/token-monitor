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

// Command Code namespaces its better-auth cookies under `commandcode_prod_`; the
// `__Secure-`/`__Host-` prefixes are what browsers require over HTTPS. This is
// what identifies a signed-in session — a pasted header without one is not a
// Command Code session.
//
// better-auth's own defaults (`better-auth.session_token` and its prefixed
// spellings) are deliberately NOT here, though other clients accept them as a
// fallback. That name belongs to the library, not to this provider, so any site
// built on better-auth produces a header indistinguishable from a real session —
// and a bare header carries nothing that says where it came from, so one
// mis-paste would post someone else's session to api.commandcode.ai. Production
// has been observed using the namespaced spelling, which is the condition that
// fallback was waiting on. Restore it only with a live deployment that needs it,
// and then only for a capture whose origin has been verified.
const COMMANDCODE_SESSION_COOKIE_NAMES = new Set([
  '__secure-commandcode_prod_.session_token',
  '__host-commandcode_prod_.session_token',
  'commandcode_prod_.session_token'
]);

// What actually gets sent. `session_token` is the identity; `session_data` is
// better-auth's short-lived cookie cache, kept so the API is not made to re-read
// the session on every poll. Everything else — Stripe, analytics, and the rest
// of the same namespace (`dont_remember`, `two_factor`, …) — is a credential the
// billing API has no business receiving, so this is an exact list rather than a
// namespace prefix.
const COMMANDCODE_FORWARDED_COOKIE_NAMES = new Set([
  ...COMMANDCODE_SESSION_COOKIE_NAMES,
  '__secure-commandcode_prod_.session_data',
  '__host-commandcode_prod_.session_data',
  'commandcode_prod_.session_data'
]);

// Hosts a session cookie for this provider can legitimately have been captured
// from. Deliberately the whole host and not just the billing paths: copying the
// cURL of the usage page's own document request is a perfectly good way to get
// the header, and pinning the path would reject it.
const COMMANDCODE_COOKIE_HOSTS = new Set([
  'commandcode.ai',
  'www.commandcode.ai',
  'api.commandcode.ai'
]);

function isCommandcodeAuthCookie(name) {
  return COMMANDCODE_FORWARDED_COOKIE_NAMES.has(String(name).toLowerCase());
}

// `/internal/billing/credits` reports what is *left* of the monthly grant and
// never the plan's allowance, so the denominator has to come from the plan id on
// `/internal/billing/subscriptions` matched against the published pricing
// (https://commandcode.ai/docs/plans/*, checked 2026-08-15). An unrecognized id
// is deliberately not an error: the monthly window then ships the remaining
// money with no meter, rather than a percentage derived from a guessed total.
//
// The 5-hour and weekly caps are published on the same pages and are recorded
// here even though the wire reports them, because that is what lets a stale
// entry be detected in the direction the numbers alone cannot show — see
// trustedMonthlyAllowance().
//
// One limitation to know about: GOAT and Pro publish per-model monthly
// allowances on top of the plan total, and the only live payload behind these
// numbers is a Go account. The plan-wide reading is what the docs describe — on
// those two plans a credit is a usage-value unit drawn against the single plan
// pool, so a lower-allowance model spends more than one credit per dollar of
// usage rather than opening a pool of its own — and what the API's own single
// weekly cap implies. A real GOAT or Pro capture has still not confirmed it.
const COMMANDCODE_PLANS = Object.freeze({
  'individual-go': { label: 'Go', monthlyCreditsUsd: 10, fiveHourCapUsd: 3, weeklyCapUsd: 6 },
  'individual-goat': { label: 'GOAT', monthlyCreditsUsd: 70, fiveHourCapUsd: 14, weeklyCapUsd: 35 },
  'individual-pro': { label: 'Pro', monthlyCreditsUsd: 80, fiveHourCapUsd: 16, weeklyCapUsd: 40 },
  'individual-max': { label: 'Max 10x', monthlyCreditsUsd: 150, fiveHourCapUsd: 45, weeklyCapUsd: 90 },
  'individual-ultra': { label: 'Max 20x', monthlyCreditsUsd: 300, fiveHourCapUsd: 90, weeklyCapUsd: 180 }
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

// The request URL is the first argument whose value *starts* with a scheme —
// header values that mention one (`referer: https://…`) never do, so this picks
// the captured request rather than something quoted inside it.
const CURL_TOKEN = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;

function curlRequestUrl(raw) {
  for (const match of raw.matchAll(CURL_TOKEN)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (!/^https?:\/\//i.test(value || '')) continue;
    try { return new URL(value); } catch (_) { return null; }
  }
  return null;
}

function cookieHeaderFromCurl(raw) {
  // A capture carries the origin its cookies belong to, so use it: without this
  // a cURL copied from any other site would have its session forwarded here.
  const requestUrl = curlRequestUrl(raw);
  if (!requestUrl || !COMMANDCODE_COOKIE_HOSTS.has(requestUrl.hostname.toLowerCase())) return '';
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

// Keeps the two cookies the billing API needs and drops everything else.
function normalizeCommandcodeCookieHeader(rawCookie) {
  const raw = cleanSecret(rawCookie);
  const pairs = cookiePairs(looksLikeCurlCapture(raw) ? cookieHeaderFromCurl(raw) : raw);
  if (!pairs.some((pair) => COMMANDCODE_SESSION_COOKIE_NAMES.has(pair.name.toLowerCase()))) return '';
  return pairs
    .filter((pair) => isCommandcodeAuthCookie(pair.name))
    .map((pair) => `${pair.name}=${pair.value}`)
    .join('; ');
}

// Identity for the account, in preference order. The subscription carries a
// stable account id, which is what `accountKey` is contractually for — it
// survives a re-pasted cookie and matches across devices. Without it, fall back
// to the session token alone: it is at least the credential's identity half, and
// `session_data` is a short-lived cache that would otherwise churn the key on
// its own schedule. The key can therefore change if the optional subscription
// read fails; that is tolerable because this provider collapses by name during
// aggregation, and subscription binding heals through its own ladder.
function commandcodeAccountSeed(cookieHeader) {
  const session = cookiePairs(cookieHeader)
    .find((pair) => COMMANDCODE_SESSION_COOKIE_NAMES.has(pair.name.toLowerCase()));
  return session ? session.value : cookieHeader;
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
    // Prefer the account over the subscription: a cancel-and-resubscribe issues
    // a new `id` to the same person, so `id` is the last resort before falling
    // back to the credential. A live payload carries the user id twice, under
    // `userId` and again in `metadata`; the rest of the ladder is for shapes
    // that carry only one of them.
    accountId: String(
      body.data.userId
      ?? body.data.user_id
      ?? body.data.metadata?.commandCodeUserId
      ?? body.data.id
      ?? ''
    ).trim(),
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

async function fetchJson(url, cookie, deadlineMs, deps, parentSignal = deps.signal) {
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
    { signal: parentSignal, deadlineMs }
  );
}

// The plan allowance is the one number here that is not read off the wire, so it
// can go stale silently. The wire has to corroborate it before it becomes a
// denominator: the published 5-hour and weekly caps must be exactly the ones
// this account reports, and the remaining grant must fit inside the allowance.
// Anything else ships the money with no meter.
//
// Requiring the caps to be PRESENT is what makes this fail closed, and it is
// deliberate. They are the only signal that catches a catalogued grant which has
// since gone UP — nothing about a remaining balance contradicts a total that is
// too large — so accepting a response that carries no caps would trust the
// catalogue in precisely the case with no evidence behind it. Every published
// plan has both caps, and a live account reports them before either window is
// touched (with `resetAt: 0`), so their absence means the shape moved rather
// than that the plan is unmetered.
//
// What this does not do is establish what `monthlyCredits` MEANS on a plan whose
// payload nobody here has seen. It pins a catalogue entry to the plan it was
// copied from and catches repricing; it cannot detect a plan that reports its
// grant in some other unit while still publishing familiar caps.
function trustedMonthlyAllowance(plan, { monthlyRemaining, fiveHourCap, weeklyCap }) {
  const allowance = plan?.monthlyCreditsUsd ?? null;
  if (allowance === null || allowance <= 0) return null;
  if (monthlyRemaining > allowance) return null;
  if (fiveHourCap === null || weeklyCap === null) return null;
  if (fiveHourCap !== plan.fiveHourCapUsd) return null;
  if (weeklyCap !== plan.weeklyCapUsd) return null;
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
  // It also gets its own abort, so a credits call that fails fast — a 401, say —
  // reports that immediately instead of waiting out the enrichment deadline for
  // an answer it is about to discard.
  const subscriptionAbort = typeof AbortController === 'undefined' ? null : new AbortController();
  const subscriptionSignals = [deps.signal, subscriptionAbort?.signal].filter(Boolean);
  const creditsRequest = fetchJson(COMMANDCODE_CREDITS_URL, cookie, creditsDeadline, deps);
  const subscriptionRequest = fetchJson(
    COMMANDCODE_SUBSCRIPTIONS_URL,
    cookie,
    subscriptionDeadline,
    deps,
    subscriptionSignals.length > 1 ? AbortSignal.any(subscriptionSignals) : subscriptionSignals[0]
  )
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
          fiveHourCap: credits.fiveHour?.limit ?? null,
          weeklyCap: credits.weekly?.limit ?? null
        }),
        periodEnd: subscription?.currentPeriodEnd || null
      })
    ].filter(Boolean);
    return normalizeLimitProvider({
      provider: 'commandcode',
      accountKey: hashKey('commandcode', subscription?.accountId || commandcodeAccountSeed(cookie)),
      accountLabel: plan?.label || '',
      source: 'web',
      status: 'ok',
      updatedAt,
      windows
    });
  } catch (error) {
    // Anything landing here came from the credits call or from parsing it — the
    // optional read swallows its own failures. Cancel it rather than awaiting
    // it: its result is unusable now, and it already handles its own rejection.
    subscriptionAbort?.abort();
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
  COMMANDCODE_FORWARDED_COOKIE_NAMES,
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
