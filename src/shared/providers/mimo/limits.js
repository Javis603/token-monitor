'use strict';

const crypto = require('node:crypto');
const { throwIfAborted } = require('../../abortSignal');
const { hashKey } = require('../../hashKey');
const { MIMO_CONSOLE_PRODUCT } = require('../../limitWindowLabels');
const { normalizeLimitProvider } = require('../../limits/core');
const { nowIso, providerStatusFromError } = require('../../limits/providerHelpers');
const { MIMO_CONSOLE_URL, mimoRequestHeaders } = require('./browserHeaders');
const { mimoEndpointTime } = require('./endpointTime');
const { readMimoDesktopAccount } = require('./desktop');
const { mintMimoServiceSession, mimoExchangeStatus, readConsoleStatus } = require('./session');
const {
  MIMO_MEMBERSHIP_LABEL,
  fetchMimoMembershipAccount,
  mimoMembershipPlanLabel,
  mimoMembershipWindows
} = require('./membership');

const MIMO_PLATFORM_CONSOLE_URL = MIMO_CONSOLE_URL;
const MIMO_API_BASE_URL = 'https://platform.xiaomimimo.com/api/v1';
// The console product's word, from the shared display vocabulary: the renderer,
// the tray and the macOS widget all route on it.
const MIMO_CONSOLE_LABEL = MIMO_CONSOLE_PRODUCT;
// The endpoint the console exchange asks first. With no session it answers 401
// and names the login URL to visit; with one it answers the wallet.
const MIMO_CONSOLE_ENTRY = '/balance';
const MIMO_ACCOUNT_TIMEOUT_MS = 15_000;
const MIMO_ACCOUNT_METADATA_STATE_KEY = 'mimo.account-metadata';
const MIMO_DESKTOP_ROWS_STATE_KEY = 'mimo.desktop-rows';
const MIMO_UNATTRIBUTED_DESKTOP_KEY = hashKey('mimo:desktop-membership:unattributed');
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

