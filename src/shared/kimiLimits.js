'use strict';

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');
const { runWithProbeDeadline } = require('./probeDeadline');

const KIMI_FETCH_TIMEOUT_MS = 12_000;

const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
const KIMI_CODE_USAGES_URL = `${KIMI_CODE_BASE_URL}/usages`;
const KIMI_WEB_BASE_URL = 'https://www.kimi.com/apiv2';
const KIMI_WEB_USAGES_URL = `${KIMI_WEB_BASE_URL}/kimi.gateway.billing.v1.BillingService/GetUsages`;
const KIMI_MEMBERSHIP_STATS_URL = `${KIMI_WEB_BASE_URL}/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats`;
const KIMI_KEY_NAMES = ['KIMI_CODE_API_KEY'];
const KIMI_WEB_TOKEN_NAMES = ['KIMI_AUTH_TOKEN', 'KIMI_MANUAL_COOKIE'];
const KIMI_MEMBERSHIP_GRACE_MS = 2000;

// The Kimi Code usage API reports the weekly quota in top-level `usage` and
// the rolling 5-hour rate limit in `limits[]`. Compatible proxies may expose
// more than one limits[] entry, so duration-based classification remains
// defensive. Kimi Code itself has no monthly/billing window here.
const KIMI_SESSION_MAX_MINUTES = 6 * 60;

