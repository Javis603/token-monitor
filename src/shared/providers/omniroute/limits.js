'use strict';

const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const {
  cleanSecret,
  fetchJson,
  nowIso,
  numberOrNull,
  providerStatusFromError
} = require('../../limits/providerHelpers');

const DEFAULT_BASE_URL = 'http://localhost:20128';

function omnirouteToken(env = process.env, options = {}) {
  const explicit = cleanSecret(
    typeof options === 'string' ? options : options.omnirouteToken || options.token || options.apiKey
  );
  if (explicit) return explicit;
  for (const name of ['TOKEN_MONITOR_OMNIROUTE_TOKEN', 'OMNIROUTE_TOKEN', 'OMNIROUTE_API_KEY']) {
    const value = cleanSecret(env[name]);
    if (value) return value;
  }
  return '';
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function normalizeBaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return DEFAULT_BASE_URL;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) return '';
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '').replace(/\/v1$/iu, '') || '';
    return parsed.toString().replace(/\/$/u, '');
  } catch (_) {
    return '';
  }
}

function parseBudgetWindows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const windows = [];
  const b = payload.budget && typeof payload.budget === 'object' ? payload.budget : payload;

  if (typeof b.limit === 'number' || typeof b.used === 'number' || typeof b.remaining === 'number') {
    const limit = numberOrNull(b.limit);
    const parsedRemaining = numberOrNull(b.remaining);
    const used = numberOrNull(b.used) ?? (limit !== null && parsedRemaining !== null ? limit - parsedRemaining : null);
    const remaining = parsedRemaining ?? (limit !== null && used !== null ? limit - used : null);
    const usedPercent = limit && limit > 0 && used !== null
      ? Math.max(0, Math.min(100, (used / limit) * 100))
      : null;
    const remainingPercent = usedPercent !== null ? Math.max(0, Math.min(100, 100 - usedPercent)) : null;
    const kind = b.window === '5h' || b.window === 'session' ? 'session'
      : b.window === 'day' || b.window === 'daily' ? 'daily'
      : b.window === 'week' || b.window === 'weekly' ? 'weekly'
      : 'billing';
    windows.push({
      kind,
      label: b.label || 'Budget',
      used,
      limit,
      remaining,
      usedPercent,
      remainingPercent,
      metric: 'spend',
      currency: b.currency || 'USD',
      resetsAt: b.resetAt || b.resetsAt || null,
      showMeter: true
    });
  }

  if (Array.isArray(b.dimensions)) {
    for (const dim of b.dimensions) {
      const limit = numberOrNull(dim.limit);
      const used = numberOrNull(dim.consumedTotal ?? dim.consumed ?? dim.used);
      const remaining = limit !== null && used !== null ? Math.max(0, limit - used) : null;
      const usedPercent = limit && limit > 0 && used !== null
        ? Math.max(0, Math.min(100, (used / limit) * 100))
        : null;
      const remainingPercent = usedPercent !== null ? Math.max(0, Math.min(100, 100 - usedPercent)) : null;
      const kind = dim.window === '5h' ? 'session'
        : dim.window === 'daily' || dim.window === 'day' ? 'daily'
        : dim.window === 'weekly' || dim.window === 'week' ? 'weekly'
        : 'billing';
      windows.push({
        kind,
        label: dim.label || `${dim.window || 'pool'} ${dim.unit || 'quota'}`,
        used,
        limit,
        remaining,
        usedPercent,
        remainingPercent,
        metric: dim.unit === 'usd' ? 'spend' : 'credits',
        currency: dim.unit === 'usd' ? 'USD' : null,
        showMeter: true
      });
    }
  }

  return windows;
}

async function fetchOmniRouteLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const token = omnirouteToken(env, options);
  if (!token) {
    return normalizeLimitProvider({
      provider: 'omniroute',
      source: 'api',
      status: 'notConfigured',
      updatedAt: nowIso(now),
      windows: []
    });
  }

  const baseUrl = normalizeBaseUrl(options.omnirouteBaseUrl || env.TOKEN_MONITOR_OMNIROUTE_BASE_URL || env.OMNIROUTE_BASE_URL);
  if (!baseUrl) {
    return normalizeLimitProvider({
      provider: 'omniroute',
      source: 'api',
      status: 'notConfigured',
      updatedAt: nowIso(now),
      windows: []
    });
  }

  const accountKey = hashKey('omniroute', [baseUrl, token].join('\0'));
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json'
  };

  try {
    const budgetUrl = `${baseUrl}/api/usage/budget`;
    const data = await fetchJson(budgetUrl, headers, deps, { forbiddenIsUnauthorized: true });
    const windows = parseBudgetWindows(data);
    return normalizeLimitProvider({
      provider: 'omniroute',
      accountKey,
      accountLabel: 'OmniRoute',
      source: 'api',
      status: 'ok',
      updatedAt: nowIso(now),
      windows
    });
  } catch (error) {
    if (error?.httpStatus === 404) {
      try {
        const poolsUrl = `${baseUrl}/api/quota/pools`;
        const pools = await fetchJson(poolsUrl, headers, deps, { forbiddenIsUnauthorized: true });
        const windows = [];
        if (Array.isArray(pools)) {
          for (const pool of pools) {
            const usage = pool.usage || pool;
            const limit = numberOrNull(usage.limit);
            const used = numberOrNull(usage.consumedTotal ?? usage.consumed ?? usage.used);
            const remaining = limit !== null && used !== null ? Math.max(0, limit - used) : null;
            const usedPercent = limit && limit > 0 && used !== null
              ? Math.max(0, Math.min(100, (used / limit) * 100))
              : null;
            const unit = String(usage.unit || pool.unit || '').trim().toLowerCase();
            const isUsd = unit === 'usd';
            windows.push({
              kind: 'billing',
              label: pool.name || 'Quota Pool',
              used,
              limit,
              remaining,
              usedPercent,
              metric: isUsd ? 'spend' : 'credits',
              currency: isUsd ? 'USD' : null,
              showMeter: true
            });
          }
        }
        return normalizeLimitProvider({
          provider: 'omniroute',
          accountKey,
          accountLabel: 'OmniRoute',
          source: 'api',
          status: 'ok',
          updatedAt: nowIso(now),
          windows
        });
      } catch (poolErr) {
        return normalizeLimitProvider({
          provider: 'omniroute',
          accountKey,
          source: 'api',
          status: providerStatusFromError(poolErr),
          updatedAt: nowIso(now),
          windows: []
        });
      }
    }

    return normalizeLimitProvider({
      provider: 'omniroute',
      accountKey,
      source: 'api',
      status: providerStatusFromError(error),
      updatedAt: nowIso(now),
      windows: []
    });
  }
}

module.exports = {
  fetchOmniRouteLimits,
  normalizeBaseUrl,
  omnirouteToken,
  parseBudgetWindows
};