// The membership is a second product of the same account, not a second account,
// so its row is keyed by the same `userId` with the lane it came from appended.
// One key for both would let the hub's collapse pass pick a single winner per
// account key and drop one of the two rows. The lane rather than a counter keeps
// the key stable across refreshes, which is what the runtime's identity and the
// renderer's account grouping both need.
function mimoMembershipAccountKey(userId) {
  return hashKey(`mimo:membership:${cleanText(userId)}`);
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

// MiMo reports `percent` as a 0-1 ratio, so it overshoots 1 once the request
// that exhausts the plan pushes used past limit. Inferring the scale from the
// value ("<= 1 must be a ratio, above that must already be a percentage") reads
// that 1.005 as 1% used and paints a spent plan as 99% left (#292), so treat
// the field as the ratio it is — and prefer used/limit, which carry no scale
// ambiguity at all, whenever the item reports both.
function normalizePercent(value, used, limit) {
  if (used !== null && limit !== null && limit > 0) {
    return Math.max(0, Math.min(100, (used / limit) * 100));
  }
  const explicit = numberFrom(value);
  if (explicit === null) return null;
  return Math.max(0, Math.min(100, explicit * 100));
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
    email: cleanText(data.email ?? data.platformEmail).slice(0, 254),
    name: cleanText(data.nickName ?? data.userName).slice(0, 128)
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
  const parsedEnd = rawEnd ? mimoEndpointTime(rawEnd) : NaN;
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

// The console's own usage summary: `costUsage` is provider-reported money spent,
// all-time and for the current month. The API has no daily rollup — the per-call
// ledger behind this is a paginated POST — so these two are what a row can state
// without being tracked locally, and a spend figure that is not reported is left
// absent rather than derived here.
function parseMimoSpend(body) {
  const data = unwrapApiBody(body);
  const cost = data.costUsage ?? data.cost_usage ?? {};
  const allTimeSpend = numberFrom(cost.totalCost ?? cost.total_cost);
  const monthSpend = numberFrom(cost.currentMonthCost ?? cost.current_month_cost);
  return {
    ...(allTimeSpend === null ? {} : { allTimeSpend }),
    ...(monthSpend === null ? {} : { monthSpend })
  };
}

async function requestMimo(pathname, cookieHeader, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const response = await fetchFn(`${MIMO_API_BASE_URL}${pathname}`, {
    headers: mimoRequestHeaders(cookieHeader),
    redirect: 'manual',
    credentials: 'omit',
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
    // A credential the user entered is `managed`; a session the machine's own
    // MiMo Desktop mints is `app` — the split codex and workbuddy draw, and what
    // tells the renderer whether the row is backed by a live local login.
    source: cleanText(account.source) || 'web',
    sourceDetail: cleanText(account.sourceDetail) || 'managed',
    status,
    updatedAt,
    accountKey: account.accountKey,
    accountName: account.accountName,
    accountEmail: account.accountEmail,
    accountLabel: account.accountLabel,
    planLabel: account.planLabel,
    windows: []
  });
}

async function fetchMimoAccount(account, deps = {}) {
  const updatedAt = nowIso((deps.now || Date.now)());
  const cookieHeader = normalizeMimoCookieHeader(account.cookieHeader);
  if (!cookieHeader) return statusProvider('notConfigured', updatedAt, account);
  try {
    const [balanceBody, profileBody, detailBody, usageBody, spendBody] = await Promise.all([
      requestMimo('/balance', cookieHeader, deps),
      requestMimo('/userProfile', cookieHeader, deps).catch(() => null),
      requestMimo('/tokenPlan/detail', cookieHeader, deps).catch(() => null),
      requestMimo('/tokenPlan/usage', cookieHeader, deps).catch(() => null),
      // Spend is enrichment: a console that does not answer it still has a wallet.
      requestMimo('/usage', cookieHeader, deps).catch(() => null)
    ]);
    throwIfAborted(deps.signal);
    const balance = parseMimoBalance(balanceBody);
    if (balance.amount === null) throw new Error('MiMo balance response is missing a balance');
    const profile = parseMimoProfile(profileBody);
    const accountEmail = profile.email || cleanText(account.accountEmail);
    const detail = parseMimoPlanDetail(detailBody, (deps.now || Date.now)());
    const usage = parseMimoPlanUsage(usageBody);
    const spend = parseMimoSpend(spendBody);
    const windows = [];
    const hasActiveTokenPlan = detail.active;
    const hasTokenPlanQuota = hasActiveTokenPlan && usage.limit !== null && usage.limit > 0;
    const hasExpiredTokenPlan = detail.expired && Boolean(detail.label || (usage.limit !== null && usage.limit > 0));
    if (hasTokenPlanQuota) {
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
    // The wallet balance is money, not a metered quota, so it ships as a
    // credits window with no wire percentage — it sits beside the Token Plan
    // rather than replacing it.
    if (balance.amount !== null) {
      windows.push({
        kind: 'billing',
        metric: 'credits',
        label: 'Balance',
        remaining: balance.amount,
        currency: balance.currency
      });
    }
    const planLabel = hasActiveTokenPlan || hasExpiredTokenPlan
      ? (detail.label || 'Token Plan')
      : 'Pay-as-you-go';
    return normalizeLimitProvider({
      provider: 'mimo',
      source: cleanText(account.source) || 'web',
      sourceDetail: cleanText(account.sourceDetail) || 'managed',
      status: 'ok',
      updatedAt,
      accountKey: cleanText(account.accountKey) || mimoAccountKey(cookieHeader),
      accountName: profile.name || cleanText(account.accountName),
      accountEmail,
      accountLabel: MIMO_CONSOLE_LABEL,
      planLabel,
      windows,
      balance: {
        ...balance,
        // What the console reports as spent. The row's meter percentage is
        // derived from these at display time (`balance / (balance + monthSpend)`,
        // the same rule deepseek's wallet follows) and never travels the wire.
        ...spend,
        planStatus: hasExpiredTokenPlan ? 'expired' : null,
        planUsed: hasTokenPlanQuota ? usage.used : null,
        planLimit: hasTokenPlanQuota ? usage.limit : null,
        planPercent: hasTokenPlanQuota ? usage.usedPercent : null
      }
    });
  } catch (error) {
    throwIfAborted(deps.signal);
    const status = error?.code === 'MIMO_UNAUTHORIZED'
      ? 'unauthorized'
      : error?.code === 'MIMO_RATE_LIMITED' ? 'sourceRateLimited' : 'unavailable';
    return statusProvider(status, updatedAt, account);
  }
}

async function runMimoAccountTaskWithTimeout(run, fallback, deps = {}) {
  const timeoutMs = Number(deps.accountTimeoutMs ?? MIMO_ACCOUNT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return run(deps.signal);
  const AbortControllerImpl = deps.AbortController || globalThis.AbortController;
  const controller = AbortControllerImpl ? new AbortControllerImpl() : null;
  const signal = controller?.signal && deps.signal
    ? AbortSignal.any([controller.signal, deps.signal])
    : controller?.signal || deps.signal;
  throwIfAborted(signal);
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimer(() => {
      controller?.abort();
      resolve(fallback());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      run(signal),
      timeout
    ]);
  } finally {
    if (timer) clearTimer(timer);
  }
}

async function fetchMimoAccountWithTimeout(account, deps = {}) {
  return runMimoAccountTaskWithTimeout(
    (signal) => fetchMimoAccount(account, { ...deps, signal }),
    () => statusProvider('unavailable', new Date((deps.now || Date.now)()).toISOString(), account),
    deps
  );
}

function normalizeMimoManagedAccounts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const accounts = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || item.enabled === false) continue;
    const cookieHeader = normalizeMimoCookieHeader(item.cookieHeader);
    // An account whose credential cannot be read is still an account: it keeps
    // its saved key and answers for itself with a not-configured row, rather than
    // disappearing and leaving the provider to answer for the whole lane.
    const accountKey = cleanText(item.accountKey) || (cookieHeader ? mimoAccountKey(cookieHeader) : '');
    if (!accountKey) continue;
    if (seen.has(accountKey)) continue;
    seen.add(accountKey);
    accounts.push({ ...item, accountKey, cookieHeader });
  }
  return accounts;
}

