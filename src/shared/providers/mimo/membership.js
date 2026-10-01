'use strict';

const { planLabelFromParts } = require('../../limits/providerHelpers');
const { MIMO_DESKTOP_MEMBERSHIP_PRODUCT } = require('../../limits/windowLabels');
const { throwIfAborted } = require('../../abortSignal');
const { mimoEndpointIso } = require('./endpointTime');
const { mintMimoServiceSession, mimoExchangeStatus } = require('./session');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

// The only host the app's region table carries; a region it does not carry
// resolves no base URL there either.
const MIMO_MEMBERSHIP_BASE_URL = 'https://mimo-server-cn.xiaomimimo.com/api';
const MIMO_MEMBERSHIP_ENTRY = '/user/xiaomi/me';
const MIMO_SUBSCRIPTION_ENTRY = '/user/xiaomi/subscription/self';
const MIMO_MEMBERSHIP_REGION = 'CN';

// Desktop's billing.planTier names; Console Token Plan labels come from its API.
const MIMO_MEMBERSHIP_TIERS = Object.freeze({ 1: 'Starter', 2: 'Plus', 3: 'Pro', 4: 'Ultra' });

// Product identity is separate from the subscription's plan label.
const MIMO_MEMBERSHIP_LABEL = MIMO_DESKTOP_MEMBERSHIP_PRODUCT;

// The app's schema and its success condition. No `current` means no active
// subscription, which is an answer rather than a failure, and `percent` is a
// *remaining* share — the opposite of the console lane's used ratio.
function readMimoMembershipPlan(body) {
  const data = body && typeof body === 'object' && (Object.hasOwn(body, 'data') || Object.hasOwn(body, 'code'))
    ? body.data
    : body;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false };
  const current = data.current;
  // Desktop treats both an omitted current and null as no subscription.
  if (current == null) return { ok: true, plan: null };
  if (typeof current !== 'object' || Array.isArray(current)) return { ok: false };
  if (typeof current.planCode !== 'string' || !current.planCode
    || !Number.isInteger(current.planTier)
    || typeof current.endTime !== 'string' || !current.endTime
    || typeof current.nextResetTime !== 'string' || !current.nextResetTime) return { ok: false };
  const percent = current.percent;
  const resetsAt = mimoEndpointIso(current.nextResetTime);
  if (!Number.isFinite(percent) || percent < 0 || !resetsAt) return { ok: false };
  return {
    ok: true,
    plan: {
      tier: current.planTier,
      // Unknown tiers retain the vendor's planCode as the label fallback.
      code: current.planCode,
      source: typeof current.source === 'string' ? current.source : '',
      percent: Math.min(100, percent),
      resetsAt
    }
  };
}

// The app excludes an invited subscription from the current-plan card while it
// still renders that subscription's usage. Mirror that split: the quota window
// remains, but no plan name is invented. A regular tier outside the known table
// falls back to the vendor's own planCode.
function mimoMembershipPlanLabel(plan) {
  if (plan?.source === 'INVITE') return '';
  return planLabelFromParts(MIMO_MEMBERSHIP_TIERS[plan?.tier], plan?.code) || '';
}

// 401 is this app's own auth-expired signal for these calls; anything else that
// is not OK is its `failed` — an attempt that failed, not a credential to
// replace. The distinction is the app's, which is why `statusForHttp` (401/403 →
// unauthorized) is not the rule here.
function membershipStatusForHttp(status) {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'sourceRateLimited';
  return 'unavailable';
}

// The session is already minted here, so the cookie goes straight to the
// membership host with the smaller header set the live probes used — the
// console's `Origin`/`Referer` name a host this request never touches.
async function requestMimoMembership(pathname, cookieHeader, deps = {}) {
  const response = await (deps.fetch || globalThis.fetch)(`${MIMO_MEMBERSHIP_BASE_URL}${pathname}`, {
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    headers: { Cookie: cookieHeader, Accept: 'application/json', 'User-Agent': BROWSER_USER_AGENT },
    signal: deps.signal
  });
  const status = Number(response.status);
  if (status !== 200) {
    const error = new Error(`MiMo membership request failed: HTTP ${status}`);
    error.status = membershipStatusForHttp(status);
    throw error;
  }
  const body = await response.json();
  // A body without the app's exact success code has no usable data. It is not
  // evidence that the credential expired.
  if (body?.code !== 0) {
    const error = new Error('MiMo membership response carried no usable data');
    error.status = 'unavailable';
    throw error;
  }
  return body;
}

// The membership lane's one credential: the account cookie the machine's own
// MiMo Desktop holds. Membership is not sold on the developer platform, so the
// console's service cookie cannot mint this session and there is no paste for
// it — a machine with no Desktop session has no membership row at all.
async function fetchMimoMembershipAccount(account, deps = {}) {
  const session = await mintMimoServiceSession({
    baseUrl: MIMO_MEMBERSHIP_BASE_URL,
    entry: MIMO_MEMBERSHIP_ENTRY,
    accountCookie: account.cookieHeader,
    deps
  });
  if (!session.ok) return { ok: false, status: mimoExchangeStatus(session.status), userId: account.userId };
  // A region the app does not carry has no endpoint at all, so the lane goes
  // quiet rather than aiming at a host that belongs to someone else's account.
  // An *absent* region is not evidence of a foreign account — the call proceeds
  // and the endpoint answers for itself.
  const region = String(session.region || '').trim().toUpperCase();
  if (region && region !== MIMO_MEMBERSHIP_REGION) {
    return { ok: false, status: 'notConfigured', userId: session.userId };
  }
  return readMimoMembershipPlanFor(session.cookieHeader, session.userId, deps);
}

async function readMimoMembershipPlanFor(cookieHeader, userId, deps = {}) {
  try {
    const body = await requestMimoMembership(MIMO_SUBSCRIPTION_ENTRY, cookieHeader, deps);
    const read = readMimoMembershipPlan(body);
    if (!read.ok) {
      const error = new Error('MiMo membership payload is unreadable');
      error.status = 'unavailable';
      throw error;
    }
    return { ok: true, userId, plan: read.plan };
  } catch (error) {
    throwIfAborted(deps.signal);
    return { ok: false, status: error?.status || 'unavailable', userId };
  }
}

// Desktop's weekly card reads this subscription's percent and nextResetTime.
// The shared weekly label names the window; renewalMode names billing cadence,
// not this quota. Keep the server's reset time without inventing a duration.
function mimoMembershipWindows(plan) {
  if (!plan) return [];
  return [{
    kind: 'weekly',
    usedPercent: Math.max(0, 100 - plan.percent),
    resetsAt: plan.resetsAt
  }];
}

module.exports = {
  MIMO_MEMBERSHIP_LABEL,
  fetchMimoMembershipAccount,
  mimoMembershipPlanLabel,
  mimoMembershipWindows,
  readMimoMembershipPlan
};
