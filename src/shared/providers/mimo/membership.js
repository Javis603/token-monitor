'use strict';

const { throwIfAborted } = require('../../abortSignal');
const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const { cleanSecret } = require('../../limits/providerHelpers');
const { mimoEndpointIso } = require('./endpointTime');
const { MIMO_EXCHANGE_STATUSES, exchangeMimoServiceSession } = require('./ssoExchange');
const { MIMO_ACCOUNT_COOKIE_NAMES, MIMO_DESKTOP_READ_REASONS, readMimoDesktopAccount } = require('./desktopSession');

// The membership base is the only host the app's region table carries; a region
// it does not carry resolves no base URL there either, so there is nothing to
// reach for such an account — see `mimoMembershipBaseUrl`.
const MIMO_MEMBERSHIP_BASE_URL = 'https://mimo-server-cn.xiaomimimo.com/api';
const MIMO_MEMBERSHIP_REGION = 'CN';
const MIMO_MEMBERSHIP_ACCOUNT = 'membership';
// What this lane is, for a row no plan names. Xiaomi's own word for it — the
// app's own copy reads `未开通会员或会员已到期`.
const MIMO_MEMBERSHIP_LABEL = 'Membership';

// Xiaomi's own plan names, from the app's `billing.planTier` map, which is what
// its own panel renders — `planTier` first and `planCode` only when the tier is
// outside this range. The codes are internal (`mimo-cn-pro`), so a tier this map
// does not know falls back to the lane name rather than to one.
const MIMO_MEMBERSHIP_TIERS = Object.freeze({
  1: 'Starter',
  2: 'Plus',
  3: 'Pro',
  4: 'Ultra'
});

function mimoMembershipPlanLabel(plan) {
  const tier = Number(plan?.tier);
  return Number.isInteger(tier) && MIMO_MEMBERSHIP_TIERS[tier]
    ? MIMO_MEMBERSHIP_TIERS[tier]
    : MIMO_MEMBERSHIP_LABEL;
}

// The app's own card is the weekly usage limit, reset by the plan's next reset.
const MIMO_MEMBERSHIP_WINDOW_MINUTES = 7 * 24 * 60;

function cookiePairs(value) {
  const pairs = new Map();
  for (const part of String(value || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (!name || !cookieValue) continue;
    pairs.set(name, cookieValue);
  }
  return pairs;
}

function mimoMembershipAccountKey(userId) {
  const identity = cleanSecret(userId);
  if (!identity) return '';
  // Distinct from the console lane's `hashKey("mimo:" + userId)` on purpose: a
  // Desktop membership and an open-platform console session are two products of
  // one account, and they are two rows. This is the shape
  // `providers/volcengine` gives its Agent Plan, and for the reason stated
  // there — `provider:accountKey` dedupe then keeps both rows instead of letting
  // one overwrite the other.
  return hashKey('mimo', identity, MIMO_MEMBERSHIP_ACCOUNT);
}

// The app's schema and the app's success condition. `current` absent means no
// active subscription, which is an answer rather than a failure, and `percent`
// is a *remaining* share — the opposite of the console lane's used ratio, so its
// normalisation is not shared with that lane.
function readMimoMembershipPlan(body) {
  const data = body && typeof body === 'object' && body.data && typeof body.data === 'object'
    ? body.data
    : body;
  if (!data || typeof data !== 'object') return { ok: false };
  const current = data.current;
  if (current === null || current === undefined) return { ok: true, plan: null };
  if (typeof current !== 'object' || Array.isArray(current)) return { ok: false };
  const percent = current.percent;
  const resetsAt = mimoEndpointIso(current.nextResetTime);
  if (!Number.isFinite(percent) || percent < 0 || !resetsAt) return { ok: false };
  return {
    ok: true,
    plan: {
      tier: current.planTier,
      percent: Math.min(100, percent),
      resetsAt
    }
  };
}

function mimoMembershipStatusForHttp(status) {
  // 401 is this app's own auth-expired signal for these calls; anything else
  // that is not OK is its `failed`, an attempt that failed rather than a
  // credential the user has to replace — the distinction `providers/cline`
  // keeps when it refuses to read a 403 as a credential problem.
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'sourceRateLimited';
  return 'unavailable';
}

// A region the app does not carry has no endpoint at all, so the lane goes quiet
// rather than aiming at a host that belongs to someone else's account. An absent
// region is not evidence of a foreign account: the call proceeds, and the
// endpoint answers for itself.
function mimoMembershipBaseUrl(region) {
  const normalized = String(region || '').trim().toUpperCase();
  if (normalized && normalized !== MIMO_MEMBERSHIP_REGION) return '';
  return MIMO_MEMBERSHIP_BASE_URL;
}

function membershipRow(status, updatedAt, extra = {}) {
  return normalizeLimitProvider({
    provider: 'mimo',
    source: 'oauth',
    // `app` is this repository's marker for a session read out of an installed
    // application's own store, and `managed` for one this application holds —
    // the split codex and workbuddy draw, and what tells the renderer whether the
    // row is backed by a live local login.
    sourceDetail: extra.sourceDetail || 'app',
    status,
    updatedAt,
    accountKey: extra.accountKey || '',
    accountLabel: extra.accountLabel || MIMO_MEMBERSHIP_LABEL,
    windows: extra.windows || []
  });
}

async function requestMimoMembership(pathname, cookieHeader, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const response = await fetchFn(`${MIMO_MEMBERSHIP_BASE_URL}${pathname}`, {
    method: 'GET',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, Accept: 'application/json' },
    signal: deps.signal
  });
  const status = Number(response.status);
  if (status !== 200) {
    const error = new Error(`MiMo membership request failed: HTTP ${status}`);
    error.status = mimoMembershipStatusForHttp(status);
    throw error;
  }
  const body = await response.json();
  const bodyCode = Number(body?.code);
  if (Number.isFinite(bodyCode) && bodyCode !== 0) {
    // A body carrying a non-zero code is this app's own `no-data`: the endpoint
    // answered, there is simply nothing to show. It is not a credential problem
    // and must not be reported as one.
    const error = new Error('MiMo membership response carried no usable data');
    error.status = 'unavailable';
    throw error;
  }
  return body;
}

