'use strict';

const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const { errorWithStatus, numberOrNull, providerStatusFromError } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');
const { loginStepFun, normalizeOasisToken } = require('./login');

const ORIGIN = 'https://platform.stepfun.com';
const RATE_URL = `${ORIGIN}/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit`;
const PLAN_URL = `${ORIGIN}/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus`;
const DEFAULT_WEBID = 'c8a1002d2c457e758785a9979832217c7c0b884c';

// A pasted or environment token still wins when present — it is the manual
// escape hatch. Otherwise the stored username + password drive loginStepFun(),
// which is what keeps the quota live: an Oasis-Token is a short-lived session
// JWT with no refresh, so a stored token alone expires and the provider goes
// unauthorized until the user re-pastes one. Cached tokens are only used when
// no password is stored, and a 401/403 from the quota probe invalidates the
// cache and retries once through the password flow.
function stepfunToken(env = process.env, options = {}) {
  const input = String(options.stepfunToken || env?.TOKEN_MONITOR_STEPFUN_TOKEN || env?.STEPFUN_TOKEN || '').trim();
  return normalizeOasisToken(input);
}

function stepfunCredentials(env = process.env, options = {}) {
  const username = String(
    options.stepfunUsername || env?.TOKEN_MONITOR_STEPFUN_USERNAME || env?.STEPFUN_USERNAME || ''
  ).trim();
  const password = String(
    options.stepfunPassword || env?.TOKEN_MONITOR_STEPFUN_PASSWORD || env?.STEPFUN_PASSWORD || ''
  );
  return username && password ? { username, password } : null;
}

function deviceId(token) {
  for (const jwt of token.split('...').reverse()) {
    const part = jwt.split('.')[1];
    if (!part || !/^[A-Za-z0-9_-]+$/u.test(part)) continue;
    try {
      const id = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).device_id;
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(id)) return id;
    } catch { /* A malformed JWT may still be accepted with the default web id. */ }
  }
  return DEFAULT_WEBID;
}

function fraction(value) {
  const n = numberOrNull(value);
  return n !== null && n >= 0 && n <= 1 ? n : null;
}

function usedPercent(left) {
  return Math.round((1 - left) * 100000) / 1000;
}

