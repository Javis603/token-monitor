'use strict';

const crypto = require('node:crypto');
const { normalizeLimitProvider } = require('./limits');

const DEFAULT_ZED_SERVER_URL = 'https://zed.dev';
const DEFAULT_ZED_API_URL = 'https://cloud.zed.dev/client/users/me';

function cleanText(value) {
  return String(value || '').trim();
}

function cleanSecret(value) {
  const text = cleanText(value);
  return text && !/[\u0000-\u001f\u007f\s]/u.test(text) ? text : '';
}

function normalizeZedUserId(value) {
  const text = cleanText(value);
  return /^\d+$/u.test(text) ? text : '';
}

function normalizeZedAccessToken(value) {
  return cleanSecret(value);
}

function normalizeZedServerUrl(value, fallback = DEFAULT_ZED_SERVER_URL) {
  const raw = cleanText(value) || fallback;
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return ''; }
  if (
    parsed.protocol !== 'https:'
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname && parsed.pathname !== '/')
  ) return '';
  return parsed.origin;
}

function zedApiUrl(serverUrl) {
  const normalized = normalizeZedServerUrl(serverUrl, '');
  if (!normalized) return '';
  if (normalized === DEFAULT_ZED_SERVER_URL || normalized === 'https://staging.zed.dev') {
    return DEFAULT_ZED_API_URL;
  }
  return `${normalized}/client/users/me`;
}

function manualCredentials(options = {}, env = process.env) {
  const userId = normalizeZedUserId(options.zedUserId ?? env.TOKEN_MONITOR_ZED_USER_ID);
  const accessToken = normalizeZedAccessToken(options.zedAccessToken ?? env.TOKEN_MONITOR_ZED_ACCESS_TOKEN);
  return userId && accessToken ? { userId, accessToken } : null;
}

function normalizeManagedAccounts(value, options = {}) {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set();
  const seenUsers = new Set();
  return value.flatMap((entry) => {
    const id = cleanText(entry?.id);
    const userId = normalizeZedUserId(entry?.userId);
    if (!id || !userId || seenIds.has(id) || seenUsers.has(userId)) return [];
    seenIds.add(id);
    seenUsers.add(userId);
    const normalized = {
      id,
      userId,
      accountKey: cleanText(entry?.accountKey) || accountKey(userId),
      accountName: cleanText(entry?.accountName),
      planLabel: cleanText(entry?.planLabel),
      enabled: entry?.enabled !== false,
      addedAt: cleanText(entry?.addedAt),
      updatedAt: cleanText(entry?.updatedAt)
    };
    if (options.includeCredentials === true && entry?.credentials && typeof entry.credentials === 'object') {
      const accessToken = normalizeZedAccessToken(entry.credentials.accessToken);
      normalized.credentials = accessToken ? { userId, accessToken } : null;
    }
    return [normalized];
  });
}

function managedAccountsForCollector(value, readCredential) {
  if (typeof readCredential !== 'function') throw new TypeError('readCredential is required');
  return normalizeManagedAccounts(value).map((account) => ({
    ...account,
    credentials: readCredential(account.id)
  }));
}

function zedServerUrl(options = {}, env = process.env) {
  return normalizeZedServerUrl(options.zedServerUrl ?? env.TOKEN_MONITOR_ZED_SERVER_URL);
}

function planLabel(value) {
  const raw = cleanText(value);
  const known = {
    zed_free: 'Zed Free',
    zed_pro: 'Zed Pro',
    zed_pro_trial: 'Zed Pro Trial',
    zed_student: 'Zed Student',
    zed_business: 'Zed Business'
  };
  if (known[raw.toLowerCase()]) return known[raw.toLowerCase()];
  return raw.replace(/_/gu, ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase()).slice(0, 32);
}

function parseUsageLimit(value) {
  if (value === 'unlimited') return { unlimited: true, limit: null };
  const raw = value && typeof value === 'object' ? value.limited : value;
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit < 0) return null;
  return { unlimited: false, limit };
}

function subscriptionPeriodWindow(value, nowMs = Date.now()) {
  const startedAtMs = Date.parse(value?.started_at || '');
  const endedAtMs = Date.parse(value?.ended_at || '');
  const currentMs = Number(nowMs);
  if (
    !Number.isFinite(startedAtMs)
    || !Number.isFinite(endedAtMs)
    || endedAtMs <= startedAtMs
    || !Number.isFinite(currentMs)
  ) return null;
  const elapsed = Math.max(0, Math.min(1, (currentMs - startedAtMs) / (endedAtMs - startedAtMs)));
  return {
    kind: 'billing',
    limitId: 'zed.billing-cycle',
    label: 'Billing cycle',
    usedPercent: elapsed * 100,
    resetsAt: new Date(endedAtMs).toISOString(),
    showMeter: true
  };
}