function scopedMimoManagedAccounts(value, scope) {
  const accounts = normalizeMimoManagedAccounts(value);
  if (!scope) return accounts;
  const hasAccountIdentifier = Boolean(
    scope.accountKey || scope.accountEmail || scope.accountLabel
  );
  if (!hasAccountIdentifier && accounts.length > 1) {
    throw new TypeError('MiMo limit refresh scope requires an account identifier when multiple accounts are configured');
  }
  return accounts.filter((account) => {
    if (scope.accountKey) return account.accountKey === scope.accountKey;
    if (scope.accountEmail) return account.accountEmail === scope.accountEmail;
    if (scope.accountLabel) return account.accountLabel === scope.accountLabel;
    return true;
  });
}

// Show a discovered console account beside saved accounts, unless its identity
// is already saved. The discovered account is never removable here.
function withDetectedMimoAccount(storedAccounts = [], detected = null) {
  const accounts = storedAccounts.map((account) => ({ ...account, removable: true }));
  if (!detected?.accountKey) return accounts;
  if (accounts.some((account) => account.accountKey === detected.accountKey)) return accounts;
  return [...accounts, { ...detected, removable: false }];
}

function readMimoDesktopSession(deps = {}) {
  try {
    const read = (deps.readMimoDesktopAccount || readMimoDesktopAccount)(
      { ...(deps.desktopSessionOptions || {}) }
    );
    return { ok: true, userId: cleanText(read.userId), cookieHeader: read.cookieHeader };
  } catch (error) {
    return {
      ok: false,
      status: providerStatusFromError(error),
      userId: cleanText(error?.userId),
      cookieHeader: ''
    };
  }
}

