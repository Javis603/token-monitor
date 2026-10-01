'use strict';

const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const { errorWithStatus, numberOrNull, providerStatusFromError } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const ORIGIN = 'https://platform.stepfun.com';
const RATE_URL = `${ORIGIN}/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit`;
const PLAN_URL = `${ORIGIN}/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus`;
const DEFAULT_WEBID = 'c8a1002d2c457e758785a9979832217c7c0b884c';

function stepfunToken(env = process.env, options = {}) {
  const input = String(options.stepfunToken || env?.TOKEN_MONITOR_STEPFUN_TOKEN || env?.STEPFUN_TOKEN || '').trim();
  const cookieValue = /(?:^|;)\s*Oasis-Token=([^;]+)/iu.exec(input)?.[1];
  const raw = String(cookieValue || input).replace(/^Oasis-Token\s*:\s*/iu, '').trim();
  return raw && !/[\u0000-\u001f\u007f;]/u.test(raw) ? raw : '';
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
  const token = stepfunToken(deps.env || process.env, options);
  if (!token) return normalizeLimitProvider({ ...base, status: 'notConfigured', windows: [] });
  try {
    const webid = deviceId(token);
    const request = async (url, signal) => {
      const response = await (deps.fetch || fetch)(url, {
        method: 'POST', body: '{}', signal, redirect: 'error', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json',
          'User-Agent': BROWSER_USER_AGENT, 'oasis-appid': '10300', 'oasis-platform': 'web',
          'oasis-webid': webid, Cookie: `Oasis-Token=${token}; Oasis-Webid=${webid}` }
      });
      if (!response.ok) throw errorWithStatus(response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 429 ? 'sourceRateLimited' : 'unavailable', `StepFun returned ${response.status}`);
      try { return await response.json(); } catch { throw errorWithStatus('unavailable', 'Invalid StepFun response'); }
    };
    const windows = await runWithProbeDeadline(
      async ({ signal }) => parseStepfunUsage(await request(RATE_URL, signal)),
      { signal: deps.signal, deadlineMs: Number(deps.stepfunFetchTimeoutMs || 15000) }
    );
    let accountLabel = '';
    try {
      const plan = await runWithProbeDeadline(
        ({ signal }) => request(PLAN_URL, signal),
        { signal: deps.signal, deadlineMs: Number(deps.stepfunPlanFetchTimeoutMs || 1500) }
      );
      if ((plan.status === 1 || plan.status == null) && typeof plan.subscription?.name === 'string') accountLabel = plan.subscription.name;
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      // Plan name is optional; quota remains authoritative.
    }
    return normalizeLimitProvider({ ...base, status: 'ok', accountKey: hashKey('stepfun', token), accountLabel, windows });
  } catch (error) {
    return normalizeLimitProvider({ ...base, status: providerStatusFromError(error), windows: [] });
  }
}

module.exports = { fetchStepfunLimits, parseStepfunUsage, stepfunToken, deviceId };
