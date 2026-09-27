'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readRegularFileNoFollow } = require('../../credentialStore');
const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const {
  cleanSecret,
  errorWithStatus,
  numberOrNull,
  planLabelFromParts,
  toIso
} = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');

const FACTORY_API_BASE_URL = 'https://api.factory.ai';
const FACTORY_APP_BASE_URL = 'https://app.factory.ai';
const FACTORY_FETCH_TIMEOUT_MS = 12_000;
const FACTORY_ENV_FILE_MAX_BYTES = 256 * 1024;
const FACTORY_API_KEY_NAMES = ['FACTORY_API_KEY'];

function factoryProfileDir(options = {}, deps = {}) {
  return path.join(deps.homeDir || options.homeDir || os.homedir(), '.factory');
}

function readFactoryFile(filePath, description, deps = {}) {
  return readRegularFileNoFollow(filePath, {
    fs: deps.fs || fs,
    description,
    encoding: 'utf8',
    maxBytes: FACTORY_ENV_FILE_MAX_BYTES
  });
}

function resolveFactoryAutomaticApiKey(options = {}, deps = {}) {
  const env = deps.env || process.env;
  for (const name of FACTORY_API_KEY_NAMES) {
    const value = cleanSecret(env[name]);
    if (value) return { apiKey: value, source: 'env' };
  }
  try {
    const source = readFactoryFile(
      path.join(factoryProfileDir(options, deps), '.env'),
      'Factory environment file',
      deps
    );
    for (const line of source.split(/\r?\n/u)) {
      const match = line.match(/^\s*(?:export\s+)?FACTORY_API_KEY\s*=\s*(.*?)\s*$/u);
      if (!match) continue;
      const value = cleanSecret(match[1].replace(/\s+#.*$/u, ''));
      if (value) return { apiKey: value, source: 'droid-env' };
    }
  } catch (_) {}
  return { apiKey: '', source: '' };
}

function factoryEnvApiKey(options = {}, deps = {}) {
  const explicit = cleanSecret(options.factoryApiKey);
  if (explicit) return explicit;
  return resolveFactoryAutomaticApiKey(options, deps).apiKey;
}

function factoryWindow(window, { kind, label, windowMinutes, now, additional = false, limitId = '' }) {
  const usedPercent = numberOrNull(window?.usedPercent);
  if (usedPercent === null) return null;
  const secondsRemaining = numberOrNull(window?.secondsRemaining);
  const windowEnd = toIso(
    typeof window?.windowEnd === 'string' && /^\d+(?:\.\d+)?$/u.test(window.windowEnd.trim())
      ? Number(window.windowEnd)
      : window?.windowEnd
  );
  const resetFromRemaining = secondsRemaining !== null && secondsRemaining > 0
    ? toIso(now + secondsRemaining * 1000)
    : null;
  const resetsAt = resetFromRemaining || (windowEnd && Date.parse(windowEnd) > now ? windowEnd : null);
  const staleExpired = Boolean(windowEnd) && !resetFromRemaining && secondsRemaining === null && Date.parse(windowEnd) <= now;
  return {
    kind,
    label,
    usedPercent: staleExpired ? 0 : Math.max(0, Math.min(100, usedPercent)),
    ...(windowMinutes ? { windowMinutes } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(additional ? { additional: true } : {}),
    ...(limitId ? { limitId } : {})
  };
}

function parseFactoryTokenRateLimits(body, now = Date.now()) {
  if (body?.usesTokenRateLimitsBilling !== true || !body?.limits?.standard) return null;
  const windows = [];
  const appendPool = (pool, prefix, additional) => {
    if (!pool || typeof pool !== 'object') return;
    if (additional && !['fiveHour', 'weekly', 'monthly'].some((field) => {
      const entry = pool[field];
      return numberOrNull(entry?.usedPercent) > 0 || entry?.windowEnd != null || entry?.secondsRemaining != null;
    })) return;
    const definitions = [
      ['fiveHour', 'session', prefix ? `${prefix} 5-hour` : '5-hour', 300, '5h'],
      ['weekly', 'weekly', prefix ? `${prefix} Weekly` : 'Weekly', 10_080, 'weekly'],
      ['monthly', 'billing', prefix ? `${prefix} Monthly` : 'Monthly', null, 'monthly']
    ];
    for (const [field, kind, label, windowMinutes, suffix] of definitions) {
      const parsed = factoryWindow(pool[field], {
        kind,
        label,
        windowMinutes,
        now,
        additional,
        limitId: `factory-${prefix ? `${prefix.toLowerCase()}-` : ''}${suffix}`
      });
      if (parsed) windows.push(parsed);
    }
  };
  appendPool(body.limits.standard, '', false);
  appendPool(body.limits.core, 'Core', true);
  const balanceCents = numberOrNull(body.extraUsageBalanceCents);
  const balance = balanceCents === null ? null : {
    amount: Math.max(0, balanceCents / 100),
    currency: 'USD'
  };
  return { windows, balance };
}

function factoryLegacyPercent(bucket) {
  const used = numberOrNull(bucket?.userTokens);
  const allowance = numberOrNull(bucket?.totalAllowance);
  const ratio = numberOrNull(bucket?.usedRatio);
  const allowanceReliable = allowance !== null && allowance > 0 && allowance <= 1_000_000_000_000;
  if (ratio !== null && ratio >= -0.001 && ratio <= 1.001
    && !(ratio === 0 && used !== null && used > 0 && allowanceReliable)) {
    return Math.max(0, Math.min(100, ratio * 100));
  }
  if (allowanceReliable && used !== null) return Math.max(0, Math.min(100, (used / allowance) * 100));
  if (!allowanceReliable && ratio !== null && ratio >= -0.1 && ratio <= 100.1) {
    return Math.max(0, Math.min(100, ratio));
  }
  return null;
}

function parseFactoryLegacyUsage(body) {
  // This legacy response shape is retained for compatibility with the working
  // CodexBar integration; unlike the token-rate limits shape, it has not been
  // confirmed in Factory's current first-party client bundles.
  const usage = body?.usage;
  if (!usage || typeof usage !== 'object') return { windows: [], balance: null };
  const resetsAt = toIso(usage.endDate);
  const windows = [];
  for (const [field, label, limitId] of [
    ['standard', 'Standard', 'factory-standard'],
    ['premium', 'Premium', 'factory-premium']
  ]) {
    const bucket = usage[field];
    const usedPercent = factoryLegacyPercent(bucket);
    if (usedPercent === null) continue;
    const used = numberOrNull(bucket?.userTokens);
    const limit = numberOrNull(bucket?.totalAllowance);
    windows.push({
      kind: 'billing',
      label,
      limitId,
      usedPercent,
      ...(used !== null ? { used: Math.max(0, used) } : {}),
      ...(limit !== null && limit > 0 && limit <= 1_000_000_000_000 ? { limit } : {}),
      ...(resetsAt ? { resetsAt } : {})
    });
  }
  return { windows, balance: null };
}

function factoryIdentity(authBody, apiKey, fallbackUserId = '') {
  const userProfile = authBody?.userProfile || {};
  const userId = String(userProfile.id || userProfile.workosUser?.id || fallbackUserId || '').trim();
  const organization = authBody?.organization || {};
  const plan = organization.subscription?.orbSubscription?.plan?.name;
  const tier = organization.subscription?.factoryTier;
  return {
    accountKey: hashKey('factory', userId || apiKey),
    accountEmail: String(userProfile.email || userProfile.workosUser?.email || '').trim(),
    accountName: String(organization.name || organization.fullName || '').trim(),
    planLabel: planLabelFromParts(plan, tier),
    accountLabel: planLabelFromParts(plan, tier)
  };
}

function factoryUserId(authBody) {
  return String(
    authBody?.userProfile?.id
    || authBody?.userProfile?.workosUser?.id
    || ''
  ).trim();
}

async function factoryFetchJson(baseUrl, route, token, deps = {}) {
  const deadlineMs = Number(deps.factoryFetchTimeoutMs || deps.fetchTimeoutMs || FACTORY_FETCH_TIMEOUT_MS);
  return runWithProbeDeadline(async ({ signal }) => {
    const response = await (deps.fetch || fetch)(`${baseUrl}${route}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: FACTORY_APP_BASE_URL,
        Referer: `${FACTORY_APP_BASE_URL}/`,
        'x-factory-client': 'web-app'
      },
      signal
    });
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw errorWithStatus(status, `Factory returned ${response.status}`);
    }
    return response.json();
  }, { signal: deps.signal, deadlineMs });
}

async function fetchFactoryWithToken(token, source, deps = {}) {
  const now = (deps.now || Date.now)();
  let lastError;
  let authError;
  let rateLimitError;
  const rememberClassifiedError = (error) => {
    if (!rateLimitError && error?.status === 'sourceRateLimited') rateLimitError = error;
    if (!authError && error?.status === 'unauthorized') authError = error;
  };
  for (const baseUrl of [FACTORY_API_BASE_URL, FACTORY_APP_BASE_URL]) {
    try {
      const authBody = await factoryFetchJson(baseUrl, '/api/app/auth/me', token, deps);
      let limitsBody = null;
      try {
        limitsBody = await factoryFetchJson(FACTORY_API_BASE_URL, '/api/billing/limits', token, deps);
      } catch (error) {
        rememberClassifiedError(error);
      }
      let usage = parseFactoryTokenRateLimits(limitsBody, now);
      let usageUserId = '';
      if (!usage) {
        const userId = factoryUserId(authBody);
        // `userId` is accepted by the working legacy integration but is not a
        // documented Factory API parameter, so omit it when identity is absent.
        const legacyBody = await factoryFetchJson(
          baseUrl,
          `/api/organization/subscription/usage?useCache=true${userId ? `&userId=${encodeURIComponent(userId)}` : ''}`,
          token,
          deps
        );
        usage = parseFactoryLegacyUsage(legacyBody);
        usageUserId = String(legacyBody?.userId || '').trim();
      }
      if (!usage.windows.length && !usage.balance && rateLimitError) throw rateLimitError;
      const identity = factoryIdentity(authBody, token, usageUserId);
      return normalizeLimitProvider({
        provider: 'factory',
        ...identity,
        source,
        status: usage.windows.length || usage.balance ? 'ok' : 'unavailable',
        updatedAt: new Date(now).toISOString(),
        windows: usage.windows,
        balance: usage.balance
      });
    } catch (error) {
      rememberClassifiedError(error);
      lastError = error;
    }
  }
  throw rateLimitError || authError || lastError || errorWithStatus('unavailable', 'Factory limits unavailable');
}

async function fetchFactoryLimits(options = {}, deps = {}) {
  const key = factoryEnvApiKey(options, deps);
  if (key) return fetchFactoryWithToken(key, 'api', deps);
  return normalizeLimitProvider({
    provider: 'factory',
    source: '',
    status: 'notConfigured',
    updatedAt: new Date((deps.now || Date.now)()).toISOString(),
    windows: []
  });
}

module.exports = {
  FACTORY_API_BASE_URL,
  FACTORY_APP_BASE_URL,
  factoryEnvApiKey,
  factoryIdentity,
  factoryUserId,
  factoryLegacyPercent,
  factoryProfileDir,
  fetchFactoryLimits,
  fetchFactoryWithToken,
  parseFactoryLegacyUsage,
  parseFactoryTokenRateLimits,
  resolveFactoryAutomaticApiKey
};
