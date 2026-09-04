'use strict';

// Alibaba Cloud Token Plan limits.
//
// One provider, four console variants — the mainland Bailian console and the
// international Model Studio console, each in a Team and a Personal/Solo
// flavour. Host, gateway action, product code and *window shape* are all bound
// together per variant, which is why `alibabaVariant` is a single enum rather
// than separate site/plan settings: no combination outside these four exists,
// and two independent settings would let a user select one that does not.
//
//   cn             Bailian       Team      GetSubscriptionSummary -> account billing total
//   intl           Model Studio  Team      GetSubscriptionSummary -> account billing total
//   cn-personal    Bailian       Personal  rolling-window API     -> 5h + 7d windows
//   intl-personal  Model Studio  Personal  rolling-window API     -> 5h + 7d windows
//
// Auth is a console Cookie header, not an API token. The Personal variants read
// their quota from a *different host* than the dashboard, so a Personal cookie
// has to be copied from the quota request rather than from the dashboard page;
// the settings panel says so in its numbered steps.
//
// Verification status: only `cn` (mainland Team) has been exercised against a
// real account, via the capture in tests/shared/alibabaLimits.test.js. The other
// three follow the same published console contract and are covered by fixtures,
// but their live behaviour is unconfirmed. That is precisely why the error
// mapping below is exhaustive rather than a catch-all `unavailable`: a user
// report is the only signal we get, and "login required" vs "the gateway said
// no" is the whole difference between a fixable report and an unactionable one.

const crypto = require('node:crypto');

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { runWithProbeDeadline } = require('./probeDeadline');
const { throwIfAborted } = require('./abortSignal');
const { BROWSER_USER_AGENT } = require('./browserUserAgent');

const ALIBABA_FETCH_TIMEOUT_MS = 20_000;
const ALIBABA_SEC_TOKEN_TIMEOUT_MS = 10_000;

// The Personal usage gateway intermittently answers a 200 "Success" envelope
// that omits the rolling-window payload; an immediate re-request usually
// returns it. Bounded, so a genuinely empty stretch still degrades quickly
// instead of holding the whole limits refresh open.
const PERSONAL_USAGE_MAX_ATTEMPTS = 3;
const PERSONAL_USAGE_RETRY_MS = 400;

const BSS_SERVICE_CODE = 'BssOpenAPI-V3';
const SUBSCRIPTION_SUMMARY_ACTION = 'GetSubscriptionSummary';
const PERSONAL_CONSOLE_PRODUCT = 'sfm_bailian';
const PERSONAL_USAGE_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage';
const PERSONAL_SUBSCRIPTION_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription';
const PERSONAL_QUOTA_CONFIG_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config';

const DEFAULT_VARIANT = 'cn';

const ALIBABA_VARIANTS = Object.freeze({
  cn: Object.freeze({
    id: 'cn',
    personal: false,
    gatewayOrigin: 'https://bailian.console.aliyun.com',
    quotaOrigin: 'https://bailian.console.aliyun.com',
    dashboardUrl: 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan',
    regionId: 'cn-beijing',
    productCode: 'sfm_tokenplanteams_dp_cn',
    personalApiAction: 'BroadScopeAspnGateway',
    personalConsoleSite: 'BAILIAN_ALIYUN'
  }),
  intl: Object.freeze({
    id: 'intl',
    personal: false,
    gatewayOrigin: 'https://modelstudio.console.alibabacloud.com',
    quotaOrigin: 'https://modelstudio.console.alibabacloud.com',
    dashboardUrl: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan',
    regionId: 'ap-southeast-1',
    productCode: 'sfm_tokenplanteams_dp_intl',
    personalApiAction: 'IntlBroadScopeAspnGateway',
    // Alibaba's live console contract, including its historical misspelling.
    personalConsoleSite: 'MODELSTUDIO_ALBABACLOUD'
  }),
  'cn-personal': Object.freeze({
    id: 'cn-personal',
    personal: true,
    gatewayOrigin: 'https://bailian.console.aliyun.com',
    quotaOrigin: 'https://bailian-cs.console.aliyun.com',
    dashboardUrl: 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal',
    regionId: 'cn-beijing',
    productCode: 'sfm_tokenplansolo_public_cn',
    personalApiAction: 'BroadScopeAspnGateway',
    personalConsoleSite: 'BAILIAN_ALIYUN'
  }),
  'intl-personal': Object.freeze({
    id: 'intl-personal',
    personal: true,
    gatewayOrigin: 'https://modelstudio.console.alibabacloud.com',
    quotaOrigin: 'https://bailian-singapore-cs.alibabacloud.com',
    dashboardUrl: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan/personal',
    regionId: 'ap-southeast-1',
    productCode: 'sfm_tokenplansolo_public_intl',
    personalApiAction: 'IntlBroadScopeAspnGateway',
    personalConsoleSite: 'MODELSTUDIO_ALBABACLOUD'
  })
});

