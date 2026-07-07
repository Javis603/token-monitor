'use strict';

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');

const QODER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

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
    'User-Agent': QODER_USER_AGENT,
    Origin: origin,
    Referer: `${origin}/account/usage`,
    'X-Requested-With': 'XMLHttpRequest',
    'Bx-V': '2.5.35'
  };
  try {
    const response = await (deps.fetch || fetch)(qoderUsageUrl(site), {
      headers
    });
    if (!response.ok) {
      const error = new Error(`Qoder usage returned ${response.status}`);
      error.status = response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw error;
    }
    const usage = parseQoderUsage(await response.json());
    let accountLabel = '';
    try {
      const planResponse = await (deps.fetch || fetch)(qoderUserPlanUrl(site), { headers });
      if (planResponse.ok) accountLabel = parseQoderPlanLabel(await planResponse.json());
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
      status: error?.status || 'unavailable',
      updatedAt,
      windows: [],
      region: site === 'cn' ? 'cn' : 'global'
    });
  }
}

module.exports = {
  qoderCookie,
  qoderSite,
  qoderOrigin,
  qoderUsageUrl,
  qoderUserPlanUrl,
  parseQoderPlanLabel,
  parseQoderUsage,
  fetchQoderLimits
};
