'use strict';

// Aliyun Bailian Token Plan (mainland Team/enterprise) limits collector.
//
// This follows CodexBar's Alibaba Token Plan provider:
//   - auth is a Bailian console Cookie header, not a public API token
//   - the endpoint is the OneConsole internal GetSubscriptionSummary gateway
//   - the response contains used/total/remaining credits and an expiry date
//
// The widget/agent configure the cookie through:
//   - settings: bailianCookie
//   - env:      ALIBABA_TOKEN_PLAN_COOKIE

const { hashKey } = require('./hashKey');
const { normalizeLimitProvider } = require('./limits');
const { BROWSER_USER_AGENT } = require('./browserUserAgent');

const BAILIAN_API_URL = 'https://bailian.console.aliyun.com/data/api.json?action=GetSubscriptionSummary&product=BssOpenAPI-V3&_tag=';
const BAILIAN_DASHBOARD_URL = 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/enterprise';
const BAILIAN_USER_INFO_URL = 'https://bailian.console.aliyun.com/tool/user/info.json';
const BAILIAN_ORIGIN = 'https://bailian.console.aliyun.com';
const BAILIAN_PRODUCT_CODE = 'sfm_tokenplanteams_dp_cn';
const BAILIAN_REGION = 'cn-beijing';

const PLAN_NAME_KEYS = [
  'planName', 'plan_name', 'packageName', 'package_name', 'commodityName',
  'commodity_name', 'specType', 'instanceName', 'displayName', 'ProductName',
  'productName', 'name', 'title', 'planType'
];
const TOTAL_KEYS = [
  'totalQuota', 'total_quota', 'totalCredits', 'totalCredit', 'quota',
  'creditLimit', 'creditsTotal', 'monthlyTotalQuota', 'amount', 'totalValue',
  'TotalValue', 'cycleTotalValue'
];
const REMAINING_KEYS = [
  'remainingQuota', 'remainQuota', 'remainingCredits', 'remainingCredit',
  'availableCredits', 'balance', 'remaining', 'availableAmount', 'remainAmount',
  'totalSurplusValue', 'TotalSurplusValue', 'surplusValue', 'SurplusValue',
  'cycleSurplusValue', 'CycleSurplusValue'
];
const COUNT_KEYS = [
  'totalCount', 'TotalCount', 'subscriptionTotalNumber', 'SubscriptionTotalNumber'
];
const RESET_KEYS = [
  'nextRefreshTime', 'resetTime', 'periodEndTime', 'billingCycleEnd',
  'billCycleEndTime', 'expireTime', 'expirationTime', 'endTime', 'validEndTime',
  'instanceEndTime', 'EndTime', 'cycleEndTime', 'CycleEndTime',
  'nearestExpireDate', 'NearestExpireDate'
];
const SEC_TOKEN_KEYS = ['secToken', 'sec_token'];

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeBailianCookieHeader(value) {
  const raw = cleanText(value).replace(/^cookie\s*:\s*/i, '');
  if (!raw) return '';
  // A usable Cookie header must contain at least one name=value pair.
  return raw.includes('=') ? raw : '';
}

function bailianCookie(env = process.env, options = {}) {
  return normalizeBailianCookieHeader(
    options.bailianCookie
    || env.ALIBABA_TOKEN_PLAN_COOKIE
    || ''
  );
}

function findFirstNumber(keys, value) {
  if (value && typeof value === 'object') {
    for (const key of keys) {
      if (key in value) {
        const parsed = numberOrNull(value[key]);
        if (parsed !== null) return parsed;
      }
    }
    for (const nested of Object.values(value)) {
      const found = findFirstNumber(keys, nested);
      if (found !== null) return found;
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNumber(keys, item);
      if (found !== null) return found;
    }
  }
  return null;
}

function findFirstString(keys, value) {
  if (value && typeof value === 'object') {
    for (const key of keys) {
      if (key in value && typeof value[key] === 'string' && value[key].trim()) {
        return value[key].trim();
      }
    }
    for (const nested of Object.values(value)) {
      const found = findFirstString(keys, nested);
      if (found !== null) return found;
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstString(keys, item);
      if (found !== null) return found;
    }
  }
  return null;
}

