'use strict';

const { BROWSER_USER_AGENT } = require('../../browserUserAgent');
const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const {
  cleanSecret,
  envValue,
  errorWithStatus,
  numberOrNull,
  providerStatusFromError,
  statusForHttp,
  toIso
} = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');
const { HARK_COOKIE_NAME, readHarkDesktopSession } = require('./desktop');

const HARK_FETCH_TIMEOUT_MS = 12_000;
const HARK_ORIGIN = 'https://hark.com';
const HARK_SUMMARY_URL = `${HARK_ORIGIN}/api/billing/summary`;
// WebKit percent-encodes better-auth signatures. Decode for validation and
// account identity; the Cookie header must keep the accepted spelling.
const HARK_BARE_SESSION = /^[A-Za-z0-9]{16,128}\.[A-Za-z0-9+/_-]{16,256}={0,2}$/;
// The summary's plan.name uses a superscript the shared label sanitizer drops,
// so the id is the stable display name.
const HARK_PLAN_LABELS = {
  free: 'Hark Pro',
  pro: 'Hark Pro 2',
  scale: 'Hark Pro 3',
  pro4: 'Hark Pro 4'
};

function acceptHarkSessionToken(token) {
  const value = String(token || '').trim();
  if (!value || /[\u0000-\u001f\u007f;]/u.test(value)) return '';
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '';
  }
  if (/[\u0000-\u001f\u007f;]/u.test(decoded)) return '';
  return HARK_BARE_SESSION.test(decoded) ? value : '';
}

function normalizeHarkSessionToken(value) {
  const raw = cleanSecret(value).replace(/^cookie\s*:\s*/iu, '');
  if (!raw || /[\u0000-\u001f\u007f]/u.test(raw)) return '';
  const match = /(?:^|;)\s*__Secure-hark\.session_token\s*=\s*([^;]+)/i.exec(raw);
  if (match) return acceptHarkSessionToken(match[1]);
  if (raw.includes(';')) return '';
  return acceptHarkSessionToken(raw);
}

function harkCookie(env = process.env, options = {}) {
  return options.harkCookie
    || envValue(env, 'TOKEN_MONITOR_HARK_COOKIE')
    || envValue(env, 'HARK_COOKIE')
    || '';
}

function tokenWindow(kind, label, used, limit, resetsAt) {
  const ceiling = numberOrNull(limit);
  const spent = numberOrNull(used);
  if (ceiling === null || ceiling <= 0) return null;
  if (spent === null || spent < 0) throw errorWithStatus('unavailable', 'Hark billing summary changed');
  return {
    kind,
    label,
    used: spent,
    limit: ceiling,
    remaining: Math.max(0, ceiling - spent),
    resetsAt: toIso(resetsAt)
  };
}

function featureLabel(feature, period, suffix) {
  const name = feature === 'message' ? 'Messages' : String(feature || '').trim();
  const when = period === 'day' ? 'Daily' : period === 'month' ? 'Monthly' : '';
  return [when, name, suffix].filter(Boolean).join(' ');
}

