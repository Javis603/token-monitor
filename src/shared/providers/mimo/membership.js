'use strict';

const { planLabelFromParts } = require('../../limits/providerHelpers');
const { mimoEndpointIso } = require('./endpointTime');
const { mintMimoServiceSession, mimoExchangeStatus } = require('./session');
const { MIMO_ACCOUNT_COOKIE_NAMES } = require('./desktop');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

// The only host the app's region table carries; a region it does not carry
// resolves no base URL there either.
const MIMO_MEMBERSHIP_BASE_URL = 'https://mimo-server-cn.xiaomimimo.com/api';
const MIMO_MEMBERSHIP_ENTRY = '/user/xiaomi/me';
const MIMO_SUBSCRIPTION_ENTRY = '/user/xiaomi/subscription/self';
const MIMO_MEMBERSHIP_REGION = 'CN';

// The app's own card is the weekly usage limit, reset by the plan's next reset.
const MIMO_MEMBERSHIP_WINDOW_MINUTES = 7 * 24 * 60;

// Xiaomi's own plan names, from the app's `billing.planTier` map — the map its
// panel renders. The codes are internal (`mimo-cn-pro`), and a tier outside this
// range has no name to give.
const MIMO_MEMBERSHIP_TIERS = Object.freeze({ 1: 'Starter', 2: 'Plus', 3: 'Pro', 4: 'Ultra' });

// What this lane is called when no plan names it: a product name in the plan
// column, the shape opencode gives Go and Zen and volcengine its two plans.
const MIMO_MEMBERSHIP_LABEL = 'Membership';

// What the exchange mints here; `mimopc` is the app's service id for this host.
const MIMO_MEMBERSHIP_SERVICE_COOKIE_NAMES = Object.freeze(['serviceToken', 'mimopc_ph', 'userId']);

function cookiePairs(value) {
  const pairs = new Map();
  for (const part of String(value || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (name && cookieValue) pairs.set(name, cookieValue);
  }
  return pairs;
}

// Two credential shapes, and they are not interchangeable: an account cookie is
// spent on the exchange, a service cookie is already the session it would have
// minted. Anything else would let a console credential — a different service's —
// read as a membership one.
function mimoMembershipCredential(value) {
  const pairs = cookiePairs(String(value || '').replace(/^cookie\s*:\s*/i, ''));
  const userId = pairs.get('userId') || '';
  const account = MIMO_ACCOUNT_COOKIE_NAMES.every((name) => pairs.has(name));
  const service = pairs.has('serviceToken') && Boolean(userId);
  if (!account && !service) return null;
  const names = account ? MIMO_ACCOUNT_COOKIE_NAMES : MIMO_MEMBERSHIP_SERVICE_COOKIE_NAMES;
  return {
    kind: account ? 'account' : 'service',
    userId,
    cookieHeader: names.filter((name) => pairs.has(name))
      .map((name) => `${name}=${pairs.get(name)}`).join('; ')
  };
}

// The app's schema and its success condition. No `current` means no active
// subscription, which is an answer rather than a failure, and `percent` is a
// *remaining* share — the opposite of the console lane's used ratio.
function readMimoMembershipPlan(body) {
  const data = body && typeof body === 'object' && body.data && typeof body.data === 'object'
    ? body.data
    : body;
  if (!data || typeof data !== 'object') return { ok: false };
  const current = data.current;
  // `== null` is the app's own test, and it is the loose one: a payload that
  // omits `current` entirely is the same answer as one that states it as null.
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
      source: typeof current.source === 'string' ? current.source : '',
      percent: Math.min(100, percent),
      resetsAt
    }
  };
}

// The app's own plan name: an invited subscription is named `INVITE` rather than
// by its tier — the literal the app prints for one — a tier inside the map is
// named by it, and a tier outside it has no name.
function mimoMembershipPlanLabel(plan) {
  if (plan?.source === 'INVITE') return 'INVITE';
  return planLabelFromParts(MIMO_MEMBERSHIP_TIERS[plan?.tier]) || '';
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

// One membership account's answer, or the refusal that says which kind it was.
async function fetchMimoMembershipAccount(credential, deps = {}) {
  const session = await mintMimoServiceSession({
    baseUrl: MIMO_MEMBERSHIP_BASE_URL,
    entry: MIMO_MEMBERSHIP_ENTRY,
    accountCookie: credential.kind === 'account' ? credential.cookieHeader : '',
    serviceCookie: credential.kind === 'service' ? credential.cookieHeader : '',
    deps
  });
  if (!session.ok) return { ok: false, status: mimoExchangeStatus(session.status), userId: credential.userId };
  // A region the app does not carry has no endpoint, so the lane goes quiet.
  if (String(session.region || '').trim().toUpperCase() !== MIMO_MEMBERSHIP_REGION) {
    return { ok: false, status: 'unavailable', userId: session.userId };
  }

  try {
    const body = await requestMimoMembership(MIMO_SUBSCRIPTION_ENTRY, session.cookieHeader, deps);
    const read = readMimoMembershipPlan(body);
    if (!read.ok) {
      const error = new Error('MiMo membership payload is unreadable');
      error.status = 'unavailable';
      throw error;
    }
    return { ok: true, userId: session.userId, plan: read.plan };
  } catch (error) {
    return { ok: false, status: error?.status || 'unavailable', userId: session.userId };
  }
}

// The plan's own usage card: one weekly window, `percent` being the share left.
function mimoMembershipWindows(plan) {
  if (!plan) return [];
  return [{
    kind: 'weekly',
    windowMinutes: MIMO_MEMBERSHIP_WINDOW_MINUTES,
    usedPercent: Math.max(0, 100 - plan.percent),
    resetsAt: plan.resetsAt
  }];
}

module.exports = {
  MIMO_MEMBERSHIP_LABEL,
  fetchMimoMembershipAccount,
  mimoMembershipCredential,
  mimoMembershipPlanLabel,
  mimoMembershipWindows,
  readMimoMembershipPlan
};
