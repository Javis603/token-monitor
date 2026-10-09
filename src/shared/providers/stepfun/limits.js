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

// A pasted or environment token wins when present — it is the manual escape
// hatch. Otherwise the stored username + password drive the sign-in, which is
// what keeps the quota live: an Oasis-Token is a short-lived session JWT with no
// refresh, so a stored token alone expires and the provider goes unauthorized
// until the user re-pastes one.
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

// The device id pasted next to a manual token. Separate from the secret itself
// because it is an identifier rather than a credential, and because the manual
// lane otherwise has no way to satisfy a check that the token alone cannot.
function stepfunWebid(env = process.env, options = {}) {
  return String(
    options.stepfunWebid || env?.TOKEN_MONITOR_STEPFUN_WEBID || env?.STEPFUN_WEBID || ''
  ).trim();
}

// `oasis-webid` must be the device id this session was registered under — the
// site issues it from RegisterDevice and rejects a foreign one, so there is no
// usable constant.
//
// Three sources, in descending order of trust:
//   1. the cookie issued alongside a browser sign-in (readOasisSession returns
//      it, so the pair cannot drift apart);
//   2. the webid the user pasted next to a manual token;
//   3. the JWT payload, decoded as a last resort below.
//
// Source 3 is a heuristic, not a verified contract: `device_id` was read off a
// payload shape that no live capture has confirmed, and a wrong value fails the
// same way as a missing one (401 "oasis-token is embezzled"). It is used only
// after the two real sources come up empty, and whatever it decides is written
// to the diagnostic log so a failure can be told apart from a wrong token
// instead of being guessed at.
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

// Every Oasis call is the same envelope: fixed app headers, plus the token and
// the device id it was registered under. Factored out because the sign-in
// layer has to be able to ask "is this cookie pair signed in?" without a second
// hand-built copy of it — two copies of a header block is how the probe ends up
// authenticating with a webid the check never uses.
function oasisHeaders(token, webid) {
  const id = String(webid || '').trim();
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': BROWSER_USER_AGENT,
    'oasis-appid': '10300',
    'oasis-platform': 'web',
    ...(id ? { 'oasis-webid': id } : {}),
    Cookie: `Oasis-Token=${token}${id ? `; Oasis-Webid=${id}` : ''}`
  };
}

/**
 * Ask whether a cookie pair belongs to a signed-in session.
 *
 * The sign-in partition holds both kinds of token: platform.stepfun.com hands
 * out an ANONYMOUS Oasis-Token the moment its page loads, and the signed-in one
 * only replaces it after a successful login. The jar does not record which is
 * which, and the two fail differently downstream — the anonymous one answers
 * 401 "not a logined oasis account" — so "a cookie exists" is not evidence of a
 * session. Without this check, a stale anonymous cookie is handed straight back
 * as a credential, the quota probe 401s, the re-login path asks for a session
 * again, reads the very same anonymous cookie, and the provider is stuck
 * unauthorized with no window ever shown.
 *
 * The site's own answer is the verdict. Timing and string comparison cannot do
 * better: both states look like a well-formed cookie.
 *
 * @returns {Promise<boolean>} true only on a 200. A transport failure answers
 *   false as well — "could not check" must send the caller to the window rather
 *   than trust a cookie it never validated.
 */
async function verifyStepfunSession({ token, webid } = {}, deps = {}) {
  const normalized = normalizeOasisToken(token);
  const log = (line) => { if (typeof deps.logger === 'function') deps.logger(line); };
  if (!normalized) return false;
  const run = deps.fetch || fetch;
  try {
    const response = await run(PLAN_URL, {
      method: 'POST', body: '{}', redirect: 'error', credentials: 'omit',
      headers: oasisHeaders(normalized, webid),
      ...(deps.signal ? { signal: deps.signal } : {})
    });
    log(`stepfun session check -> ${response.status} (token ${normalized.length} chars)`);
    return response.status === 200;
  } catch (error) {
    log(`stepfun session check failed: ${error.message || error}`);
    return false;
  }
}

async function fetchStepfunLimits(options = {}, deps = {}) {
  const updatedAt = new Date((deps.now || Date.now)()).toISOString();
  const base = { provider: 'stepfun', source: 'web', updatedAt };
  const env = deps.env || process.env;
  const run = deps.fetch || fetch;
  const credentials = stepfunCredentials(env, options);
  const log = (line) => { if (typeof deps.logger === 'function') deps.logger(line); };
  // An explicit/env token is authoritative when present; otherwise the stored
  // credentials mint one here, which is what makes the lane renewable.
  let token = stepfunToken(env, options);
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
    return { token: value, webid: String(fresh?.webid || '').trim() };
  };

  // Which device id to pair with the token. A session that came out of the
  // browser login already carries the real one; a pasted token has whatever the
  // user stated next to it; only if both are absent does the JWT get decoded,
  // and that last resort announces itself to the log so an unexplained 401 is
  // traceable to the guess rather than to a rejected credential.
  const resolveWebid = (sessionWebid, activeToken) => {
    const fromSession = String(sessionWebid || '').trim();
    if (fromSession) return fromSession;
    const declared = stepfunWebid(env, options);
    if (declared) {
      log(`stepfun webid taken from the configured value (${declared.length} chars)`);
      return declared;
    }
    const decoded = deviceId(activeToken);
    if (decoded) {
      log(`stepfun webid decoded from the token payload as a last resort (${decoded.length} chars, unverified)`);
    }
    return decoded;
  };

  try {
    // Mint a token before probing when we have credentials and none pasted:
    // an absent token would otherwise cost a wasted 401 round trip.
    let webid = '';
    if (!token && credentials) {
      const session = await login();
      token = session.token;
      webid = session.webid;
    }
    webid = resolveWebid(webid, token);

    const request = async (url, signal, activeToken) => {
      const startedAt = (deps.now || Date.now)();
      let response;
      try {
        response = await run(url, {
          method: 'POST', body: '{}', signal, redirect: 'error', credentials: 'omit',
          headers: oasisHeaders(activeToken, webid)
        });
      } catch (error) {
        log(`stepfun request to ${url.slice(-28)} threw after ${(deps.now || Date.now)() - startedAt}ms: ${error.message}`);
        throw error;
      }
      const elapsedMs = (deps.now || Date.now)() - startedAt;
      log(`stepfun ${url.slice(-28)} -> ${response.status} in ${elapsedMs}ms (token ${activeToken.length} chars, webid ${webid || 'none'})`);
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
      // A 401/403 on a token we did not mint this call means the pasted or
      // environment one has aged out. Sign in once more and retry, so a stale
      // credential self-heals instead of waiting for the next manual paste.
      if (!credentials || providerStatusFromError(error) !== 'unauthorized') throw error;
      const session = await login();
      token = session.token;
      // Re-read the device id with it: reusing the aged-out session's value
      // would fail the retry for a second, unrelated reason and hide the real
      // one behind a misleading "wrong credentials" status.
      webid = resolveWebid(session.webid, token);
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
    log(`stepfun probe finished as ${providerStatusFromError(error)}: ${error.message || error}`);
    return normalizeLimitProvider({ ...base, status: providerStatusFromError(error), windows: [] });
  }
}

module.exports = { fetchStepfunLimits, parseStepfunUsage, stepfunToken, stepfunCredentials, stepfunWebid, deviceId, normalizeOasisToken, oasisHeaders, verifyStepfunSession };