function cleanSecret(value) {
  let raw = value;
  if (typeof raw !== 'string') return '';
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function kimiToken(env = process.env, explicitKey = '') {
  const explicit = cleanSecret(explicitKey);
  if (explicit) return explicit;
  for (const name of KIMI_KEY_NAMES) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

function normalizeKimiWebToken(value) {
  let raw = cleanSecret(value);
  if (!raw) return '';
  raw = raw.replace(/^authorization\s*:\s*/i, '').replace(/^bearer\s+/i, '').trim();
  const cookieMatch = raw.match(/(?:^|[;\s])kimi-auth=([^;\s'"]+)/i);
  if (cookieMatch) return cookieMatch[1].trim();
  if (/^(?:cookie\s*:|curl\s)/i.test(raw) || raw.includes(';')) return '';
  return raw;
}

function kimiWebToken(env = process.env, explicitToken = '') {
  const explicit = normalizeKimiWebToken(explicitToken);
  if (explicit) return explicit;
  for (const name of KIMI_WEB_TOKEN_NAMES) {
    const token = normalizeKimiWebToken(env[name]);
    if (token) return token;
  }
  return '';
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

// Best-effort duration+timeUnit -> minutes conversion. Stay defensive about
// unit spelling/casing because compatible proxies may normalize field values.
// The Kimi Code API uses protobuf-style enum values
// like "TIME_UNIT_MINUTE" / "TIME_UNIT_DAY" (the 5-hour session window is
// reported as duration=300, timeUnit="TIME_UNIT_MINUTE"), so this matches by
// substring rather than prefix.
function kimiWindowMinutes(duration, timeUnit) {
  const amount = numberOrNull(duration);
  if (amount === null || amount <= 0) return null;
  const unit = String(timeUnit || '').trim().toUpperCase();
  if (unit.includes('MIN')) return amount;
  if (unit.includes('HOUR')) return amount * 60;
  if (unit.includes('DAY')) return amount * 24 * 60;
  if (unit.includes('WEEK')) return amount * 7 * 24 * 60;
  if (unit.includes('MONTH')) return amount * 30 * 24 * 60;
  return null;
}

function classifyKimiWindow(minutes) {
  if (minutes !== null && minutes <= KIMI_SESSION_MAX_MINUTES) return 'session';
  return 'weekly';
}

function classifyKimiUsageName(name) {
  const raw = String(name || '').toLowerCase();
  if (/(hour|小时|時間|시간)/.test(raw)) return 'session';
  return 'weekly';
}

// Picks the first numeric value found under any of the given key names. The
// canonical Kimi fields come first; aliases keep compatible proxies and older
// shapes from failing just because they use snake_case or generic quota names.
function pickNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = numberOrNull(obj[key]);
    if (value !== null) return value;
  }
  return null;
}

function pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function pickRaw(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

const DETAIL_USED_KEYS = ['used', 'usedValue', 'used_value', 'usedAmount', 'used_amount', 'currentValue', 'current_value', 'consumed', 'consumedValue', 'consumed_value'];
const DETAIL_LIMIT_KEYS = ['limit', 'limitValue', 'limit_value', 'total', 'totalValue', 'total_value', 'quota', 'quotaValue', 'quota_value', 'max', 'maxValue', 'max_value'];
const DETAIL_REMAINING_KEYS = ['remaining', 'remainingValue', 'remaining_value'];
const DETAIL_PERCENT_KEYS = ['percent', 'percentage', 'usedPercent', 'used_percent', 'usagePercentage', 'usage_percentage'];
const DETAIL_RESET_KEYS = ['resetTime', 'reset_time', 'resetAt', 'reset_at'];
const WINDOW_DURATION_KEYS = ['duration', 'windowDuration', 'window_duration', 'size', 'value', 'length'];
const WINDOW_UNIT_KEYS = ['timeUnit', 'time_unit', 'unit', 'windowUnit', 'window_unit'];
const LIMITS_ARRAY_KEYS = ['limits', 'limitInfos', 'limit_infos', 'rateLimits', 'rate_limits', 'windows'];
const ENTRY_DETAIL_KEYS = ['detail', 'usage', 'quota'];
const ENTRY_WINDOW_KEYS = ['window', 'period', 'rateLimit', 'rate_limit', 'timeWindow', 'time_window'];

function firstArray(body, keys) {
  for (const key of keys) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
}

function firstObject(entry, keys) {
  for (const key of keys) {
    if (entry?.[key] && typeof entry[key] === 'object') return entry[key];
  }
  return entry;
}

// Derives a used% from a detail block that may report used+limit, limit+
// remaining, or an already-computed percentage — whichever the real payload
// actually carries.
function usedPercentFromDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const used = pickNumber(detail, DETAIL_USED_KEYS);
  const limit = pickNumber(detail, DETAIL_LIMIT_KEYS);
  if (used !== null && limit !== null && limit > 0) {
    return Math.max(0, Math.min(100, (used / limit) * 100));
  }
  const remaining = pickNumber(detail, DETAIL_REMAINING_KEYS);
  if (limit !== null && limit > 0 && remaining !== null) {
    return Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
  }
  const percent = pickNumber(detail, DETAIL_PERCENT_KEYS);
  if (percent !== null) return Math.max(0, Math.min(100, percent));
  return null;
}

function kindLabel(kind) {
  if (kind === 'session') return '5-hour';
  return 'Weekly';
}

function limitEntries(body) {
  return firstArray(body, LIMITS_ARRAY_KEYS)
    .map((entry) => {
      const detail = firstObject(entry, ENTRY_DETAIL_KEYS);
      const usedPercent = usedPercentFromDetail(detail);
      if (usedPercent === null) return null;
      const window = firstObject(entry, ENTRY_WINDOW_KEYS);
      const duration = pickNumber(window, WINDOW_DURATION_KEYS);
      const timeUnit = pickString(window, WINDOW_UNIT_KEYS);
      const resetAt = pickRaw(detail, DETAIL_RESET_KEYS) ?? pickRaw(window, DETAIL_RESET_KEYS);
      return {
        usedPercent,
        windowMinutes: kimiWindowMinutes(duration, timeUnit),
        resetsAt: toIso(resetAt)
      };
    })
    .filter(Boolean);
}

// If a compatible response flattens exactly two quota windows into limits[],
// keep both even when their unit spelling cannot be parsed. The canonical Kimi
// response does not need this fallback: it has one limits[] session entry and
// carries the weekly quota in top-level `usage`.
function classifyKimiPair(entries) {
  const [a, b] = entries;
  const aMinutes = a.windowMinutes;
  const bMinutes = b.windowMinutes;
  if (aMinutes !== null && bMinutes !== null && classifyKimiWindow(aMinutes) !== classifyKimiWindow(bMinutes)) {
    return [
      { ...a, kind: classifyKimiWindow(aMinutes) },
      { ...b, kind: classifyKimiWindow(bMinutes) }
    ];
  }
  const [session, weekly] = aMinutes !== null || bMinutes !== null
    ? ((bMinutes === null || (aMinutes !== null && aMinutes <= bMinutes)) ? [a, b] : [b, a])
    : [a, b];
  return [
    { ...session, kind: 'session' },
    { ...weekly, kind: 'weekly' }
  ];
}

function parseKimiUsage(rawBody) {
  // Several other vendors integrated in this codebase (e.g. Qoder) wrap their
  // payload in a `data` envelope; be defensive in case Kimi does too.
  const body = rawBody?.data && typeof rawBody.data === 'object' ? rawBody.data : rawBody;
  const windows = [];
  const seenKinds = new Set();
  const entries = limitEntries(body);
  const classified = entries.length === 2 ? classifyKimiPair(entries) : entries.map((entry) => ({
    ...entry,
    kind: classifyKimiWindow(entry.windowMinutes)
  }));

  for (const entry of classified) {
    seenKinds.add(entry.kind);
    windows.push({
      kind: entry.kind,
      label: kindLabel(entry.kind),
      usedPercent: entry.usedPercent,
      remainingPercent: Math.max(0, Math.min(100, 100 - entry.usedPercent)),
      windowMinutes: entry.windowMinutes || undefined,
      resetsAt: entry.resetsAt || undefined,
      showMeter: true
    });
  }

  const usage = body?.usage;
  if (usage && typeof usage === 'object') {
    const usedPercent = usedPercentFromDetail(usage);
    if (usedPercent !== null) {
      const name = pickString(usage, ['name', 'label', 'title']);
      const kind = classifyKimiUsageName(name);
      if (!seenKinds.has(kind)) {
        const resetAt = pickRaw(usage, ['reset_at', 'resetAt', 'resetTime', 'reset_time']);
        windows.push({
          kind,
          label: name.trim() || kindLabel(kind),
          usedPercent,
          remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
          resetsAt: toIso(resetAt),
          showMeter: true
        });
      }
    }
  }

  return { windows };
}

function objectAt(body, keys) {
  for (const key of keys) {
    if (body?.[key] && typeof body[key] === 'object' && !Array.isArray(body[key])) return body[key];
  }
  return null;
}

function ratioPercent(value) {
  const ratio = numberOrNull(value);
  if (ratio === null || ratio < 0) return null;
  const percent = ratio <= 1 ? ratio * 100 : ratio;
  return Math.max(0, Math.min(100, percent));
}

function ratioLabel(value) {
  return Number(value.toFixed(2)).toString();
}

function membershipRateWindow(body, keys, kind, label, windowMinutes) {
  const source = objectAt(body, keys);
  if (!source || source.enabled === false) return null;
  const usedPercent = ratioPercent(source.ratio ?? source.usedRatio ?? source.used_ratio);
  if (usedPercent === null) return null;
  const resetsAt = toIso(source.resetTime ?? source.reset_time ?? source.resetAt ?? source.reset_at);
  return {
    kind,
    label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes,
    resetsAt: resetsAt || undefined,
    showMeter: true
  };
}

function parseKimiMembershipStats(rawBody) {
  const body = rawBody?.data && typeof rawBody.data === 'object' ? rawBody.data : rawBody;
  const windows = [];
  const session = membershipRateWindow(
    body,
    ['ratelimitCode5h', 'ratelimit_code_5h', 'ratelimit5h', 'ratelimit_5h'],
    'session',
    '5-hour',
    5 * 60
  );
  const weekly = membershipRateWindow(
    body,
    ['ratelimitCode7d', 'ratelimit_code_7d', 'ratelimit7d', 'ratelimit_7d'],
    'weekly',
    'Weekly',
    7 * 24 * 60
  );
  if (session) windows.push(session);
  if (weekly) windows.push(weekly);

  const balance = objectAt(body, ['subscriptionBalance', 'subscription_balance']);
  const feature = String(balance?.feature || '').trim();
  const type = String(balance?.type || '').trim();
  const compatibleBalance = balance
    && (!feature || feature === 'FEATURE_OMNI')
    && (!type || type === 'SUBSCRIPTION');
  if (compatibleBalance) {
    const usedPercent = ratioPercent(balance.amountUsedRatio ?? balance.amount_used_ratio);
    if (usedPercent !== null) {
      const codeUsedPercent = ratioPercent(balance.kimiCodeUsedRatio ?? balance.kimi_code_used_ratio);
      const safeCodePercent = codeUsedPercent === null ? null : Math.min(usedPercent, codeUsedPercent);
      const detail = safeCodePercent === null
        ? ''
        : `Kimi ${ratioLabel(Math.max(0, usedPercent - safeCodePercent))}% · Code ${ratioLabel(safeCodePercent)}%`;
      windows.push({
        kind: 'billing',
        label: 'Monthly',
        usedPercent,
        remainingPercent: Math.max(0, 100 - usedPercent),
        resetsAt: toIso(balance.expireTime ?? balance.expire_time) || undefined,
        detail,
        showMeter: true
      });
    }
  }
  return { windows };
}

function parseKimiWebUsage(rawBody) {
  const body = rawBody?.data && typeof rawBody.data === 'object' ? rawBody.data : rawBody;
  const usages = Array.isArray(body?.usages) ? body.usages : [];
  const coding = usages.find((entry) => entry?.scope === 'FEATURE_CODING');
  if (!coding) return { windows: [] };
  return parseKimiUsage({ usage: coding.detail, limits: coding.limits });
}

function kimiRequestError(label, response) {
  const error = new Error(`${label} returned ${response.status}`);
  error.status = response.status === 401 || response.status === 403
    ? 'unauthorized'
    : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
  return error;
}

async function fetchJson(url, init, deps, label) {
  const inputSignals = [deps.signal, init?.signal].filter(Boolean);
  const parentSignal = inputSignals.length > 1 ? AbortSignal.any(inputSignals) : inputSignals[0];
  const deadlineMs = Number(deps.kimiFetchTimeoutMs || deps.fetchTimeoutMs || KIMI_FETCH_TIMEOUT_MS);
  return runWithProbeDeadline(async ({ signal }) => {
    const response = await (deps.fetch || fetch)(url, { ...init, signal });
    if (!response.ok) throw kimiRequestError(label, response);
    return response.json();
  }, { signal: parentSignal, deadlineMs });
}

function jwtSessionHeaders(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      ...(payload.device_id ? { 'x-msh-device-id': String(payload.device_id) } : {}),
      ...(payload.ssid ? { 'x-msh-session-id': String(payload.ssid) } : {}),
      ...(payload.sub ? { 'x-traffic-id': String(payload.sub) } : {})
    };
  } catch (_) {
    return {};
  }
}

function kimiWebHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Cookie: `kimi-auth=${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://www.kimi.com',
    Referer: 'https://www.kimi.com/code/console',
    'connect-protocol-version': '1',
    'x-language': 'en-US',
    'x-msh-platform': 'web',
    ...jwtSessionHeaders(token)
  };
}

async function settledValue(promise) {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return { value: null, error };
  }
}

async function settledWithin(promise, timeoutMs, onTimeout) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        resolve({ value: null, error: null });
      }
    }, timeoutMs);
  });
  const result = await Promise.race([
    settledValue(promise),
    timeout
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

async function fetchKimiWebWindows(token, deps = {}) {
  const headers = kimiWebHeaders(token);
  const membershipController = typeof AbortController === 'function' ? new AbortController() : null;
  const configuredGrace = numberOrNull(deps.kimiMembershipGraceMs);
  const membershipGraceMs = configuredGrace !== null && configuredGrace >= 0
    ? configuredGrace
    : KIMI_MEMBERSHIP_GRACE_MS;
  // Membership stats enrich the reliable GetUsages baseline with the shared
  // monthly pool (and may provide fresher 5h/7d ratios). Bound this optional
  // request from launch time so a slow endpoint never delays existing windows.
  const membershipOutcome = settledWithin(
    fetchJson(KIMI_MEMBERSHIP_STATS_URL, {
      method: 'POST',
      headers,
      body: '{}',
      ...(membershipController ? { signal: membershipController.signal } : {})
    }, deps, 'Kimi membership stats'),
    membershipGraceMs,
    () => membershipController?.abort()
  );
  const usageOutcome = settledValue(fetchJson(KIMI_WEB_USAGES_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ scope: ['FEATURE_CODING'] })
  }, deps, 'Kimi web usage'));
  const [membership, usage] = await Promise.all([membershipOutcome, usageOutcome]);
  const membershipWindows = membership.value ? parseKimiMembershipStats(membership.value).windows : [];
  const usageWindows = usage.value ? parseKimiWebUsage(usage.value).windows : [];
  return {
    windows: mergeKimiWindows(membershipWindows, usageWindows),
    errors: [membership.error, usage.error].filter(Boolean)
  };
}

async function fetchKimiCodeWindows(key, deps = {}) {
  const body = await fetchJson(KIMI_CODE_USAGES_URL, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json'
    }
  }, deps, 'Kimi usage');
  return parseKimiUsage(body).windows;
}

function mergeKimiWindows(...groups) {
  const byKind = new Map();
  for (const windows of groups) {
    for (const window of windows || []) {
      if (!byKind.has(window.kind)) byKind.set(window.kind, window);
    }
  }
  return ['session', 'weekly', 'billing'].map((kind) => byKind.get(kind)).filter(Boolean);
}

function failureStatus(errors) {
  const statuses = errors.map((error) => error?.status).filter(Boolean);
  if (statuses.includes('unauthorized')) return 'unauthorized';
  if (statuses.includes('sourceRateLimited')) return 'sourceRateLimited';
  return 'unavailable';
}

async function fetchKimiLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const key = kimiToken(env, options.kimiApiKey);
  const webToken = kimiWebToken(env, options.kimiWebAccessToken);
  if (!webToken && !key) {
    return normalizeLimitProvider({
      provider: 'kimi',
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: []
    });
  }

  const errors = [];
  let webWindows = [];
  let codeWindows = [];
  if (webToken) {
    const web = await fetchKimiWebWindows(webToken, deps);
    webWindows = web.windows;
    errors.push(...web.errors);
  }
  const missingCodeWindow = !webWindows.some((window) => window.kind === 'session')
    || !webWindows.some((window) => window.kind === 'weekly');
  if (key && (!webToken || missingCodeWindow)) {
    try {
      codeWindows = await fetchKimiCodeWindows(key, deps);
    } catch (error) {
      errors.push(error);
    }
  }
  const windows = mergeKimiWindows(webWindows, codeWindows);
  const source = webWindows.length ? 'web' : 'api';
  // Keep the configured logical account stable when a temporary web failure
  // makes this tick report Code API fallback windows only.
  const accountSecret = webToken || key;
  return normalizeLimitProvider({
    provider: 'kimi',
    accountKey: accountSecret ? hashKey('kimi', accountSecret) : '',
    source,
    status: windows.length ? 'ok' : failureStatus(errors),
    updatedAt,
    windows
  });
}

module.exports = {
  KIMI_FETCH_TIMEOUT_MS,
  KIMI_CODE_BASE_URL,
  KIMI_CODE_USAGES_URL,
  KIMI_WEB_BASE_URL,
  KIMI_WEB_USAGES_URL,
  KIMI_MEMBERSHIP_STATS_URL,
  kimiToken,
  kimiWebToken,
  parseKimiUsage,
  parseKimiWebUsage,
  parseKimiMembershipStats,
  fetchKimiLimits
};
