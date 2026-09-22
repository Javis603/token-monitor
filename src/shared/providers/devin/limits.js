'use strict';

const { normalizeLimitProvider } = require('../../limits/core');
const {
  cleanSecret,
  errorWithStatus,
  nowIso,
  providerStatusFromError,
  statusForHttp,
  toIso
} = require('../../limits/providerHelpers');
const { hashKey } = require('../../hashKey');
const { runWithProbeDeadline } = require('../../probeDeadline');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const DEVIN_ORIGIN = 'https://app.devin.ai';
const DEVIN_FETCH_TIMEOUT_MS = 15_000;

function devinBearerToken(env = process.env, options = {}) {
  const candidates = [
    options.devinBearerToken,
    env.TOKEN_MONITOR_DEVIN_BEARER_TOKEN,
    env.DEVIN_BEARER_TOKEN,
    env.DEVIN_AUTHORIZATION
  ];
  for (const candidate of candidates) {
    let token = cleanSecret(candidate);
    if (!token) continue;
    token = token.replace(/^authorization\s*:\s*/iu, '').replace(/^bearer\s+/iu, '').trim();
    if (token) return token;
  }
  return '';
}

function internalOrganizationId(value) {
  const raw = String(value || '').trim().replace(/^organizations\//iu, '');
  return /^org[-_][A-Za-z0-9]+$/u.test(raw) ? raw : '';
}

function normalizeDevinOrganization(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.hostname === 'devin.ai' || url.hostname.endsWith('.devin.ai')) {
      const parts = url.pathname.split('/').filter(Boolean);
      raw = parts.length >= 2 && ['org', 'organizations'].includes(parts[0])
        ? `${parts[0]}/${parts[1]}`
        : url.pathname;
    }
  } catch (_) {}
  raw = raw.replace(/^\/+|\/+$/gu, '');
  if (raw.startsWith('org/') || raw.startsWith('organizations/')) return raw;
  return internalOrganizationId(raw) ? `organizations/${raw}` : `org/${raw}`;
}

function devinOrganization(env = process.env, options = {}) {
  return normalizeDevinOrganization(
    options.devinOrganization
    || env.TOKEN_MONITOR_DEVIN_ORGANIZATION
    || env.DEVIN_ORGANIZATION
    || env.DEVIN_ORG
  );
}

function devinQuotaUrls(organization) {
  const normalized = normalizeDevinOrganization(organization);
  if (!normalized) return [];
  const internalId = internalOrganizationId(normalized);
  const paths = [];
  if (internalId) paths.push(internalId);
  paths.push(normalized);
  if (normalized.startsWith('org/')) paths.push(normalized.slice(4));
  if (!normalized.startsWith('org/') && !normalized.startsWith('organizations/')) paths.push(`org/${normalized}`);
  if (internalId) paths.push(`organizations/${internalId}`);
  return [...new Set(paths)].map((path) => `${DEVIN_ORIGIN}/api/${path}/billing/quota/usage`);
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(value) {
  const parsed = finiteNumber(value);
  if (parsed === null) return null;
  return Math.max(0, Math.min(100, parsed <= 1 ? parsed * 100 : parsed));
}

function currentPercent(value) {
  const parsed = finiteNumber(value);
  if (parsed === null) return null;
  return Math.max(0, Math.min(100, parsed < 1 ? parsed * 100 : parsed));
}

function quotaPercent(value) {
  const direct = percent(value);
  if (direct !== null) return direct;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['used_percent', 'usedPercent', 'usage_percent', 'usagePercent', 'percent_used', 'percentUsed', 'percent']) {
    const result = percent(value[key]);
    if (result !== null) return result;
  }
  for (const key of ['remaining_percent', 'remainingPercent', 'percent_remaining', 'percentRemaining']) {
    const remaining = percent(value[key]);
    if (remaining !== null) return Math.max(0, 100 - remaining);
  }
  const used = finiteNumber(value.used ?? value.usage ?? value.used_count ?? value.usedCount ?? value.consumed);
  const limit = finiteNumber(value.limit ?? value.quota ?? value.total ?? value.max ?? value.available);
  if (used !== null && limit !== null && limit > 0) return Math.max(0, Math.min(100, used / limit * 100));
  const remaining = finiteNumber(value.remaining ?? value.left ?? value.available);
  if (remaining !== null && limit !== null && limit > 0) {
    return Math.max(0, Math.min(100, (limit - remaining) / limit * 100));
  }
  return null;
}

function resetAt(value) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, candidate] of Object.entries(value)) {
    if (!key.toLowerCase().includes('reset')) continue;
    const normalized = toIso(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function findQuotaWindow(value, keyMatches) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findQuotaWindow(item, keyMatches);
      if (found) return found;
    }
    return null;
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (!keyMatches(key)) continue;
    const usedPercent = quotaPercent(candidate);
    if (usedPercent !== null) return { usedPercent, resetsAt: resetAt(candidate) };
  }
  for (const candidate of Object.values(value)) {
    const found = findQuotaWindow(candidate, keyMatches);
    if (found) return found;
  }
  return null;
}