function resetAt(value) {
  const seconds = numberOrNull(value);
  if (seconds === null || !Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseStepfunUsage(body) {
  if (!body || body.status !== 1) throw errorWithStatus(body?.status === 0 && /auth|token|login|登录/i.test(`${body?.message || ''} ${body?.desc || ''}`) ? 'unauthorized' : 'unavailable', 'StepFun rate limit request failed');
  const credit = body.plan_credit_rate_limit;
  const sessionReset = resetAt(body.five_hour_usage_reset_time);
  const weeklyReset = resetAt(body.weekly_usage_reset_time);
  const isCredit = !sessionReset && !weeklyReset && (
    credit?.subscription_credit_left_rate != null || credit?.topup_credit_left_rate != null
    || (Array.isArray(credit?.credit_buckets) && credit.credit_buckets.length > 0)
    || numberOrNull(body.plan_family) === 2
  );
  if (isCredit) {
    let left = null;
    const buckets = credit?.credit_buckets;
    if (Array.isArray(buckets) && buckets.length) {
      let total = 0;
      let remaining = 0;
      let valid = true;
      for (const bucket of buckets) {
        const limit = numberOrNull(bucket?.credit_total);
        const residual = numberOrNull(bucket?.credit_residual);
        if (limit === null || residual === null || limit <= 0 || residual < 0 || residual > limit) { valid = false; break; }
        total += limit;
        remaining += residual;
      }
      if (!valid || !Number.isFinite(total) || !Number.isFinite(remaining)) {
        throw errorWithStatus('unavailable', 'StepFun credit buckets incomplete');
      }
      left = remaining / total;
    }
    if (left === null) left = fraction(credit?.subscription_credit_left_rate) ?? fraction(credit?.topup_credit_left_rate);
    if (left === null) throw errorWithStatus('unavailable', 'StepFun credit balance missing');
    const reset = resetAt(credit?.subscription_credit_reset_time);
    return [{ kind: 'billing', label: 'Credit', usedPercent: usedPercent(left),
      ...(reset ? { resetsAt: reset, windowMinutes: 30 * 24 * 60 } : {}) }];
  }
  const sessionLeft = fraction(body.five_hour_usage_left_rate);
  const weeklyLeft = fraction(body.weekly_usage_left_rate);
  if (sessionLeft === null || weeklyLeft === null || !sessionReset || !weeklyReset) {
    throw errorWithStatus('unavailable', 'StepFun rate windows missing');
  }
  return [
    { kind: 'session', label: '5-hour', usedPercent: usedPercent(sessionLeft), resetsAt: sessionReset, windowMinutes: 300 },
    { kind: 'weekly', label: 'Weekly', usedPercent: usedPercent(weeklyLeft), resetsAt: weeklyReset, windowMinutes: 10080 }
  ];
}

async function fetchStepfunLimits(options = {}, deps = {}) {
  const updatedAt = new Date((deps.now || Date.now)()).toISOString();
  const base = { provider: 'stepfun', source: 'web', updatedAt };
  const env = deps.env || process.env;
  const run = deps.fetch || fetch;
  const credentials = stepfunCredentials(env, options);
  // An explicit/env token is authoritative when present; otherwise a cached
  // token from a previous password login keeps the probe cheap, and the
  // credentials are what make it renewable.
  let token = stepfunToken(env, options) || (deps.cachedToken ? normalizeOasisToken(deps.cachedToken) : '');
  if (!token && !credentials) {
    return normalizeLimitProvider({ ...base, status: 'notConfigured', windows: [] });
  }

  try {
    const webid = deviceId(token);
    const request = async (url, signal, activeToken) => {
      const response = await run(url, {
        method: 'POST', body: '{}', signal, redirect: 'error', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json',
          'User-Agent': BROWSER_USER_AGENT, 'oasis-appid': '10300', 'oasis-platform': 'web',
          'oasis-webid': webid, Cookie: `Oasis-Token=${activeToken}; Oasis-Webid=${webid}` }
      });
      if (!response.ok) throw errorWithStatus(response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 429 ? 'sourceRateLimited' : 'unavailable', `StepFun returned ${response.status}`);
      try { return await response.json(); } catch { throw errorWithStatus('unavailable', 'Invalid StepFun response'); }
    };

    // Mint a token before probing when we have credentials and none cached:
    // an expired cached token would otherwise cost a wasted 401 round trip.
    if (!token && credentials) {
      token = await runWithProbeDeadline(
        ({ signal }) => loginStepFun(credentials, { fetch: run, signal, webid }),
        { signal: deps.signal, deadlineMs: Number(deps.stepfunLoginTimeoutMs || 20000) }
      );
      if (deps.onTokenRefreshed) {
        try { deps.onTokenRefreshed(token); } catch { /* persisting is best-effort */ }
      }
    }

    let body;
    try {
      body = await runWithProbeDeadline(
        async ({ signal }) => request(RATE_URL, signal, token),
        { signal: deps.signal, deadlineMs: Number(deps.stepfunFetchTimeoutMs || 15000) }
      );
    } catch (error) {
      // A 401/403 on a token we did not mint this call means the cached one
      // aged out. Re-login once and retry, so a stale cache self-heals instead
      // of waiting for the next manual paste.
      if (!credentials || providerStatusFromError(error) !== 'unauthorized') throw error;
      token = await runWithProbeDeadline(
        ({ signal }) => loginStepFun(credentials, { fetch: run, signal, webid }),
        { signal: deps.signal, deadlineMs: Number(deps.stepfunLoginTimeoutMs || 20000) }
      );
      if (deps.onTokenRefreshed) {
        try { deps.onTokenRefreshed(token); } catch { /* persisting is best-effort */ }
      }
      body = await runWithProbeDeadline(
        async ({ signal }) => request(RATE_URL, signal, token),
        { signal: deps.signal, deadlineMs: Number(deps.stepfunFetchTimeoutMs || 15000) }
      );
    }

    const windows = parseStepfunUsage(body);
    let accountLabel = '';
    try {
      const plan = await runWithProbeDeadline(
        ({ signal }) => request(PLAN_URL, signal, token),
        { signal: deps.signal, deadlineMs: Number(deps.stepfunPlanFetchTimeoutMs || 1500) }
      );
      if ((plan.status === 1 || plan.status == null) && typeof plan.subscription?.name === 'string') accountLabel = plan.subscription.name;
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      // Plan name is optional; quota remains authoritative.
    }
    // Keyed on the account, not the token: a rotated token is the same
    // account, and keying on it would fork one login into several rows.
    const accountKey = credentials
      ? hashKey('stepfun', `password:${credentials.username.toLowerCase()}`)
      : hashKey('stepfun', token);
    return normalizeLimitProvider({ ...base, status: 'ok', accountKey, accountLabel, windows });
  } catch (error) {
    return normalizeLimitProvider({ ...base, status: providerStatusFromError(error), windows: [] });
  }
}

module.exports = { fetchStepfunLimits, parseStepfunUsage, stepfunToken, stepfunCredentials, deviceId };