function findFirstDate(keys, value) {
  const raw = findFirstString(keys, value) ?? findFirstNumber(keys, value);
  if (raw === null || raw === '') return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseBailianUsage(body) {
  let json = body;
  if (typeof body === 'string') {
    try {
      json = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!json || typeof json !== 'object') return null;

  const data = json.data || json.Data || json.successResponse || json;
  const nested = data?.Data || data?.data || data;
  const uid = numberOrNull(nested?.Uid ?? nested?.uid ?? data?.Uid ?? data?.uid);
  const total = findFirstNumber(TOTAL_KEYS, nested) ?? findFirstNumber(TOTAL_KEYS, data) ?? findFirstNumber(TOTAL_KEYS, json);
  const remaining = findFirstNumber(REMAINING_KEYS, nested) ?? findFirstNumber(REMAINING_KEYS, data) ?? findFirstNumber(REMAINING_KEYS, json);
  const totalCount = findFirstNumber(COUNT_KEYS, nested) ?? findFirstNumber(COUNT_KEYS, data) ?? findFirstNumber(COUNT_KEYS, json);
  const planName = findFirstString(PLAN_NAME_KEYS, nested)
    || findFirstString(PLAN_NAME_KEYS, data)
    || findFirstString(PLAN_NAME_KEYS, json);
  const resetsAt = findFirstDate(RESET_KEYS, nested)
    || findFirstDate(RESET_KEYS, data)
    || findFirstDate(RESET_KEYS, json);
  const used = total !== null && remaining !== null ? Math.max(0, total - remaining) : null;

  return {
    uid: uid === null ? null : String(uid),
    total,
    used,
    remaining,
    totalCount,
    planName: planName || (total !== null || remaining !== null || totalCount !== null ? 'TOKEN PLAN' : null),
    resetsAt
  };
}

function cookieValue(cookieHeader, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieHeader);
  return match ? match[1] : '';
}

function bailianHeaders(cookieHeader) {
  const headers = {
    Accept: '*/*',
    Cookie: cookieHeader,
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: BAILIAN_ORIGIN,
    Referer: BAILIAN_DASHBOARD_URL,
    'User-Agent': BROWSER_USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest'
  };
  const csrf = cookieValue(cookieHeader, 'login_aliyunid_csrf') || cookieValue(cookieHeader, 'csrf');
  if (csrf) {
    headers['x-xsrf-token'] = csrf;
    headers['x-csrf-token'] = csrf;
  }
  return headers;
}

async function resolveBailianSecToken(cookieHeader, deps = {}) {
  const cookieToken = cookieValue(cookieHeader, 'sec_token');
  if (cookieToken) return cookieToken;
  const fetchFn = deps.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') return '';
  try {
    const response = await fetchFn(BAILIAN_USER_INFO_URL, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Cookie: cookieHeader,
        Referer: `${BAILIAN_ORIGIN}/`,
        'User-Agent': BROWSER_USER_AGENT
      },
      signal: deps.signal
    });
    if (!response.ok) return '';
    const body = await response.json().catch(() => null);
    return findFirstString(SEC_TOKEN_KEYS, body) || '';
  } catch (_) {
    return '';
  }
}

function statusRow(provider, status, updatedAt, extra = {}) {
  return normalizeLimitProvider({
    provider,
    source: 'web',
    status,
    updatedAt,
    windows: [],
    ...extra
  });
}

async function fetchBailianLimits(options = {}, deps = {}) {
  const updatedAt = new Date((deps.now || Date.now)()).toISOString();
  const cookieHeader = bailianCookie(deps.env || process.env, options);
  if (!cookieHeader) return [statusRow('bailian', 'notConfigured', updatedAt)];

  const fetchFn = deps.fetch || globalThis.fetch;
  const params = JSON.stringify({ ProductCode: BAILIAN_PRODUCT_CODE });
  const body = new URLSearchParams({
    product: 'BssOpenAPI-V3',
    action: 'GetSubscriptionSummary',
    params,
    region: BAILIAN_REGION
  });
  const secToken = await resolveBailianSecToken(cookieHeader, deps);
  if (secToken) body.set('sec_token', secToken);

  try {
    const response = await fetchFn(BAILIAN_API_URL, {
      method: 'POST',
      headers: bailianHeaders(cookieHeader),
      body: body.toString(),
      signal: deps.signal
    });

    if (response.status === 401 || response.status === 403) {
      return [statusRow('bailian', 'unauthorized', updatedAt)];
    }
    if (response.status === 429) {
      return [statusRow('bailian', 'sourceRateLimited', updatedAt)];
    }
    if (!response.ok) {
      return [statusRow('bailian', 'unavailable', updatedAt)];
    }

    const text = await response.text();
    const usage = parseBailianUsage(text);
    if (!usage || (usage.total === null && usage.remaining === null && usage.totalCount === null)) {
      return [statusRow('bailian', 'unavailable', updatedAt)];
    }

    const usedPercent = usage.total !== null && usage.total > 0 && usage.used !== null
      ? Math.max(0, Math.min(100, (usage.used / usage.total) * 100))
      : null;
    const accountKey = usage.uid
      ? hashKey('bailian', usage.uid)
      : hashKey('bailian', cookieHeader);

    return [
      normalizeLimitProvider({
        provider: 'bailian',
        accountKey,
        accountLabel: usage.planName || 'Token Plan',
        source: 'web',
        status: 'ok',
        updatedAt,
        windows: [{
          kind: 'billing',
          label: 'Token Plan',
          used: usage.used,
          limit: usage.total,
          remaining: usage.remaining,
          usedPercent,
          resetsAt: usage.resetsAt,
          showMeter: usedPercent !== null
        }]
      })
    ];
  } catch (error) {
    return [statusRow('bailian', error?.status || 'unavailable', updatedAt)];
  }
}

module.exports = {
  BAILIAN_API_URL,
  BAILIAN_DASHBOARD_URL,
  bailianCookie,
  fetchBailianLimits,
  normalizeBailianCookieHeader,
  parseBailianUsage
};