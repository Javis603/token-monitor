'use strict';

const { normalizeLimitProvider } = require('../../limits/core');
const {
  cleanSecret,
  numberOrNull,
  toIso
} = require('../../limits/providerHelpers');
const { hashKey } = require('../../hashKey');
const { runWithProbeDeadline } = require('../../probeDeadline');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const QODER_FETCH_TIMEOUT_MS = 12_000;

function qoderCookie(env = process.env, options = {}) {
  const explicit = cleanSecret(options.qoderCookie);
  if (explicit) return explicit;
  for (const name of ['QODER_COOKIE', 'TOKEN_MONITOR_QODER_COOKIE']) {
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

function qoderUsageUrl(site = 'global') {
  return `${qoderOrigin(site)}/api/v2/me/usages/big_model_credits`;
}

function qoderUserPlanUrl(site = 'global') {
  return `${qoderOrigin(site)}/api/v1/me/userplan`;
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

// The plan's next refresh is the shared add-on cycle; the personal quota payload
// may only carry a reset for an allowance this account no longer has.
function parseQoderPlanResetAt(body) {
  const payload = body?.data && typeof body.data === 'object' ? body.data : body;
  return toIso(read(payload, 'nextRefreshDate', 'next_refresh_date'));
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

function parseQoderUsage(body, sharedBody) {
  const payload = body?.data && typeof body.data === 'object' ? body.data : body;
  const sharedPayload = sharedBody?.data && typeof sharedBody.data === 'object' ? sharedBody.data : sharedBody;
  const total = parseSummary(quotaSummary(read(payload, 'totalQuota', 'total_quota')));
  if (!total) throw new Error('missing totalQuota.quotaSummary');
  const shared = parseSummary(quotaSummary(
    read(sharedPayload, 'sharedQuota', 'shared_quota') ?? read(payload, 'sharedQuota', 'shared_quota')
  ));
  const usedCredits = total.used + (shared?.used || 0);
  const totalCredits = total.total + (shared?.total || 0);
  const remainingCredits = total.remaining + (shared?.remaining || 0);
  const usagePercentage = totalCredits > 0 ? (usedCredits / totalCredits) * 100 : total.usagePercentage;
  // A zero personal allowance can retain an expired reset date. It does not
  // describe the member's shared cap, whose endpoint may not supply a reset.
  const resetsAt = toIso(read(total.total > 0 ? payload : sharedPayload, 'nextResetAt', 'next_reset_at'));
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

async function fetchQoderLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const cookie = qoderCookie(env, options);
  const site = qoderSite(options, env);
  if (!cookie) {
    return normalizeLimitProvider({
      provider: 'qoder',
      source: 'web',
      status: 'notConfigured',
      updatedAt,
      windows: [],
      region: site === 'cn' ? 'cn' : 'global'
    });
  }
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
  try {
    const { response, body } = await fetchJsonWithDeadline(qoderUsageUrl(site), {
      headers
    }, deps);
    if (!response.ok) {
      const error = new Error(`Qoder usage returned ${response.status}`);
      error.status = response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw error;
    }
    // Organization credits are reported separately from the personal allowance.
    // Only shared_quota is this member's cap; organization_pool is the whole team.
    const { response: sharedResponse, body: sharedBody } = await fetchJsonWithDeadline(
      `${origin}/api/v1/me/organization-shared-usages/big_model_credits`,
      { headers },
      deps
    );
    // A personal account has no organization to report; only a session or
    // service failure should suppress the personal window.
    if (!sharedResponse.ok && sharedResponse.status !== 403 && sharedResponse.status !== 404) {
      const error = new Error(`Qoder shared usage returned ${sharedResponse.status}`);
      error.status = sharedResponse.status === 401
        ? 'unauthorized'
        : sharedResponse.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw error;
    }
    const usage = parseQoderUsage(body, sharedBody);
    let accountLabel = '';
    try {
      const { response: planResponse, body: planBody } = await fetchJsonWithDeadline(
        qoderUserPlanUrl(site),
        { headers },
        deps
      );
      if (planResponse.ok) {
        accountLabel = parseQoderPlanLabel(planBody);
        const planResetsAt = parseQoderPlanResetAt(planBody);
        if (planResetsAt && !usage.resetsAt) {
          usage.resetsAt = planResetsAt;
          usage.window.resetsAt = planResetsAt;
        }
      }
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
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'qoder',
      source: 'web',
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
  qoderSite,
  qoderOrigin,
  qoderUsageUrl,
  qoderUserPlanUrl,
  parseQoderPlanLabel,
  parseQoderUsage,
  fetchQoderLimits
};