// A scope names one row of one account. A console credential and a Desktop
// session that report the same `userId` share an entry, so both of that entry's
// keys match here — the console key is the account's, the membership key carries
// its lane. Only a stored account carries the two names a scope can also match
// on; a discovered one has no identity but the key the runtime scopes by.
function entryMatchesScope(entry, scope) {
  if (!scope) return true;
  if (scope.accountKey) return scope.accountKey === entry.accountKey || scope.accountKey === entry.membershipKey;
  const account = entry.console?.account;
  if (scope.accountEmail) return Boolean(account) && account.accountEmail === scope.accountEmail;
  if (scope.accountLabel) return Boolean(account) && account.accountLabel === scope.accountLabel;
  return true;
}

// Every console credential names one account, keyed as `mimo:<userId>`, so a
// pasted cookie, a saved account and the session the machine's own MiMo Desktop
// mints are three credentials for one identity — not three rows. The membership
// rides the same entry and keys its own row off the lane.
//
// Discovery needs no precedence rule: a credential the user entered occupies its
// own account's entry and the machine's session fills only the entries still
// empty, which is what keeps a saved account's credential and puts a *different*
// Desktop account beside it rather than behind it.
function collectMimoCredentials(options, deps, scope, desktop) {
  const entries = new Map();
  const byUser = new Map();
  const entryFor = (userId, preferredKey = '') => {
    const identity = cleanText(userId);
    if (identity && byUser.has(identity)) return byUser.get(identity);
    const accountKey = preferredKey || (identity ? mimoAccountKey('', { userId: identity }) : '');
    if (!accountKey) return null;
    const entry = entries.get(accountKey) || {
      accountKey,
      membershipKey: identity ? mimoMembershipAccountKey(identity) : '',
      userId: identity,
      console: null,
      membership: null
    };
    // A saved account can reach here with only its stable key when the
    // credential store is temporarily unreadable. If Desktop identifies that
    // same key later in the tick, complete the lane identity instead of reusing
    // the console key for membership and letting aggregation collapse a row.
    if (identity && !entry.userId) {
      entry.userId = identity;
      entry.membershipKey = mimoMembershipAccountKey(identity);
    }
    entries.set(accountKey, entry);
    if (identity) byUser.set(identity, entry);
    return entry;
  };

  const stored = options.mimoManagedAccounts || deps.mimoManagedAccounts;
  // Disabling a saved console credential is an explicit choice for that
  // product. Automatic discovery may still supply the account's independent
  // membership row, but it must not silently turn the console row back on.
  const disabledConsoleKeys = new Set();
  const disabledConsoleUsers = new Set();
  for (const account of Array.isArray(stored) ? stored : []) {
    if (!account || account.enabled !== false) continue;
    const key = cleanText(account.accountKey);
    const userId = cleanText(new Map(cookiePairs(account.cookieHeader)).get('userId'));
    if (key) disabledConsoleKeys.add(key);
    if (userId) disabledConsoleUsers.add(userId);
  }
  for (const account of scopedMimoManagedAccounts(stored, scope)) {
    const entry = entryFor(new Map(cookiePairs(account.cookieHeader)).get('userId'), cleanText(account.accountKey));
    if (entry) entry.console = { account };
  }

  if (desktop.userId) {
    const entry = entryFor(desktop.userId);
    const consoleDisabled = disabledConsoleKeys.has(entry?.accountKey)
      || disabledConsoleUsers.has(desktop.userId);
    if (entry && !entry.console && !consoleDisabled) entry.console = { discovered: desktop };
    // A readable-but-incomplete Desktop session is still an attributed local
    // account. Keep the membership lane so it can carry its own unauthorized
    // state beside a healthy manually configured console row.
    if (entry) entry.membership = desktop;
  }

  return [...entries.values()].filter((entry) => entryMatchesScope(entry, scope));
}