function windowsFromSummary(body) {
  const plan = body?.plan;
  const meters = body?.meters;
  if (!plan || typeof plan !== 'object' || !meters || typeof meters !== 'object') {
    throw errorWithStatus('unavailable', 'Hark billing summary changed');
  }
  const windows = [];
  const tokens = meters.harkTokens;
  if (plan.unlimited !== true) {
    if (!tokens || numberOrNull(tokens.dailyLimit) === null || numberOrNull(tokens.poolLimit) === null) {
      throw errorWithStatus('unavailable', 'Hark billing summary changed');
    }
    const daily = tokenWindow('daily', 'Daily', tokens.dailyUsed, tokens.dailyLimit, tokens.dailyResetsAt);
    const pool = tokenWindow('billing', 'Monthly', tokens.poolUsed, tokens.poolLimit, tokens.poolResetsAt);
    if (daily) windows.push(daily);
    if (pool) windows.push(pool);
  }
  if (plan.unlimited !== true && Array.isArray(meters.perFeature)) {
    for (const row of meters.perFeature) {
      if (!row || typeof row !== 'object') continue;
      const period = row.period === 'day' || row.period === 'month' ? row.period : '';
      const kind = period === 'day' ? 'daily' : 'billing';
      const count = tokenWindow(kind, featureLabel(row.feature, period), row.countUsed, row.countLimit, row.resetsAt);
      const featureTokens = tokenWindow(kind, featureLabel(row.feature, period, 'tokens'), row.harkUsed, row.harkLimit, row.resetsAt);
      if (count) windows.push(count);
      if (featureTokens) windows.push(featureTokens);
    }
  }
  const topup = body.autoTopup;
  const spentMinor = numberOrNull(topup?.spentThisPeriodMinor);
  if (topup?.enabled === true && spentMinor !== null && spentMinor > 0) {
    windows.push({
      kind: 'billing',
      metric: 'spend',
      label: 'Top-up',
      used: spentMinor / 100,
      currency: 'USD',
      showMeter: false
    });
  }
  const named = typeof plan.name === 'string' ? plan.name.trim() : '';
  return {
    planLabel: HARK_PLAN_LABELS[plan.id] || named,
    windows
  };
}

async function fetchHarkLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const updatedAt = new Date((deps.now || Date.now)()).toISOString();
  const supplied = harkCookie(env, options);
  const base = {
    provider: 'hark',
    source: supplied ? 'web' : 'local',
    sourceDetail: supplied ? 'managed' : 'app',
    updatedAt,
    windows: []
  };

  let token = '';
  if (supplied) {
    token = normalizeHarkSessionToken(supplied);
    if (!token) return normalizeLimitProvider({ ...base, status: 'unauthorized' });
  } else {
    try {
      token = normalizeHarkSessionToken((deps.readHarkDesktopSession || readHarkDesktopSession)(deps.harkDesktopOptions || {}));
    } catch (error) {
      return normalizeLimitProvider({ ...base, status: providerStatusFromError(error) });
    }
    if (!token) return normalizeLimitProvider({ ...base, status: 'notConfigured' });
  }

  base.accountKey = hashKey('hark', decodeURIComponent(token));
  const previous = (options.previousLimits?.providers || [])
    .filter((row) => row.provider === 'hark' && row.accountKey && row.accountKey !== base.accountKey);
  let provider;
  try {
    const body = await runWithProbeDeadline(async ({ signal }) => {
      const response = await (deps.fetch || fetch)(HARK_SUMMARY_URL, {
        headers: {
          Accept: 'application/json',
          Cookie: `${HARK_COOKIE_NAME}=${token}`,
          'User-Agent': BROWSER_USER_AGENT
        },
        signal
      });
      if (!response.ok) {
        throw errorWithStatus(statusForHttp(response.status), `Hark billing summary returned ${response.status}`);
      }
      return response.json();
    }, { signal: deps.signal, deadlineMs: deps.harkFetchTimeoutMs || deps.fetchTimeoutMs || HARK_FETCH_TIMEOUT_MS });
    const parsed = windowsFromSummary(body);
    provider = normalizeLimitProvider({
      ...base,
      planLabel: parsed.planLabel,
      status: 'ok',
      windows: parsed.windows
    });
  } catch (error) {
    const status = providerStatusFromError(error);
    // An unconfirmed replacement must not outrank the retained session with an empty reading.
    provider = normalizeLimitProvider({
      ...base,
      accountKey: previous.length && ['unavailable', 'sourceRateLimited'].includes(status) ? '' : base.accountKey,
      status
    });
  }
  // Hark exposes one selected session; omitted identities otherwise remain cached by the runtime.
  const removals = deps.probe === true || !['ok', 'unauthorized'].includes(provider.status) ? []
    : previous.map((row) => ({ provider: 'hark', accountKey: row.accountKey, removed: true }));
  return removals.length ? [provider, ...removals] : provider;
}

module.exports = {
  HARK_COOKIE_NAME,
  HARK_ORIGIN,
  HARK_SUMMARY_URL,
  fetchHarkLimits,
  harkCookie,
  readHarkDesktopSession,
  normalizeHarkSessionToken,
  windowsFromSummary
};