function parseZedResponse(body, nowMs = Date.now()) {
  const user = body?.user;
  const userId = normalizeZedUserId(user?.id);
  const plan = body?.plan;
  const editPredictions = plan?.usage?.edit_predictions;
  const used = Number(editPredictions?.used);
  const parsedLimit = parseUsageLimit(editPredictions?.limit);
  if (!userId || !plan || !Number.isFinite(used) || used < 0 || !parsedLimit) {
    throw new Error('unexpected Zed account response shape');
  }
  const clampedUsed = parsedLimit.unlimited ? used : Math.min(used, parsedLimit.limit);
  const predictionDetail = parsedLimit.unlimited
    ? 'Unlimited'
    : `${clampedUsed} / ${parsedLimit.limit} predictions`;
  const predictionWindow = parsedLimit.unlimited
    ? {
        kind: 'billing',
        limitId: 'zed.edit-predictions',
        label: 'Edit Predictions',
        used,
        limit: null,
        remaining: null,
        usedPercent: 0,
        resetDescription: predictionDetail,
        detail: predictionDetail,
        showMeter: true
      }
    : {
        kind: 'billing',
        limitId: 'zed.edit-predictions',
        label: 'Edit Predictions',
        used: clampedUsed,
        limit: parsedLimit.limit,
        remaining: Math.max(0, parsedLimit.limit - clampedUsed),
        usedPercent: parsedLimit.limit > 0 ? (clampedUsed / parsedLimit.limit) * 100 : 100,
        resetDescription: predictionDetail,
        detail: predictionDetail,
        showMeter: parsedLimit.limit > 0
      };
  const windows = [predictionWindow];
  const billingCycle = subscriptionPeriodWindow(plan.subscription_period, nowMs);
  if (billingCycle) windows.push(billingCycle);
  if (plan.has_overdue_invoices === true) {
    windows.push({
      kind: 'billing',
      limitId: 'zed.overdue-invoices',
      label: 'Billing',
      resetDescription: 'Overdue invoices',
      detail: 'Overdue invoices',
      showMeter: false
    });
  }
  return {
    userId,
    githubLogin: cleanText(user.github_login),
    name: cleanText(user.name),
    planLabel: planLabel(plan.plan_v3),
    overdue: plan.has_overdue_invoices === true,
    windows
  };
}

function accountKey(userId) {
  return `sha256:${crypto.createHash('sha256').update(`zed:${userId}`).digest('hex')}`;
}

function providerStatus(status, now, sourceDetail, account = {}) {
  return normalizeLimitProvider({
    provider: 'zed',
    accountKey: account.accountKey || '',
    accountName: account.accountName || '',
    planLabel: account.planLabel || '',
    source: 'api',
    sourceDetail,
    status,
    updatedAt: new Date(now).toISOString(),
    windows: []
  });
}

async function fetchZedAccount(account, serverUrl, deps, now) {
  const credentials = account?.credentials;
  const sourceDetail = account?.sourceDetail || 'managed';
  if (!credentials?.userId || !credentials?.accessToken) {
    return providerStatus('notConfigured', now, sourceDetail, account);
  }
  const apiUrl = zedApiUrl(serverUrl);
  if (!apiUrl) return providerStatus('error', now, sourceDetail, account);
  try {
    const response = await (deps.fetch || fetch)(apiUrl, {
      method: 'GET',
      headers: {
        Authorization: `${credentials.userId} ${credentials.accessToken}`,
        Accept: 'application/json'
      },
      credentials: 'omit',
      ...(deps.signal ? { signal: deps.signal } : {})
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return providerStatus('unauthorized', now, sourceDetail, account);
      if (response.status === 429) return providerStatus('sourceRateLimited', now, sourceDetail, account);
      return providerStatus('unavailable', now, sourceDetail, account);
    }
    const parsed = parseZedResponse(await response.json(), now);
    const resolvedUserId = parsed.userId || credentials.userId;
    if (resolvedUserId !== credentials.userId) return providerStatus('error', now, sourceDetail, account);
    return normalizeLimitProvider({
      provider: 'zed',
      accountKey: accountKey(resolvedUserId),
      accountName: parsed.githubLogin || parsed.name || account.accountName,
      planLabel: parsed.planLabel || account.planLabel,
      source: 'api',
      sourceDetail,
      status: 'ok',
      updatedAt: new Date(now).toISOString(),
      windows: parsed.windows
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return providerStatus('unavailable', now, sourceDetail, account);
  }
}

async function fetchZedLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const serverUrl = zedServerUrl(options, env);
  if (!serverUrl) return providerStatus('error', now, 'managed');
  const scope = options.limitRefreshScope?.provider === 'zed' ? options.limitRefreshScope : null;
  const accounts = normalizeManagedAccounts(
    options.zedManagedAccounts || deps.zedManagedAccounts,
    { includeCredentials: true }
  )
    .filter((account) => account.enabled !== false)
    .filter((account) => !scope || !scope.accountKey || scope.accountKey === account.accountKey)
    .map((account) => ({ ...account, sourceDetail: 'managed' }));
  const envCredentials = manualCredentials(options, env);
  if (envCredentials && !accounts.some((account) => account.userId === envCredentials.userId)) {
    const envAccount = {
      id: 'env',
      userId: envCredentials.userId,
      accountKey: accountKey(envCredentials.userId),
      accountName: '',
      planLabel: '',
      // Environment credentials are the unattended/headless equivalent of a
      // managed account. The normalized wire contract intentionally has no
      // provider-specific "env" source detail.
      sourceDetail: 'managed',
      credentials: envCredentials
    };
    if (!scope || !scope.accountKey || scope.accountKey === envAccount.accountKey) accounts.push(envAccount);
  }
  if (accounts.length === 0) {
    return scope ? [] : providerStatus('notConfigured', now, 'managed');
  }
  return Promise.all(accounts.map((account) => fetchZedAccount(account, serverUrl, deps, now)));
}

module.exports = {
  DEFAULT_ZED_API_URL,
  DEFAULT_ZED_SERVER_URL,
  accountKey,
  fetchZedLimits,
  managedAccountsForCollector,
  manualCredentials,
  normalizeManagedAccounts,
  normalizeZedAccessToken,
  normalizeZedServerUrl,
  normalizeZedUserId,
  parseZedResponse,
  zedApiUrl,
  zedServerUrl
};