function cleanPlanName(value) {
  if (typeof value !== 'string') return '';
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function findPlanName(value) {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPlanName(item);
      if (found) return found;
    }
    return '';
  }
  for (const key of ['plan_name', 'planName', 'plan', 'tier', 'subscription_tier', 'subscriptionTier']) {
    const result = cleanPlanName(value[key]);
    if (result) return result;
  }
  for (const candidate of Object.values(value)) {
    const found = findPlanName(candidate);
    if (found) return found;
  }
  return '';
}

function displayOrganization(value) {
  return normalizeDevinOrganization(value).replace(/^organizations\//u, '').replace(/^org\//u, '');
}

function parseDevinUsage(body, organization = '') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('unexpected Devin usage response');
  const currentWindow = (kind) => {
    const usedPercent = currentPercent(body[`${kind}_percentage`]);
    return usedPercent === null ? null : { usedPercent, resetsAt: toIso(body[`${kind}_reset_at`]) };
  };
  const daily = body.hide_daily_quota === true
    ? null
    : currentWindow('daily') || findQuotaWindow(body, (key) => !key.toLowerCase().includes('hide') && /daily|day/iu.test(key));
  const weekly = currentWindow('weekly')
    || findQuotaWindow(body, (key) => !key.toLowerCase().includes('hide') && /weekly|week/iu.test(key));
  if (!daily && !weekly) throw new Error('missing Devin quota windows');
  const balanceValue = finiteNumber(body.overage_balance);
  const balanceCents = finiteNumber(body.overage_balance_cents);
  const overageBalance = balanceValue !== null && balanceValue >= 0
    ? balanceValue
    : balanceCents !== null && balanceCents >= 0 ? balanceCents / 100 : null;
  return {
    daily,
    weekly,
    planName: findPlanName(body),
    organization: displayOrganization(organization),
    overageBalance
  };
}

function quotaWindow(kind, label, value, windowMinutes) {
  if (!value) return null;
  return {
    kind,
    label,
    usedPercent: value.usedPercent,
    resetsAt: value.resetsAt,
    windowMinutes,
    showMeter: true
  };
}

async function fetchJson(url, headers, deps = {}) {
  const deadlineMs = Number(deps.devinFetchTimeoutMs || deps.fetchTimeoutMs || DEVIN_FETCH_TIMEOUT_MS);
  return runWithProbeDeadline(async ({ signal }) => {
    const response = await (deps.fetch || fetch)(url, { headers, credentials: 'omit', signal });
    let body = null;
    try { body = await response.json(); } catch (_) {}
    return { response, body };
  }, { signal: deps.signal, deadlineMs });
}

async function fetchDevinLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = nowIso(now);
  const token = devinBearerToken(env, options);
  const organization = devinOrganization(env, options);
  if (!token || !organization) {
    return normalizeLimitProvider({ provider: 'devin', source: 'web', status: 'notConfigured', updatedAt, windows: [] });
  }
  const internalId = internalOrganizationId(organization);
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    Authorization: `Bearer ${token}`,
    'User-Agent': BROWSER_USER_AGENT,
    ...(internalId ? { 'x-cog-org-id': internalId } : {})
  };
  try {
    let lastError = null;
    for (const url of devinQuotaUrls(organization)) {
      const { response, body } = await fetchJson(url, headers, deps);
      if (response.ok) {
        const usage = parseDevinUsage(body, organization);
        const windows = [
          quotaWindow('daily', 'Daily', usage.daily, 24 * 60),
          quotaWindow('weekly', 'Weekly', usage.weekly, 7 * 24 * 60)
        ].filter(Boolean);
        if (usage.overageBalance !== null) {
          windows.push({
            kind: 'billing',
            metric: 'credits',
            label: 'Extra usage balance',
            remaining: usage.overageBalance,
            currency: 'USD',
            showMeter: false
          });
        }
        return normalizeLimitProvider({
          provider: 'devin',
          accountKey: hashKey('devin', token, organization),
          accountLabel: usage.planName,
          accountName: usage.organization,
          source: 'web',
          status: 'ok',
          updatedAt,
          windows,
          ...(usage.overageBalance === null ? {} : {
            balance: { amount: usage.overageBalance, currency: 'USD' }
          })
        });
      }
      if (response.status === 401 || response.status === 403) {
        const missingOrganization = body?.detail === 'No organizations found for auth1 user';
        throw errorWithStatus(missingOrganization ? 'notConfigured' : 'unauthorized', `Devin returned ${response.status}`);
      }
      lastError = errorWithStatus(statusForHttp(response.status), `Devin returned ${response.status}`);
    }
    throw lastError || errorWithStatus('unavailable', 'no Devin quota endpoint succeeded');
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'devin',
      source: 'web',
      status: providerStatusFromError(error),
      updatedAt,
      windows: []
    });
  }
}

module.exports = {
  DEVIN_FETCH_TIMEOUT_MS,
  DEVIN_ORIGIN,
  devinBearerToken,
  devinOrganization,
  devinQuotaUrls,
  fetchDevinLimits,
  normalizeDevinOrganization,
  parseDevinUsage
};
