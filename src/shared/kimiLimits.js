'use strict';

const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');

const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
const KIMI_CODE_USAGES_URL = `${KIMI_CODE_BASE_URL}/usages`;
const KIMI_KEY_NAMES = ['KIMI_CODE_API_KEY'];

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

async function fetchKimiLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const key = kimiToken(env, options.kimiApiKey);
  if (!key) {
    return normalizeLimitProvider({
      provider: 'kimi',
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: []
    });
  }

  try {
    const response = await (deps.fetch || fetch)(KIMI_CODE_USAGES_URL, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      }
    });
    if (!response.ok) {
      const error = new Error(`Kimi usage returned ${response.status}`);
      error.status = response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw error;
    }
    const usage = parseKimiUsage(await response.json());
    return normalizeLimitProvider({
      provider: 'kimi',
      accountKey: hashKey('kimi', key),
      source: 'api',
      status: usage.windows.length ? 'ok' : 'unavailable',
      updatedAt,
      windows: usage.windows
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'kimi',
      source: 'api',
      status: error?.status || 'unavailable',
      updatedAt,
      windows: []
    });
  }
}

module.exports = {
  KIMI_CODE_BASE_URL,
  KIMI_CODE_USAGES_URL,
  kimiToken,
  parseKimiUsage,
  fetchKimiLimits
};