// Reads the account cookie the signed-in app already holds, or reports why it
// could not. An absent or unreadable store is nothing configured; a store that
// reads and carries half a sign-in is an app the user is signed out of, which is
// the distinction `readCodexOAuthAuth` draws.
function readMimoDesktopAccountCredential(deps = {}) {
  const read = deps.readMimoDesktopAccount || readMimoDesktopAccount;
  const result = read({ ...(deps.desktopSessionOptions || {}) });
  if (result?.ok) return { cookieHeader: result.cookieHeader, userId: result.userId };
  // A store that reads and carries half a sign-in is an app the user is signed
  // out of, which is the distinction `readCodexOAuthAuth` draws: "MiMo Desktop
  // is not installed here" and "it is installed and signed out" call for
  // different answers, and only the store can tell them apart. The others
  // (absent, unreadable, unsupported platform) are nothing configured. Both
  // lanes read all of this the same way.
  if (result?.reason === MIMO_DESKTOP_READ_REASONS.incomplete) {
    const error = new Error('MiMo Desktop session is incomplete');
    error.status = 'unauthorized';
    error.userId = cleanSecret(result.userId);
    throw error;
  }
  return { cookieHeader: '' };
}

// Resolves the session this lane talks through. A credential the user configured
// wins and is never exchanged away, which is the rule `providers/cline` states
// for the same situation: a key the user set is their instruction, while the
// local store is another application's.
async function resolveMimoMembershipSession(options = {}, deps = {}) {
  const configured = cleanSecret(options.mimoMembershipCookie || deps.mimoMembershipCookie);
  const discovered = configured ? null : readMimoDesktopAccountCredential(deps);
  const cookieHeader = configured || discovered?.cookieHeader || '';
  if (!cookieHeader) return { ok: false, absent: true };
  const sourceDetail = configured ? 'managed' : 'app';

  const pairs = cookiePairs(cookieHeader);
  const accountCookie = MIMO_ACCOUNT_COOKIE_NAMES
    .filter((name) => pairs.has(name))
    .map((name) => `${name}=${pairs.get(name)}`)
    .join('; ');
  // An account cookie is spent on the chain to become a session; one the service
  // already minted is usable as it stands, and the walk reaches the account
  // answer on its first hop.
  const exchanged = await exchangeMimoServiceSession({
    baseUrl: MIMO_MEMBERSHIP_BASE_URL,
    accountCookie: pairs.has('passToken') ? accountCookie : '',
    serviceCookie: pairs.has('passToken') ? '' : cookieHeader,
    request: deps.mimoRequest,
    signal: deps.signal,
    maxHops: deps.maxHops
  });
  if (!exchanged.ok) {
    // A refusal before the account answers leaves the row without a name to hang
    // on. The credential's own `userId` is the same server-issued id the exchange
    // would have returned, and a row with no identity at all would be read by the
    // runtime as the whole provider's rather than one account's.
    return {
      ok: false,
      status: exchanged.status,
      sourceDetail,
      userId: pairs.get('userId') || discovered?.userId || ''
    };
  }
  return {
    ok: true,
    userId: exchanged.userId,
    region: exchanged.region,
    cookieHeader: exchanged.cookieHeader,
    sourceDetail
  };
}

