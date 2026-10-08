'use strict';

const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const { errorWithStatus, numberOrNull, providerStatusFromError } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const ORIGIN = 'https://platform.stepfun.com';
const RATE_URL = `${ORIGIN}/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit`;
const PLAN_URL = `${ORIGIN}/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus`;

// Oasis-Token is a JWT; the dashboard accepts it as a bare cookie value or with
// the `Oasis-Token:` prefix a devtools copy usually carries. Normalizing here
// keeps a whole pasted cookie jar usable instead of only its token field.
function normalizeOasisToken(value) {
  const raw = String(value || '').trim();
  const fromCookie = /(?:^|;)\s*Oasis-Token=([^;]+)/iu.exec(raw)?.[1];
  const token = String(fromCookie || raw).replace(/^Oasis-Token\s*:\s*/iu, '').trim();
  return token && !/[\u0000-\u001f\u007f;]/u.test(token) ? token : '';
}

// A pasted or environment token still wins when present — it is the manual
// escape hatch. Otherwise the stored username + password drive the sign-in,
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

// `oasis-webid` must be the device id this session was registered under — the
// site issues it from RegisterDevice and rejects a foreign one, so there is no
// usable constant. Read it off the token payload when it is there; otherwise
// '' and the caller omits the header instead of guessing.
function deviceId(token) {
  for (const jwt of String(token || '').split('...').reverse()) {
    const part = jwt.split('.')[1];
    if (!part || !/^[A-Za-z0-9_-]+$/u.test(part)) continue;
    try {
      const id = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).device_id;
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(id)) return id;
    } catch { /* Not a JWT payload — try the next segment. */ }
  }
  return '';
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
  // token from a previous sign-in keeps the probe cheap, and the credentials
  // are what make it renewable.
  let token = stepfunToken(env, options) || (deps.cachedToken ? normalizeOasisToken(deps.cachedToken) : '');
  if (!token && !credentials) {
    return normalizeLimitProvider({ ...base, status: 'notConfigured', windows: [] });
  }

  // Signing in needs a browser: the site's password login hangs off
  // GlobalPassportService, which answers 403 with an empty body to every
  // non-browser caller (Ping, a known-good endpoint, fails the same way) while
  // the WAF token in the ingress jar only clears once page JavaScript runs.
  // main.js injects the Electron implementation through deps.signIn; the headless
  // agent has no BrowserWindow, so there the credentials simply cannot renew a
  // token and a manual paste stays the only lane.
  const signIn = typeof deps.signIn === 'function' ? deps.signIn : null;
  // The window gets the full budget; the wrapper deadline outlives it so a slow
  // WAF challenge is reported as the sign-in failing, not as a probe timeout
  // that says nothing about what happened.
  const loginTimeoutMs = Number(deps.stepfunLoginTimeoutMs || 110000);
  const login = async () => {
    if (!signIn) {
      const error = new Error('StepFun sign-in needs the desktop app; paste an Oasis-Token instead');
      error.status = 'unavailable';
      throw error;
    }
    const fresh = await runWithProbeDeadline(
      ({ signal }) => signIn({ ...credentials, signal, logger: deps.logger, timeoutMs: loginTimeoutMs }),
      { signal: deps.signal, deadlineMs: loginTimeoutMs + 15000 }
    );
    // The sign-in answers with a bare token, or with a session descriptor when
    // the implementation also read the device id the site issued next to it.
    // Accept both so `oasis-webid` can be a real value rather than a guess.
    const value = normalizeOasisToken(typeof fresh === 'string' ? fresh : fresh?.token);
    if (!value) {
      const error = new Error('StepFun sign-in returned no token');
      error.status = 'unavailable';
      throw error;
    }
    if (deps.onTokenRefreshed) {
      try { deps.onTokenRefreshed(value); } catch { /* persisting is best-effort */ }
    }
    return { token: value, webid: String(fresh?.webid || '').trim() };
  };

  try {
    // Mint a token before probing when we have credentials and none cached:
    // an expired cached token would otherwise cost a wasted 401 round trip.
    let webid = '';
    if (!token && credentials) {
      const session = await login();
      token = session.token;
      webid = session.webid;
    }
    if (!webid) webid = deviceId(token);

    const request = async (url, signal, activeToken) => {
      const response = await run(url, {
        method: 'POST', body: '{}', signal, redirect: 'error', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json',
          'User-Agent': BROWSER_USER_AGENT, 'oasis-appid': '10300', 'oasis-platform': 'web',
          ...(webid ? { 'oasis-webid': webid } : {}),
          Cookie: `Oasis-Token=${activeToken}${webid ? `; Oasis-Webid=${webid}` : ''}` }
      });
      if (!response.ok) throw errorWithStatus(response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 429 ? 'sourceRateLimited' : 'unavailable', `StepFun returned ${response.status}`);
      try { return await response.json(); } catch { throw errorWithStatus('unavailable', 'Invalid StepFun response'); }
    };

    let body;
    try {
      body = await runWithProbeDeadline(
        async ({ signal }) => request(RATE_URL, signal, token),
        { signal: deps.signal, deadlineMs: Number(deps.stepfunFetchTimeoutMs || 15000) }
      );
    } catch (error) {
      // A 401/403 on a token we did not mint this call means the cached one
      // aged out. Sign in once more and retry, so a stale cache self-heals
      // instead of waiting for the next manual paste.
      if (!credentials || providerStatusFromError(error) !== 'unauthorized') throw error;
      const session = await login();
      token = session.token;
      // Re-read the device id with it: reusing the aged-out session's value
      // would fail the retry for a second, unrelated reason and hide the real
      // one behind a misleading "wrong credentials" status.
      webid = session.webid || deviceId(token);
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

module.exports = { fetchStepfunLimits, parseStepfunUsage, stepfunToken, stepfunCredentials, deviceId, normalizeOasisToken };