const ALIBABA_VARIANT_IDS = Object.freeze(Object.keys(ALIBABA_VARIANTS));

function alibabaVariant(options = {}, env = process.env) {
  const raw = String(
    options.alibabaVariant || env.ALIBABA_TOKEN_PLAN_VARIANT || ''
  ).trim().toLowerCase();
  return ALIBABA_VARIANTS[raw] ? raw : DEFAULT_VARIANT;
}

function alibabaVariantConfig(variantId) {
  return ALIBABA_VARIANTS[variantId] || ALIBABA_VARIANTS[DEFAULT_VARIANT];
}

function alibabaDashboardUrl(variantId) {
  return alibabaVariantConfig(variantId).dashboardUrl;
}

function normalizeAlibabaCookieHeader(value) {
  if (typeof value !== 'string') return '';
  let raw = value.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  raw = raw.replace(/^cookie\s*:\s*/i, '').trim();
  // A usable Cookie header carries at least one `name=value` pair whose name is
  // an RFC 6265 token, anchored to the start or to a `; ` separator. A looser
  // test passes a pasted URL on its query string (`...?spm=abc`), which then
  // saves as a bogus cookie and fails as `unauthorized` forever — exactly the
  // state this guard exists to prevent.
  return /(?:^|;\s*)[A-Za-z0-9!#$%&'*+\-.^_`|~]+=/.test(raw) ? raw : '';
}

function alibabaCookie(env = process.env, options = {}) {
  const explicit = normalizeAlibabaCookieHeader(options.alibabaCookie);
  if (explicit) return explicit;
  return normalizeAlibabaCookieHeader(env.ALIBABA_TOKEN_PLAN_COOKIE || '');
}

// --------------------------------------------------------------------------
// OneConsole payload traversal
//
// The gateway does not commit to a shape: the same logical field arrives at
// different depths, in different letter cases, and sometimes as a JSON string
// nested inside the JSON. These helpers walk the tree without assuming a
// schema — which is the only reason a single parser can serve four variants.
// --------------------------------------------------------------------------

// Recursively expands any string that itself parses as JSON, so `{"data":
// "{\"foo\":1}"}` can be read as `{"data":{"foo":1}}`. The OneConsole gateway
// double-stringifies its envelopes often enough that skipping this step makes a
// perfectly healthy response look like an empty one.
function expandEmbeddedJson(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
    try {
      return expandEmbeddedJson(JSON.parse(trimmed));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(expandEmbeddedJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) out[key] = expandEmbeddedJson(nested);
    return out;
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

// Epoch seconds, epoch milliseconds, and the console's `yyyy-MM-dd[ HH:mm[:ss]]`
// strings all appear in the same fields depending on variant and endpoint.
function toIsoDate(value) {
  const numeric = toNumber(value);
  if (numeric !== null && numeric > 0) {
    const ms = numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = toText(value);
  if (!text) return null;
  // A bare `yyyy-MM-dd HH:mm[:ss]` carries no zone. Both consoles run on UTC+8
  // — Beijing for the mainland variants, ap-southeast-1/Singapore for the
  // international ones — so it is pinned to that offset rather than read as UTC
  // (eight hours early) or as the *device's* zone, which would move a quota
  // reset every time the laptop travelled.
  const spaceSeparated = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text)
    ? `${text.replace(' ', 'T')}+08:00`
    : text;
  const parsed = new Date(spaceSeparated);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function percentagePoints(ratio) {
  const value = toNumber(ratio);
  if (value === null) return null;
  return Math.min(Math.max(value, 0), 1) * 100;
}

// Reads one own key case-insensitively. The console disagrees with itself about
// capitalisation between variants, so an exact-case read is a silent data loss.
function pickKey(object, name) {
  if (!isPlainObject(object)) return undefined;
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(object)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

// Finds the first object anywhere in the tree that owns any of `keys`.
function findObjectWithAnyKey(value, keys) {
  const wanted = keys.map((key) => String(key).toLowerCase());
  if (isPlainObject(value)) {
    if (Object.keys(value).some((key) => wanted.includes(key.toLowerCase()))) return value;
    for (const nested of Object.values(value)) {
      const found = findObjectWithAnyKey(nested, keys);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectWithAnyKey(item, keys);
      if (found) return found;
    }
  }
  return null;
}

// Searches one key at a time across the *whole* tree, so the caller's priority
// order is preserved globally rather than per node: a high-priority key nested
// three levels down still beats a low-priority one at the root. Matching is
// case-insensitive, which is what lets the key lists below stay single-spelled
// instead of enumerating `totalValue` / `TotalValue` / `TOTALVALUE`.
function findByKey(value, key, coerce) {
  const wanted = key.toLowerCase();
  if (isPlainObject(value)) {
    for (const [name, nested] of Object.entries(value)) {
      if (name.toLowerCase() !== wanted) continue;
      const coerced = coerce(nested);
      if (coerced !== null && coerced !== '') return coerced;
    }
    for (const nested of Object.values(value)) {
      const found = findByKey(nested, key, coerce);
      if (found !== null && found !== '') return found;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findByKey(item, key, coerce);
      if (found !== null && found !== '') return found;
    }
  }
  return null;
}

function firstNumber(value, keys) {
  for (const key of keys) {
    const found = findByKey(value, key, toNumber);
    if (found !== null) return found;
  }
  return null;
}

function firstString(value, keys) {
  for (const key of keys) {
    const found = findByKey(value, key, toText);
    if (found) return found;
  }
  return '';
}

function firstDate(value, keys) {
  for (const key of keys) {
    const found = findByKey(value, key, toIsoDate);
    if (found) return found;
  }
  return null;
}

// Key spellings the console has been observed to use for each figure. Kept
// case-insensitively matched (see findByKey), so only one casing per name.
const PLAN_NAME_KEYS = [
  'planName', 'packageName', 'commodityName', 'specType', 'instanceName',
  'displayName', 'productName', 'name', 'title', 'planType'
];
const USED_KEYS = [
  'usedQuota', 'usedCredits', 'usedCredit', 'consumedCredits', 'usedAmount',
  'consumeAmount', 'usedValue', 'consumedValue', 'usage', 'used'
];
const TOTAL_KEYS = [
  'totalQuota', 'totalCredits', 'totalCredit', 'creditLimit', 'creditsTotal',
  'monthlyTotalQuota', 'totalValue', 'cycleTotalValue', 'quota', 'amount'
];
const REMAINING_KEYS = [
  'remainingQuota', 'remainQuota', 'remainingCredits', 'remainingCredit',
  'availableCredits', 'availableAmount', 'remainAmount', 'totalSurplusValue',
  'surplusValue', 'cycleSurplusValue', 'balance', 'remaining'
];
const COUNT_KEYS = ['totalCount', 'subscriptionTotalNumber'];
const RESET_KEYS = [
  'nextRefreshTime', 'resetTime', 'periodEndTime', 'billingCycleEnd',
  'billCycleEndTime', 'expireTime', 'expirationTime', 'validEndTime',
  'instanceEndTime', 'cycleEndTime', 'nearestExpireDate', 'endTime'
];
const SEC_TOKEN_KEYS = ['secToken', 'sec_token'];
const UID_KEYS = ['uid', 'userId', 'aliyunId', 'pk'];

// --------------------------------------------------------------------------
// Error envelopes
//
// The gateway answers HTTP 200 for authentication failures, permission
// failures and outright errors alike, carrying the real outcome in the body.
// Without this pass every one of them reads as "no data", so an expired cookie
// — the single most common failure, because these sessions expire in days —
// would surface as a transient-looking `unavailable` that never tells the user
// to paste a new one.
// --------------------------------------------------------------------------

class AlibabaLimitsError extends Error {
  constructor(status, message) {
    super(message || `Alibaba Token Plan request failed (${status})`);
    this.name = 'AlibabaLimitsError';
    this.status = status;
  }
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  }
  return null;
}

function looksLikeLoginFailure(text) {
  return /needlogin|notlogined|postonlyortokenerror|tokenerror|request has expired|refresh page|请求已经过期|\blogin\b/i.test(text);
}

function looksLikePermissionFailure(text) {
  // A workspace permission failure is not a credential failure. Treating it as
  // one would tell the user to re-paste a cookie that is perfectly valid, and
  // the re-pasted one would fail exactly the same way.
  if (/workspace\.notauthoris?zed/i.test(text)) return false;
  return /notauthoris?zed|not authoris?zed|unauthoris?zed|access denied|forbidden/i.test(text);
}

// Finds the frame that actually reported the failure. The gateway can wrap a
// failing inner frame in a successful outer envelope (`code: "200"`), so
// reading the error off the outer one reports a success that did not happen.
function failingFrame(value) {
  if (isPlainObject(value)) {
    if (toBoolean(value.success) === false || toBoolean(value.Success) === false) return value;
    for (const nested of Object.values(value)) {
      const found = failingFrame(nested);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = failingFrame(item);
      if (found) return found;
    }
  }
  return null;
}

function describeFailure(frame, payload) {
  const code = firstString(frame, ['errorCode', 'code']) || firstString(payload, ['errorCode', 'code']);
  const message = firstString(frame, ['errorMsg', 'message', 'msg', 'statusMessage'])
    || firstString(payload, ['errorMsg', 'message', 'msg', 'statusMessage'])
    || code
    || 'request was not successful';
  return { code, message, combined: `${code} ${message}` };
}

function classifyFailure(frame, payload) {
  const { message, combined } = describeFailure(frame, payload);
  if (looksLikeLoginFailure(combined)) return new AlibabaLimitsError('unauthorized', message);
  if (looksLikePermissionFailure(combined)) return new AlibabaLimitsError('unauthorized', message);
  return new AlibabaLimitsError('unavailable', message);
}

function throwIfErrorPayload(payload) {
  if (!isPlainObject(payload)) return;

  if (toBoolean(payload.successResponse) === false) {
    const httpish = firstNumber(payload, ['statusCode', 'status_code', 'code']);
    if (httpish === 401 || httpish === 403) {
      throw new AlibabaLimitsError('unauthorized', 'Alibaba Token Plan credentials are invalid');
    }
    throw classifyFailure(payload, payload);
  }

  const failing = failingFrame(payload);
  if (failing) throw classifyFailure(failing, payload);

  const statusCode = firstNumber(payload, ['statusCode', 'status_code', 'code']);
  if (statusCode !== null && statusCode !== 0 && statusCode !== 200) {
    if (statusCode === 401 || statusCode === 403) {
      throw new AlibabaLimitsError('unauthorized', 'Alibaba Token Plan credentials are invalid');
    }
    if (statusCode === 429) {
      throw new AlibabaLimitsError('sourceRateLimited', 'Alibaba Token Plan rate limited the request');
    }
    const { message } = describeFailure(payload, payload);
    throw new AlibabaLimitsError('unavailable', message);
  }

  const { message, combined } = describeFailure(payload, payload);
  if (looksLikeLoginFailure(combined)) throw new AlibabaLimitsError('unauthorized', message);
  if (looksLikePermissionFailure(combined)) throw new AlibabaLimitsError('unauthorized', message);
}

function looksLikeLoginHtml(text) {
  const lower = String(text || '').toLowerCase();
  return lower.includes('<html') && /login|sign ?in/.test(lower);
}

// Every response body funnels through here, so a signed-out session that is
// answered with the console's HTML login shell maps to `unauthorized` rather
// than dying in JSON.parse and reporting a parse failure.
function parseConsoleBody(text) {
  if (!text || !String(text).trim()) {
    throw new AlibabaLimitsError('unavailable', 'Alibaba Token Plan returned an empty response');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (looksLikeLoginHtml(text)) {
      throw new AlibabaLimitsError('unauthorized', 'Alibaba Token Plan session is signed out');
    }
    throw new AlibabaLimitsError('unavailable', 'Alibaba Token Plan returned a non-JSON response');
  }
  const expanded = expandEmbeddedJson(parsed);
  if (!isPlainObject(expanded)) {
    throw new AlibabaLimitsError('unavailable', 'Alibaba Token Plan returned an unexpected payload');
  }
  throwIfErrorPayload(expanded);
  return expanded;
}

// --------------------------------------------------------------------------
// Team: GetSubscriptionSummary
// --------------------------------------------------------------------------

// Prefers the frame that actually holds quota numbers. Some consoles keep the
// totals inside a nested entry while the outer object carries only
// `TotalCount`, so anchoring on the outer one silently reports no quota.
function subscriptionSummaryFrame(payload) {
  const quotaKeys = [...USED_KEYS, ...TOTAL_KEYS, ...REMAINING_KEYS];
  const lowered = new Set(quotaKeys.map((key) => key.toLowerCase()));
  const hasQuotaKey = (frame) => Object.keys(frame).some((key) => lowered.has(key.toLowerCase()));

  for (const key of ['data', 'successResponse']) {
    const frame = pickKey(findObjectWithAnyKey(payload, [key]), key);
    if (!isPlainObject(frame)) continue;
    if (hasQuotaKey(frame)) return frame;
    const nested = findObjectWithAnyKey(frame, quotaKeys);
    if (nested) return nested;
    if (findObjectWithAnyKey(frame, COUNT_KEYS)) return frame;
  }
  return findObjectWithAnyKey(payload, [...quotaKeys, ...COUNT_KEYS]) || payload;
}

function parseTeamSummary(payload) {
  // Every figure is read from the summary frame only. Several of these key
  // names are generic enough (`amount`, `quota`, `usage`, `balance`) that
  // re-searching the whole payload after the frame comes up empty would sooner
  // find an unrelated number than the missing one — and a wrong figure is worse
  // than a missing one, because nothing downstream can tell it is wrong.
  // `subscriptionSummaryFrame` already widens to the payload when it cannot
  // find a narrower frame, so nothing legitimate is lost here.
  const frame = subscriptionSummaryFrame(payload);
  const total = firstNumber(frame, TOTAL_KEYS);
  const remaining = firstNumber(frame, REMAINING_KEYS);
  // Read a reported `used` before deriving one: an account whose payload
  // carries used-and-total but no remaining would otherwise show nothing.
  const reportedUsed = firstNumber(frame, USED_KEYS);
  const used = reportedUsed !== null
    ? reportedUsed
    : (total !== null && remaining !== null ? Math.max(0, total - remaining) : null);
  const subscriptions = firstNumber(frame, COUNT_KEYS);
  const resetsAt = firstDate(frame, RESET_KEYS) || firstDate(payload, RESET_KEYS);
  const uidValue = firstNumber(payload, UID_KEYS) ?? firstString(payload, UID_KEYS);
  const planName = firstString(frame, PLAN_NAME_KEYS) || firstString(payload, PLAN_NAME_KEYS);

  if (total === null && remaining === null && used === null && subscriptions === null) {
    throw new AlibabaLimitsError('unavailable', 'Alibaba Token Plan returned no subscription summary');
  }

  return {
    uid: uidValue === null || uidValue === '' ? '' : String(uidValue),
    // Token Plan is sold per seat per month in tiers; a payload that names the
    // tier shows it, and one that does not still says which product this row is
    // for. The window beside it is a period name, so these never collide.
    planName: planName || ((subscriptions ?? 0) > 0 || total !== null ? 'Token Plan' : ''),
    used,
    total,
    remaining,
    subscriptions,
    resetsAt
  };
}

function teamWindows(summary) {
  // An account with no active subscription reports `TotalCount: 0` and no
  // figures. The provider row stays visible — the credential is good and the
  // account is real — but there is no pool to draw a meter for.
  if (summary.total === null && summary.remaining === null && summary.used === null) return [];
  // Deliberately unlabelled: every window in this app is named for its period,
  // and the renderer supplies "Monthly" for a billing window. Naming the product
  // here instead would both break that convention and repeat the account label.
  return [{
    kind: 'billing',
    used: summary.used,
    limit: summary.total,
    remaining: summary.remaining,
    resetsAt: summary.resetsAt,
    showMeter: summary.total !== null && summary.total > 0
  }];
}

// --------------------------------------------------------------------------
// Personal/Solo: rolling-window API
//
// Percentage-first, unlike Team: the usage endpoint reports fractions of the
// 5-hour and 7-day windows, and absolute totals only exist if the separate
// quota-config endpoint recognises the plan. Both extra endpoints are
// best-effort — losing them costs the totals, not the windows.
// --------------------------------------------------------------------------

const PERSONAL_PLAN_LABELS = Object.freeze({
  lite: 'Lite',
  standard: 'Standard',
  pro: 'Pro',
  max: 'Max'
});

function personalPlanCode(payload) {
  return firstString(payload, ['specCode', 'spec_code', 'planName', 'plan_name']).toLowerCase();
}

function personalQuotaTotals(payload, planCode) {
  if (!planCode || !isPlainObject(payload)) return { fiveHour: null, weekly: null };
  const quota = findByKey(payload, planCode, (value) => (isPlainObject(value) ? value : null));
  if (!isPlainObject(quota)) return { fiveHour: null, weekly: null };
  return {
    fiveHour: firstNumber(quota, ['five_hour', 'fiveHour']),
    weekly: firstNumber(quota, ['weekly'])
  };
}

function parsePersonalUsage(usagePayload, subscriptionPayload, quotaConfigPayload) {
  const fiveHourPercent = percentagePoints(firstNumber(usagePayload, ['per5HourPercentage']));
  const weeklyPercent = percentagePoints(firstNumber(usagePayload, ['per1WeekPercentage']));
  if (fiveHourPercent === null && weeklyPercent === null) {
    throw new AlibabaLimitsError('windowsUnavailable', 'Alibaba Token Plan returned no usage windows');
  }

  const planCode = personalPlanCode(subscriptionPayload);
  const quota = personalQuotaTotals(quotaConfigPayload, planCode);
  // Read opportunistically: an account id is what stops a Personal row from
  // being discarded when another device reports an identified Team row for the
  // same provider. The cookie is never used for this — it rotates on re-login,
  // which would split one account's history in two.
  const uidValue = firstNumber(usagePayload, UID_KEYS)
    ?? firstString(usagePayload, UID_KEYS)
    ?? firstNumber(subscriptionPayload, UID_KEYS)
    ?? firstString(subscriptionPayload, UID_KEYS);
  return {
    uid: uidValue === null || uidValue === undefined || uidValue === '' ? '' : String(uidValue),
    planName: planCode ? (PERSONAL_PLAN_LABELS[planCode] || planCode) : 'Personal',
    fiveHourPercent,
    fiveHourTotal: quota.fiveHour,
    fiveHourResetsAt: firstDate(usagePayload, ['per5HourResetTime']),
    weeklyPercent,
    weeklyTotal: quota.weekly,
    weeklyResetsAt: firstDate(usagePayload, ['per1WeekResetTime'])
  };
}

function personalWindows(usage) {
  const windows = [];
  if (usage.fiveHourPercent !== null) {
    windows.push({
      kind: 'session',
      label: '5-hour',
      usedPercent: usage.fiveHourPercent,
      limit: usage.fiveHourTotal,
      windowMinutes: 5 * 60,
      resetsAt: usage.fiveHourResetsAt
    });
  }
  if (usage.weeklyPercent !== null) {
    windows.push({
      kind: 'weekly',
      label: 'Weekly',
      usedPercent: usage.weeklyPercent,
      limit: usage.weeklyTotal,
      windowMinutes: 7 * 24 * 60,
      resetsAt: usage.weeklyResetsAt
    });
  }
  return windows;
}

// --------------------------------------------------------------------------
// Transport
// --------------------------------------------------------------------------

function cookieValue(cookieHeader, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(cookieHeader || '');
  return match ? match[1].trim() : '';
}

function consoleHeaders(cookieHeader, variant, extra = {}) {
  const headers = {
    Accept: '*/*',
    'Content-Type': 'application/x-www-form-urlencoded',
    Cookie: cookieHeader,
    Origin: variant.gatewayOrigin,
    // Bare origin on purpose. The dashboard URL carries a path, and Chromium
    // cancels a cross-origin Referer that does. See src/electron/limitsFetch.js.
    Referer: `${variant.gatewayOrigin}/`,
    'User-Agent': BROWSER_USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    ...extra
  };
  const csrf = cookieValue(cookieHeader, 'login_aliyunid_csrf') || cookieValue(cookieHeader, 'csrf');
  if (csrf) {
    headers['x-xsrf-token'] = csrf;
    headers['x-csrf-token'] = csrf;
  }
  return headers;
}

function fetchWithDeadline(url, init, deps, deadlineMs) {
  return runWithProbeDeadline(
    async ({ signal }) => {
      const response = await (deps.fetch || fetch)(url, { ...init, signal });
      const text = await response.text();
      return { response, text };
    },
    { signal: deps.signal, deadlineMs: Number(deps.fetchTimeoutMs) || deadlineMs }
  );
}

function throwForHttpStatus(status) {
  if (status === 401 || status === 403) {
    throw new AlibabaLimitsError('unauthorized', 'Alibaba Token Plan session is not authorized');
  }
  if (status === 429) {
    throw new AlibabaLimitsError('sourceRateLimited', 'Alibaba Token Plan rate limited the request');
  }
  throw new AlibabaLimitsError('unavailable', `Alibaba Token Plan returned HTTP ${status}`);
}

// The gateway rejects some accounts without the console's `sec_token`, so it is
// resolved before the quota call — best effort, in the order that succeeds most
// often. The dashboard shell only server-renders the token for what looks like
// a real document navigation, which is why that request carries navigation
// headers; Chromium strips the `Sec-Fetch-*` family from a fetch(), so under
// the widget's transport that attempt usually falls through to the JSON
// endpoint. Every hop is optional — a missing token is not an error, because
// plenty of accounts answer fine without one.
async function resolveSecToken(cookieHeader, variant, deps) {
  const attempts = [
    async () => {
      const { response, text } = await fetchWithDeadline(variant.dashboardUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Cookie: cookieHeader,
          Referer: `${variant.gatewayOrigin}/`,
          'User-Agent': BROWSER_USER_AGENT,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document'
        }
      }, deps, ALIBABA_SEC_TOKEN_TIMEOUT_MS);
      if (!response.ok) return '';
      return secTokenFromHtml(text);
    },
    async () => {
      const { response, text } = await fetchWithDeadline(`${variant.gatewayOrigin}/tool/user/info.json`, {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/plain, */*',
          Cookie: cookieHeader,
          Referer: `${variant.gatewayOrigin}/`,
          'User-Agent': BROWSER_USER_AGENT
        }
      }, deps, ALIBABA_SEC_TOKEN_TIMEOUT_MS);
      if (!response.ok) return '';
      try {
        return firstString(expandEmbeddedJson(JSON.parse(text)), SEC_TOKEN_KEYS);
      } catch {
        return '';
      }
    }
  ];

  for (const attempt of attempts) {
    // A cancelled refresh must stop here rather than run the remaining hops:
    // the caller has already moved on and every extra request is waste.
    throwIfAborted(deps.signal);
    try {
      const token = await attempt();
      if (token) return token;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
    }
  }
  return cookieValue(cookieHeader, 'sec_token');
}

const SEC_TOKEN_PATTERNS = [
  /"secToken"\s*:\s*"([^"]+)"/,
  /"sec_token"\s*:\s*"([^"]+)"/,
  // The OneConsole shell embeds it in `window.ALIYUN_CONSOLE_CONFIG` with an
  // upper-case, unquoted key, which the quoted patterns above miss.
  /SEC_TOKEN['"]?\s*[:=]\s*['"]([^'"]+)['"]/,
  /sec(?:_t|T)oken['"]?\s*[:=]\s*['"]([^'"]+)['"]/
];

function secTokenFromHtml(html) {
  for (const pattern of SEC_TOKEN_PATTERNS) {
    const match = pattern.exec(String(html || ''));
    if (match && match[1].trim()) return match[1].trim();
  }
  return '';
}

function teamSummaryUrl(variant) {
  return `${variant.quotaOrigin}/data/api.json?action=${SUBSCRIPTION_SUMMARY_ACTION}&product=${BSS_SERVICE_CODE}&_tag=`;
}

function personalApiUrl(variant, api) {
  const params = new URLSearchParams({
    action: variant.personalApiAction,
    product: PERSONAL_CONSOLE_PRODUCT,
    api,
    _v: 'undefined'
  });
  return `${variant.quotaOrigin}/data/api.json?${params.toString()}`;
}

async function fetchTeamSummary(cookieHeader, variant, secToken, deps) {
  const body = new URLSearchParams({
    product: BSS_SERVICE_CODE,
    action: SUBSCRIPTION_SUMMARY_ACTION,
    params: JSON.stringify({ ProductCode: variant.productCode }),
    region: variant.regionId
  });
  if (secToken) body.set('sec_token', secToken);

  const { response, text } = await fetchWithDeadline(teamSummaryUrl(variant), {
    method: 'POST',
    headers: consoleHeaders(cookieHeader, variant),
    body: body.toString()
  }, deps, ALIBABA_FETCH_TIMEOUT_MS);
  if (!response.ok) throwForHttpStatus(response.status);
  return parseConsoleBody(text);
}

function personalRequestBody(variant, cookieHeader, api, secToken, dataParams, deps) {
  // `cornerstoneParam` must not carry a hardcoded `switchAgent`: the gateway
  // binds that value to one account's workspace, so a captured agent id makes
  // every *other* account fail with `Workspace.NotAuthorised`. Omitting it lets
  // the gateway resolve the session's own default workspace.
  const cornerstone = {
    feTraceId: String(deps.randomUUID ? deps.randomUUID() : crypto.randomUUID()).toLowerCase(),
    feURL: variant.dashboardUrl,
    protocol: 'V2',
    console: 'ONE_CONSOLE',
    productCode: 'p_efm',
    switchUserType: 3,
    domain: new URL(variant.gatewayOrigin).host,
    consoleSite: variant.personalConsoleSite,
    userNickName: '',
    userPrincipalName: '',
    xsp_lang: 'en-US'
  };
  const anonymousId = cookieValue(cookieHeader, 'cna');
  if (anonymousId) cornerstone['X-Anonymous-Id'] = anonymousId;

  const body = new URLSearchParams({
    product: PERSONAL_CONSOLE_PRODUCT,
    action: variant.personalApiAction,
    region: variant.regionId,
    language: 'en-US',
    params: JSON.stringify({
      Api: api,
      V: '1.0',
      Data: { ...dataParams, cornerstoneParam: cornerstone }
    })
  });
  if (secToken) body.set('sec_token', secToken);
  return body.toString();
}

async function fetchPersonalApi(cookieHeader, variant, api, secToken, dataParams, deps) {
  const { response, text } = await fetchWithDeadline(personalApiUrl(variant, api), {
    method: 'POST',
    headers: consoleHeaders(cookieHeader, variant, { Accept: 'application/json, text/plain, */*' }),
    body: personalRequestBody(variant, cookieHeader, api, secToken, dataParams, deps)
  }, deps, ALIBABA_FETCH_TIMEOUT_MS);
  if (!response.ok) throwForHttpStatus(response.status);
  return parseConsoleBody(text);
}

async function fetchOptionalPersonalApi(cookieHeader, variant, api, secToken, dataParams, deps) {
  try {
    return await fetchPersonalApi(cookieHeader, variant, api, secToken, dataParams, deps);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

function delay(ms, deps) {
  const setTimer = deps.setTimeout || setTimeout;
  return new Promise((resolve) => { setTimer(resolve, ms); });
}

async function fetchPersonalUsage(cookieHeader, variant, secToken, deps) {
  const subscription = await fetchOptionalPersonalApi(
    cookieHeader, variant, PERSONAL_SUBSCRIPTION_API, secToken,
    { commodityCode: variant.productCode }, deps
  );
  const quotaConfig = await fetchOptionalPersonalApi(
    cookieHeader, variant, PERSONAL_QUOTA_CONFIG_API, secToken, {}, deps
  );

  let lastError = null;
  for (let attempt = 0; attempt < PERSONAL_USAGE_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(deps.signal);
    if (attempt > 0) await delay(PERSONAL_USAGE_RETRY_MS, deps);
    try {
      const usage = await fetchPersonalApi(
        cookieHeader, variant, PERSONAL_USAGE_API, secToken, {}, deps
      );
      return parsePersonalUsage(usage, subscription, quotaConfig);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (error?.status !== 'windowsUnavailable') throw error;
      lastError = error;
    }
  }
  throw new AlibabaLimitsError('unavailable', lastError?.message || 'Alibaba Token Plan usage is unavailable');
}

function statusRow(status, updatedAt, variantId, personal) {
  return normalizeLimitProvider({
    provider: 'alibaba',
    source: 'web',
    status,
    updatedAt,
    windows: [],
    region: variantId,
    ...(personal ? { workspaceKind: 'personal' } : {})
  });
}

async function fetchAlibabaLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const updatedAt = new Date((deps.now || Date.now)()).toISOString();
  const variantId = alibabaVariant(options, env);
  const variant = alibabaVariantConfig(variantId);
  const cookieHeader = alibabaCookie(env, options);

  if (!cookieHeader) return [statusRow('notConfigured', updatedAt, variantId, variant.personal)];

  try {
    throwIfAborted(deps.signal);
    const secToken = await resolveSecToken(cookieHeader, variant, deps);

    if (variant.personal) {
      const usage = await fetchPersonalUsage(cookieHeader, variant, secToken, deps);
      return [normalizeLimitProvider({
        provider: 'alibaba',
        accountKey: usage.uid ? hashKey('alibaba', usage.uid) : '',
        accountLabel: usage.planName,
        planLabel: usage.planName,
        source: 'web',
        status: 'ok',
        updatedAt,
        windows: personalWindows(usage),
        region: variantId,
        workspaceKind: 'personal'
      })];
    }

    const payload = await fetchTeamSummary(cookieHeader, variant, secToken, deps);
    const summary = parseTeamSummary(payload);
    return [normalizeLimitProvider({
      provider: 'alibaba',
      accountKey: summary.uid ? hashKey('alibaba', summary.uid) : '',
      accountLabel: summary.planName,
      planLabel: summary.planName,
      source: 'web',
      status: 'ok',
      updatedAt,
      windows: teamWindows(summary),
      region: variantId
    })];
  } catch (error) {
    // An aborted refresh is not a provider outcome. Swallowing it here would
    // record a fabricated `unavailable` over the last real answer, which is the
    // failure mode the runtime's lastGood/lastAttempt split exists to avoid.
    if (error?.name === 'AbortError') throw error;
    const status = error?.status === 'timeout' || !error?.status ? 'unavailable' : error.status;
    return [statusRow(status === 'windowsUnavailable' ? 'unavailable' : status, updatedAt, variantId, variant.personal)];
  }
}

module.exports = {
  ALIBABA_FETCH_TIMEOUT_MS,
  ALIBABA_VARIANTS,
  ALIBABA_VARIANT_IDS,
  alibabaCookie,
  alibabaDashboardUrl,
  alibabaVariant,
  alibabaVariantConfig,
  expandEmbeddedJson,
  fetchAlibabaLimits,
  normalizeAlibabaCookieHeader,
  parsePersonalUsage,
  parseTeamSummary,
  parseConsoleBody,
  secTokenFromHtml
};