// The console session the machine's own MiMo Desktop can mint, shaped as the
// account the console reader already spends. A session read off this machine is
// `local` + `app`, the pair workbuddy's own desktop session reports.
async function mintMimoConsoleCredential(entry, desktop, deps = {}) {
  const exchanged = await mintMimoServiceSession({
    baseUrl: MIMO_API_BASE_URL,
    entry: MIMO_CONSOLE_ENTRY,
    accountCookie: desktop.cookieHeader,
    readAnswer: readConsoleStatus,
    deps
  });
  if (!exchanged.ok) return { ok: false, status: mimoExchangeStatus(exchanged.status) };
  return {
    ok: true,
    account: {
      userId: desktop.userId,
      accountKey: entry.accountKey,
      source: 'local',
      sourceDetail: 'app',
      cookieHeader: exchanged.cookieHeader
    }
  };
}

// What this account's console credential answers with. A credential the user
// pasted is spent as it stands; the machine's own session is exchanged first.
async function fetchMimoConsoleSide(entry, deps) {
  const account = entry.console?.account;
  if (account) return { consoleRow: await fetchMimoAccountWithTimeout(account, deps) };
  const discovered = entry.console?.discovered;
  if (!discovered) return {};
  const minted = discovered.ok
    ? await mintMimoConsoleCredential(entry, discovered, deps)
    : { ok: false, status: discovered.status };
  if (!minted.ok) {
    return { consoleFailure: { status: minted.status, source: 'local', sourceDetail: 'app' } };
  }
  return { consoleRow: await fetchMimoAccountWithTimeout(minted.account, deps) };
}

async function fetchMimoMembershipSide(entry, deps) {
  const membership = entry.membership;
  if (!membership) return null;
  if (!membership.ok) {
    return { ok: false, status: membership.status || 'unavailable', userId: entry.userId };
  }
  return runMimoAccountTaskWithTimeout(
    (signal) => fetchMimoMembershipAccount(membership, { ...deps, signal }),
    () => ({ ok: false, status: 'unavailable', userId: entry.userId }),
    deps
  );
}

// One account, one row per product it holds: the platform console (wallet and
// Token Plan) and the Desktop membership. They are separate rows rather than one
// merged row because the aggregate collapses per account key — two products under
// one key would come out as one — and because each product's own answer is what
// the row above it should show: a membership lane that failed no longer has to
// speak through the wallet's row, and the wallet it never touched stays.
//
// Both rows carry one display identity for the Xiaomi account. The product and
// plan stay in their own fields, so every limits surface can render
// `account · product` without guessing from a plan name.
function mimoAccountMetadata(deps = {}) {
  if (!(deps.providerRuntimeState instanceof Map)) return null;
  let cache = deps.providerRuntimeState.get(MIMO_ACCOUNT_METADATA_STATE_KEY);
  if (!(cache instanceof Map)) {
    cache = new Map();
    deps.providerRuntimeState.set(MIMO_ACCOUNT_METADATA_STATE_KEY, cache);
  }
  return cache;
}

function previousMimoDesktopKeys(options = {}, deps = {}) {
  if (!(deps.providerRuntimeState instanceof Map)) return null;
  let keys = deps.providerRuntimeState.get(MIMO_DESKTOP_ROWS_STATE_KEY);
  if (!(keys instanceof Set)) {
    keys = new Set(
      (options.previousLimits?.providers || [])
        .filter((row) => row?.provider === 'mimo' && row?.sourceDetail === 'app' && cleanText(row.accountKey))
        .map((row) => cleanText(row.accountKey))
    );
    deps.providerRuntimeState.set(MIMO_DESKTOP_ROWS_STATE_KEY, keys);
  }
  return keys;
}

// Automatic rows may disappear while a pasted Console row still answers. The
// runtime deliberately treats an omitted identity as a transient partial read,
// so name the exact automatic identities that disappeared; its internal removal
// marker clears them without publishing a fake status row.
function appendMimoDesktopRemovals(rows, desktop, options, deps, scope) {
  if (scope) return rows;
  const previous = previousMimoDesktopKeys(options, deps);
  if (!previous) return rows;
  const terminalRead = desktop.ok || desktop.status === 'notConfigured' || desktop.status === 'unauthorized';
  if (!terminalRead) return rows;

  const represented = new Set(rows.map((row) => cleanText(row?.accountKey)).filter(Boolean));
  const next = new Set(rows
    .filter((row) => row?.sourceDetail === 'app' && row?.removed !== true)
    .map((row) => cleanText(row.accountKey))
    .filter(Boolean));
  const removals = [...previous]
    .filter((accountKey) => !represented.has(accountKey))
    .map((accountKey) => ({ provider: 'mimo', accountKey, removed: true }));
  deps.providerRuntimeState.set(MIMO_DESKTOP_ROWS_STATE_KEY, next);
  return removals.length ? [...rows, ...removals] : rows;
}

