'use strict';

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { runWithProbeDeadline } = require('./probeDeadline');
const { BROWSER_USER_AGENT } = require('./browserUserAgent');

const QODER_FETCH_TIMEOUT_MS = 12_000;

function cleanSecret(value) {
  let raw = value;
  if (typeof raw !== 'string') return '';
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function qoderCookie(env = process.env, options = {}) {
  const explicit = cleanSecret(options.qoderCookie);
  if (explicit) return explicit;
  for (const name of ['QODER_COOKIE', 'TOKEN_MONITOR_QODER_COOKIE']) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

// IDE access token (the `dt-…` credential the Qoder desktop app sends as
// `Authorization: Bearer` to its openapi origin). It outlives a dashboard
// session cookie, so prefer it when both are configured.
function qoderAccessToken(env = process.env, options = {}) {
  const explicit = cleanSecret(options.qoderAccessToken);
  if (explicit) return explicit;
  for (const name of ['QODER_ACCESS_TOKEN', 'TOKEN_MONITOR_QODER_ACCESS_TOKEN']) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

function qoderSite(options = {}, env = process.env) {
  const value = String(options.qoderSite || env.QODER_SITE || env.TOKEN_MONITOR_QODER_SITE || '').trim().toLowerCase();
  if (value === 'cn' || value === 'china' || value.includes('qoder.com.cn')) return 'cn';
  return 'global';
}

function qoderOrigin(site) {
  return site === 'cn' ? 'https://qoder.com.cn' : 'https://qoder.com';
}

function qoderApiOrigin(site) {
  return site === 'cn' ? 'https://openapi.qoder.com.cn' : 'https://openapi.qoder.sh';
}

function qoderUsageUrl(site = 'global') {
  return `${qoderOrigin(site)}/api/v2/me/usages/big_model_credits`;
}

function qoderUserPlanUrl(site = 'global') {
  return `${qoderOrigin(site)}/api/v1/me/userplan`;
}

function qoderApiQuotaUrl(site = 'global') {
  return `${qoderApiOrigin(site)}/api/v2/quota/usage`;
}

function qoderApiPlanUrl(site = 'global') {
  return `${qoderApiOrigin(site)}/api/v2/user/plan`;
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 20_000_000_000 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function read(obj, camel, snake) {
  return obj?.[camel] ?? obj?.[snake];
}

function planText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = raw
    .replace(/^ORGANIZATION_PLAN_TIER_/i, 'PLAN_TIER_')
    .replace(/^PLAN_TIER_/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const known = {
    free: 'Community Edition',
    community: 'Community Edition',
    communityedition: 'Community Edition',
    'community edition': 'Community Edition',
    protrial: 'Pro Trial',
    'pro trial': 'Pro Trial',
    pro: 'Pro',
    proplus: 'Pro+',
    'pro plus': 'Pro+',
    'pro+': 'Pro+',
    ultra: 'Ultra',
    team: 'Teams',
    teams: 'Teams',
    enterprise: 'Enterprise'
  };
  if (known[normalized]) return known[normalized];
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bpro\s+plus\b/i, 'Pro+')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function firstPlanLabel(source) {
  if (!source || typeof source !== 'object') return '';
  for (const field of [
    'plan_tier',
    'planTier',
    'plan',
    'tier',
    'name',
    'product_name',
    'productName',
    'subscription_type',
    'subscriptionType'
  ]) {
    const label = planText(source[field]);
    if (label) return label;
  }
  return '';
}

function parseQoderPlanLabel(body) {
  const direct = firstPlanLabel(body);
  if (direct) return direct;
  const data = body?.data;
  const dataLabel = firstPlanLabel(data);
  if (dataLabel) return dataLabel;
  const subscription = data?.subscription || body?.subscription || null;
  const subscriptionLabel = firstPlanLabel(subscription);
  if (subscriptionLabel) return subscriptionLabel;
  const current = data?.current || data?.currentPlan || data?.current_plan || body?.current || body?.currentPlan || body?.current_plan || null;
  return firstPlanLabel(current);
}

function planTierLabel(body) {
  const raw = String(read(body, 'planTierName', 'plan_tier_name') || '').trim();
  return planText(raw);
}

// Response of GET {openapi}/api/v2/quota/usage, the endpoint the Qoder desktop
// app itself polls for its credits meter:
// { userQuota: { total, used, remaining, unit }, addOnQuota?: {...}, expiresAt }
// `percentage` in that payload is a 0-1 fraction of used/total, not a percent,
// so the window percentage is recomputed here.
function parseQoderApiUsage(body) {
  const userQuota = read(body, 'userQuota', 'user_quota');
  const used = numberOrNull(read(userQuota, 'used', 'used'));
  const total = numberOrNull(read(userQuota, 'total', 'total'));
  if (used === null || total === null || used < 0 || total < 0) {
    throw new Error('missing userQuota usage numbers');
  }
  let usedCredits = used;
  let totalCredits = total;
  let remainingCredits = numberOrNull(read(userQuota, 'remaining', 'remaining'));
  if (remainingCredits === null) remainingCredits = Math.max(0, total - used);
  const addOnQuota = read(body, 'addOnQuota', 'add_on_quota');
  if (addOnQuota && typeof addOnQuota === 'object') {
    const addOnUsed = numberOrNull(read(addOnQuota, 'used', 'used'));
    const addOnTotal = numberOrNull(read(addOnQuota, 'total', 'total'));
    const addOnRemaining = numberOrNull(read(addOnQuota, 'remaining', 'remaining'));
    if (addOnUsed !== null && addOnTotal !== null && addOnUsed >= 0 && addOnTotal >= 0) {
      usedCredits += addOnUsed;
      totalCredits += addOnTotal;
      remainingCredits += addOnRemaining === null ? Math.max(0, addOnTotal - addOnUsed) : addOnRemaining;
    }
  }
  // Preserve reported usage even when it exceeds the limit: present the
  // spendable balance as exhausted rather than treating the payload as broken.
  remainingCredits = Math.max(0, remainingCredits);
  const usagePercentage = totalCredits > 0 ? (usedCredits / totalCredits) * 100 : 0;
  // expiresAt is the subscription boundary; monthly credits refresh with it.
  const resetsAt = toIso(read(body, 'expiresAt', 'expires_at'));
  const window = {
    kind: 'billing',
    label: 'Credits',
    used: usedCredits,
    limit: totalCredits,
    remaining: remainingCredits,
    usedPercent: usagePercentage,
    remainingPercent: Math.max(0, Math.min(100, 100 - usagePercentage)),
    resetsAt,
    showMeter: true
  };
  return {
    usedCredits,
    totalCredits,
    remainingCredits,
    usagePercentage,
    unit: String(read(userQuota, 'unit', 'unit') || '').trim(),
    resetsAt,
    window
  };
}

function quotaSummary(container) {
  return read(container, 'quotaSummary', 'quota_summary') || null;
}

function parseSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const used = numberOrNull(read(summary, 'usedValue', 'used_value'));
  const total = numberOrNull(read(summary, 'limitValue', 'limit_value'));
  const explicitRemaining = numberOrNull(read(summary, 'remainingValue', 'remaining_value'));
  if (used === null || total === null || used < 0 || total < 0) return null;
  const remaining = explicitRemaining === null ? Math.max(0, total - used) : Math.max(0, explicitRemaining);
  const explicitPercentage = numberOrNull(read(summary, 'usagePercentage', 'usage_percentage'));
  const usagePercentage = explicitPercentage === null && total > 0 ? (used / total) * 100 : explicitPercentage;
  return {
    used,
    total,
    remaining,
    usagePercentage: Math.max(0, Math.min(100, usagePercentage ?? (total === 0 ? 100 : 0))),
    unit: String(summary.unit || '').trim()
  };
}

function parseQoderUsage(body) {
  const payload = body?.data && typeof body.data === 'object' ? body.data : body;
  const total = parseSummary(quotaSummary(read(payload, 'totalQuota', 'total_quota')));
  if (!total) throw new Error('missing totalQuota.quotaSummary');
  const shared = parseSummary(quotaSummary(read(payload, 'sharedQuota', 'shared_quota')));
  const usedCredits = total.used + (shared?.used || 0);
  const totalCredits = total.total + (shared?.total || 0);
  const remainingCredits = total.remaining + (shared?.remaining || 0);
  const usagePercentage = totalCredits > 0 ? (usedCredits / totalCredits) * 100 : total.usagePercentage;
  const resetsAt = toIso(read(payload, 'nextResetAt', 'next_reset_at'));
  const window = {
    kind: 'billing',
    label: 'Credits',
    used: usedCredits,
    limit: totalCredits,
    remaining: remainingCredits,
    usedPercent: usagePercentage,
    remainingPercent: Math.max(0, Math.min(100, 100 - usagePercentage)),
    resetsAt,
    showMeter: true
  };
  return {
    usedCredits,
    totalCredits,
    remainingCredits,
    usagePercentage,
    unit: total.unit || shared?.unit || '',
    resetsAt,
    window
  };
}

function fetchJsonWithDeadline(url, init, deps = {}) {
  const deadlineMs = Number(deps.qoderFetchTimeoutMs || deps.fetchTimeoutMs || QODER_FETCH_TIMEOUT_MS);
  return runWithProbeDeadline(
    async ({ signal }) => {
      const response = await (deps.fetch || fetch)(url, { ...init, signal });
      const body = response.ok ? await response.json() : null;
      return { response, body };
    },
    { signal: deps.signal, deadlineMs }
  );
}

function providerStatusFromResponse(status) {
  return status === 401 || status === 403
    ? 'unauthorized'
    : status === 429 ? 'sourceRateLimited' : 'unavailable';
}

function userTypeLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('professional') || raw.includes('pro_plus')) return 'Pro';
  if (raw.includes('proplus') || raw.includes('pro_plus')) return 'Pro+';
  if (raw.includes('ultra')) return 'Ultra';
  if (raw.includes('free') || raw.includes('community')) return 'Community Edition';
  if (raw.includes('enterprise')) return 'Enterprise';
  if (raw.includes('team')) return 'Teams';
  return '';
}

async function fetchQoderApiLimits(accessToken, site, options, deps, updatedAt) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': BROWSER_USER_AGENT
  };
  const { response, body } = await fetchJsonWithDeadline(qoderApiQuotaUrl(site), { headers }, deps);
  if (!response.ok) {
    const error = new Error(`Qoder usage returned ${response.status}`);
    error.status = providerStatusFromResponse(response.status);
    throw error;
  }
  const usage = parseQoderApiUsage(body);
  let accountLabel = userTypeLabel(read(body, 'userType', 'user_type'));
  try {
    const { response: planResponse, body: planBody } = await fetchJsonWithDeadline(
      qoderApiPlanUrl(site),
      { headers },
      deps
    );
    if (planResponse.ok) {
      accountLabel = planTierLabel(planBody) || parseQoderPlanLabel(planBody) || accountLabel;
    }
  } catch (_) {}
  return normalizeLimitProvider({
    provider: 'qoder',
    accountKey: hashKey('qoder', accessToken),
    accountLabel,
    source: 'api',
    status: 'ok',
    updatedAt,
    windows: [usage.window],
    region: site === 'cn' ? 'cn' : 'global'
  });
}