async function fetchMimoMembershipLimits(options = {}, deps = {}) {
  const updatedAt = new Date((deps.now || Date.now)()).toISOString();
  let session;
  try {
    session = await resolveMimoMembershipSession(options, deps);
  } catch (error) {
    throwIfAborted(deps.signal);
    const status = error?.status || 'unavailable';
    const accountKey = error?.userId ? mimoMembershipAccountKey(error.userId) : '';
    // Nothing to attribute it to: a provider-wide row would be read as the whole
    // provider's and smeared onto the console lane's accounts.
    if (status === 'unauthorized' && !accountKey) return [];
    return [membershipRow(status, updatedAt, { accountKey })];
  }

  // No credential and nothing discoverable: the lane is simply not there, so it
  // reports no row at all rather than a not-configured one a machine with no MiMo
  // Desktop could not act on.
  if (!session.ok) {
    if (session.absent) return [];
    const accountKey = session.userId ? mimoMembershipAccountKey(session.userId) : '';
    // Nothing to attribute the failure to: a provider-wide row would be read as
    // the whole provider's and smeared onto the console lane's accounts.
    if (!accountKey) return [];
    const refused = session.status === MIMO_EXCHANGE_STATUSES.rejected;
    return [membershipRow(refused ? 'unauthorized' : 'unavailable', updatedAt, {
      accountKey,
      sourceDetail: session.sourceDetail
    })];
  }

  const baseUrl = mimoMembershipBaseUrl(session.region);
  if (!baseUrl) return [];

  const accountKey = session.userId ? mimoMembershipAccountKey(session.userId) : '';
  if (!accountKey) return [];
  try {
    const body = await requestMimoMembership('/user/xiaomi/subscription/self', session.cookieHeader, deps);
    const read = readMimoMembershipPlan(body);
    if (!read.ok) throw Object.assign(new Error('MiMo membership payload is unreadable'), { status: 'unavailable' });
    if (!read.plan) {
      return [membershipRow('unavailable', updatedAt, { accountKey, sourceDetail: session.sourceDetail })];
    }
    return [membershipRow('ok', updatedAt, {
      accountKey,
      accountLabel: mimoMembershipPlanLabel(read.plan),
      sourceDetail: session.sourceDetail,
      windows: [{
        kind: 'weekly',
        windowMinutes: MIMO_MEMBERSHIP_WINDOW_MINUTES,
        usedPercent: Math.max(0, 100 - read.plan.percent),
        resetsAt: read.plan.resetsAt
      }]
    })];
  } catch (error) {
    // A cancellation is the caller's and must reject rather than be reported as
    // an outage that never happened.
    throwIfAborted(deps.signal);
    return [membershipRow(error?.status || 'unavailable', updatedAt, {
      accountKey,
      sourceDetail: session.sourceDetail
    })];
  }
}

module.exports = {
  MIMO_MEMBERSHIP_BASE_URL,
  MIMO_MEMBERSHIP_LABEL,
  MIMO_MEMBERSHIP_TIERS,
  mimoMembershipPlanLabel,
  MIMO_MEMBERSHIP_WINDOW_MINUTES,
  fetchMimoMembershipLimits,
  mimoMembershipAccountKey,
  mimoMembershipBaseUrl,
  readMimoMembershipPlan
};