function mimoAccountSuffix(accountKey) {
  const fingerprint = cleanText(accountKey).replace(/^sha256:/i, '').replace(/[^a-z0-9]/gi, '');
  return fingerprint ? `MiMo ${fingerprint.slice(0, 7)}` : '';
}

function mimoEntryIdentity(entry, consoleRow, deps = {}) {
  const email = cleanText(consoleRow?.accountEmail || entry.console?.account?.accountEmail);
  const rawName = cleanText(consoleRow?.accountName || entry.console?.account?.accountName);
  const suffix = mimoAccountSuffix(entry.accountKey);
  const name = rawName ? [rawName, suffix].filter(Boolean).join(' · ') : suffix;
  const cache = mimoAccountMetadata(deps);
  const remembered = cache?.get(entry.accountKey);
  const identity = {
    email: email || cleanText(remembered?.email),
    name: rawName ? name : cleanText(remembered?.name) || suffix
  };
  if (identity.email || identity.name) cache?.set(entry.accountKey, identity);
  return identity;
}

function mimoRowsForEntry(entry, { consoleRow, consoleFailure, membership }, updatedAt, deps = {}) {
  const rows = [];
  // A membership-scoped refresh intentionally skips the console lane. Retain the
  // non-secret display identity learned by a prior full refresh so the product
  // remains visibly attached to the same Xiaomi account.
  const identity = mimoEntryIdentity(entry, consoleRow, deps);

  if (consoleRow) {
    rows.push({
      ...consoleRow,
      accountKey: entry.accountKey,
      accountName: identity.name,
      accountEmail: identity.email,
      accountLabel: MIMO_CONSOLE_LABEL,
      updatedAt: consoleRow.updatedAt || updatedAt
    });
  } else if (consoleFailure) {
    rows.push(statusProvider(consoleFailure.status, updatedAt, {
      accountKey: entry.accountKey,
      accountName: identity.name,
      accountEmail: identity.email,
      accountLabel: MIMO_CONSOLE_LABEL,
      source: consoleFailure.source || 'local',
      sourceDetail: consoleFailure.sourceDetail || 'app'
    }));
  }

  if (!entry.membership) return rows;
  // A region the app does not carry resolves no membership endpoint at all, so
  // the row is absent rather than mislabelled: there is nothing for this account
  // to sign in to.
  if (membership?.status === 'notConfigured') return rows;

  if (!membership?.ok) {
    return [...rows, statusProvider(membership?.status || 'unavailable', updatedAt, {
      accountKey: entry.membershipKey || entry.accountKey,
      accountName: identity.name,
      accountEmail: identity.email,
      accountLabel: MIMO_MEMBERSHIP_LABEL,
      source: 'local',
      sourceDetail: 'app'
    })];
  }

  const label = mimoMembershipPlanLabel(membership.plan);
  rows.push(normalizeLimitProvider({
    provider: 'mimo',
    source: 'local',
    sourceDetail: 'app',
    status: 'ok',
    updatedAt,
    accountKey: entry.membershipKey || entry.accountKey,
    accountName: identity.name,
    accountEmail: identity.email,
    accountLabel: MIMO_MEMBERSHIP_LABEL,
    planLabel: label,
    windows: mimoMembershipWindows(membership.plan)
  }));
  return rows;
}