async function fetchQoderWebLimits(cookie, site, options, deps, updatedAt) {
  const origin = qoderOrigin(site);
  const headers = {
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': BROWSER_USER_AGENT,
    Origin: origin,
    Referer: `${origin}/account/usage`,
    'X-Requested-With': 'XMLHttpRequest',
    'Bx-V': '2.5.35'
  };
  const { response, body } = await fetchJsonWithDeadline(qoderUsageUrl(site), {
    headers
  }, deps);
  if (!response.ok) {
    const error = new Error(`Qoder usage returned ${response.status}`);
    error.status = providerStatusFromResponse(response.status);
    throw error;
  }
  const usage = parseQoderUsage(body);
  let accountLabel = '';
  try {
    const { response: planResponse, body: planBody } = await fetchJsonWithDeadline(
      qoderUserPlanUrl(site),
      { headers },
      deps
    );
    if (planResponse.ok) accountLabel = parseQoderPlanLabel(planBody);
  } catch (_) {}
  return normalizeLimitProvider({
    provider: 'qoder',
    accountKey: hashKey('qoder', cookie),
    accountLabel,
    source: 'web',
    status: 'ok',
    updatedAt,
    windows: [usage.window],
    region: site === 'cn' ? 'cn' : 'global'
  });
}

async function fetchQoderLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const accessToken = qoderAccessToken(env, options).replace(/^bearer\s+/i, '').trim();
  const cookie = qoderCookie(env, options);
  const site = qoderSite(options, env);
  if (!accessToken && !cookie) {
    return normalizeLimitProvider({
      provider: 'qoder',
      source: accessToken ? 'api' : 'web',
      status: 'notConfigured',
      updatedAt,
      windows: [],
      region: site === 'cn' ? 'cn' : 'global'
    });
  }
  try {
    if (accessToken) return await fetchQoderApiLimits(accessToken, site, options, deps, updatedAt);
    return await fetchQoderWebLimits(cookie, site, options, deps, updatedAt);
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'qoder',
      source: accessToken ? 'api' : 'web',
      status: error?.status === 'timeout' ? 'unavailable' : error?.status || 'unavailable',
      updatedAt,
      windows: [],
      region: site === 'cn' ? 'cn' : 'global'
    });
  }
}

module.exports = {
  QODER_FETCH_TIMEOUT_MS,
  qoderCookie,
  qoderAccessToken,
  qoderSite,
  qoderOrigin,
  qoderApiOrigin,
  qoderUsageUrl,
  qoderUserPlanUrl,
  qoderApiQuotaUrl,
  qoderApiPlanUrl,
  parseQoderPlanLabel,
  parseQoderUsage,
  parseQoderApiUsage,
  fetchQoderLimits
};