function mimoLanesForScope(entry, scope) {
  if (!scope) return { console: true, membership: true };
  const key = cleanText(scope.accountKey);
  if (key) {
    return {
      console: key === entry.accountKey,
      membership: key === entry.membershipKey
    };
  }
  // Email and label are console-account selectors. A product row is scoped by
  // its stable accountKey, which is what the Limits UI and runtime emit.
  if (scope.accountEmail || scope.accountLabel) return { console: true, membership: false };
  return { console: true, membership: true };
}

// A scoped refresh names one row, and the runtime writes every row a scoped
// dispatch returns under that one identity — so this lane answers with that row
// alone. An account the scope names but this tick cannot find is not an answer
// either: publishing `not-configured` for it would blank a row that is still
// there.
function rowsForMimoScope(entry, rows, scope) {
  if (!scope) return rows;
  const key = cleanText(scope.accountKey);
  if (key) return rows.filter((row) => row.accountKey === key);
  // An email or label names the account rather than one of its products, and the
  // console row is the one those two names belong to.
  const consoleRow = rows.find((row) => row.accountKey === entry.accountKey);
  return consoleRow ? [consoleRow] : rows.slice(0, 1);
}

async function fetchMimoLimits(options = {}, deps = {}) {
  const updatedAt = nowIso((deps.now || Date.now)());
  const scope = options.limitRefreshScope?.provider === 'mimo'
    ? options.limitRefreshScope
    : null;

  // One observation of the machine's own store per tick, spent by both lanes.
  const desktop = readMimoDesktopSession(deps);
  const entries = collectMimoCredentials(options, deps, scope, desktop);
  if (!entries.length) {
    if (desktop.status === 'unavailable' || desktop.status === 'unauthorized') {
      return appendMimoDesktopRemovals(
        [statusProvider(desktop.status, updatedAt, {
          accountKey: desktop.status === 'unauthorized' ? MIMO_UNATTRIBUTED_DESKTOP_KEY : '',
          accountLabel: desktop.status === 'unauthorized' ? MIMO_MEMBERSHIP_LABEL : '',
          source: 'local',
          sourceDetail: 'app'
        })],
        desktop, options, deps, scope
      );
    }
    return appendMimoDesktopRemovals(
      scope ? [] : [statusProvider('notConfigured', updatedAt)],
      desktop, options, deps, scope
    );
  }

  const perEntry = await Promise.all(entries.map(async (entry) => {
    const lanes = mimoLanesForScope(entry, scope);
    const [consoleSide, membership] = await Promise.all([
      lanes.console ? fetchMimoConsoleSide(entry, deps) : {},
      lanes.membership ? fetchMimoMembershipSide(entry, deps) : null
    ]);
    return rowsForMimoScope(entry, mimoRowsForEntry(entry, { ...consoleSide, membership }, updatedAt, deps), scope);
  }));

  const rows = perEntry.flat();
  // A plaintext passToken without userId proves that Desktop needs a login but
  // cannot name the Xiaomi account. Keep that recovery row beside unrelated
  // manual Console accounts; otherwise a healthy wallet would hide the only
  // actionable membership failure. Transient store failures stay omitted so
  // they cannot mark healthy account rows unavailable in the shared runtime.
  if (!scope && !desktop.ok && desktop.status === 'unauthorized' && !desktop.userId) {
    rows.push(statusProvider('unauthorized', updatedAt, {
      accountKey: MIMO_UNATTRIBUTED_DESKTOP_KEY,
      accountLabel: MIMO_MEMBERSHIP_LABEL,
      source: 'local',
      sourceDetail: 'app'
    }));
  }
  if (rows.length) return appendMimoDesktopRemovals(rows, desktop, options, deps, scope);
  return appendMimoDesktopRemovals(
    scope ? [] : [statusProvider('notConfigured', updatedAt)],
    desktop, options, deps, scope
  );
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
  mimoMembershipAccountKey,
  normalizeMimoCookieHeader,
  parseMimoBalance,
  parseMimoProfile,
  parseMimoSpend,
  parseMimoPlanDetail,
  parseMimoPlanUsage,
  scopedMimoManagedAccounts,
  withDetectedMimoAccount
};
