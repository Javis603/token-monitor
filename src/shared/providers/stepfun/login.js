'use strict';

// StepFun (阶跃星辰) Oasis-Token acquisition.
//
// The dashboard quota endpoints authenticate with a short-lived session JWT
// carried in the `Oasis-Token` cookie, which is why a hand-pasted token goes
// stale: there is no refresh path, so the user has to re-copy it from a
// browser every time the session expires. This module replaces that with the
// same three-step password flow the site itself performs, so a stored
// username + password can mint a fresh token on demand and the quota probe
// stops depending on the user.
//
// Flow (all against platform.stepfun.com):
//   1. GET  /                              → Set-Cookie: INGRESSCOOKIE=…
//   2. POST /passport/proto.api.passport.v1.PassportService/RegisterDevice
//      with INGRESSCOOKIE                 → anonymous access/refresh pair
//   3. POST …/SignInByPassword
//      { username, password } + anon      → authenticated Oasis-Token
//
// Every step is injectable so tests can drive the flow without a network.

const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const ORIGIN = 'https://platform.stepfun.com';
const PASSPORT = `${ORIGIN}/passport/proto.api.passport.v1.PassportService`;
const REGISTER_DEVICE_URL = `${PASSPORT}/RegisterDevice`;
const SIGN_IN_URL = `${PASSPORT}/SignInByPassword`;
const LOGIN_ORIGIN_URL = `${ORIGIN}/`;

// Oasis-Token is a JWT; the dashboard accepts it as a bare cookie value or
// with the `Oasis-Token:` prefix a devtools copy usually carries.
function normalizeOasisToken(value) {
  const raw = String(value || '').trim();
  const fromCookie = /(?:^|;)\s*Oasis-Token=([^;]+)/iu.exec(raw)?.[1];
  const token = String(fromCookie || raw).replace(/^Oasis-Token\s*:\s*/iu, '').trim();
  return token && !/[\u0000-\u001f\u007f;]/u.test(token) ? token : '';
}

// `Set-Cookie` folding: Node's fetch surfaces repeated headers through
// getSetCookie(), but a plain headers.get() only ever returns the first one,
// and INGRESSCOOKIE is not guaranteed to be first.
function readSetCookies(headers) {
  const list = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie() : null;
  if (Array.isArray(list) && list.length) return list;
  const single = headers?.get?.('set-cookie');
  return single ? [single] : [];
}

function cookieValue(setCookies, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  for (const header of setCookies) {
    const match = new RegExp(`(?:^|;)\\s*${escaped}=([^;]*)`, 'iu').exec(header);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return '';
}

// Oasis-Token can come back as a cookie, as a JSON field, or nested under a
// data envelope depending on which of the three steps answered.
function tokenFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const direct = payload.token || payload.access_token || payload.accessToken || payload.oasis_token;
  if (typeof direct === 'string' && direct.trim()) return normalizeOasisToken(direct);
  const nested = payload.data && typeof payload.data === 'object' ? payload.data : null;
  if (nested) return tokenFromPayload(nested);
  return '';
}

// The passport service reports failures with a numeric `code` and a human
// `msg`/`desc`; code 0 (or an absent code) is success. A non-zero code with
// auth wording means the credentials are wrong, which the caller surfaces
// differently from a transport failure so the UI can say "wrong password"
// instead of "could not reach StepFun".
function payloadError(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  const code = Number(payload.code ?? payload.status);
  if (!Number.isFinite(code) || code === 0) return null;
  const detail = `${payload.msg || payload.message || payload.desc || ''}`;
  const unauthorized = /password|密码|账号|account|login|登录|credential|unauthor|token/iu.test(detail);
  const error = new Error(fallback);
  error.status = unauthorized ? 'unauthorized' : 'unavailable';
  error.detail = detail || fallback;
  return error;
}

async function readJson(response, fallback) {
  if (!response.ok) {
    const error = new Error(fallback);
    error.status = response.status === 401 || response.status === 403
      ? 'unauthorized'
      : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
    throw error;
  }
  try {
    return await response.json();
  } catch {
    const error = new Error(fallback);
    error.status = 'unavailable';
    throw error;
  }
}

// Shared header set for steps 2 and 3. The Oasis-* trio is what the dashboard
// itself sends; the dashboard quota probe sends the same values, so reusing
// them keeps the login and quota requests indistinguishable to the server.
function oasisHeaders({ ingressCookie = '', anonymousToken = '', webid = '' }) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': BROWSER_USER_AGENT,
    'oasis-appid': '10300',
    'oasis-platform': 'web',
    ...(webid ? { 'oasis-webid': webid } : {}),
    ...(ingressCookie ? { Cookie: `INGRESSCOOKIE=${ingressCookie}` } : {}),
    ...(anonymousToken ? { 'Oasis-Token': anonymousToken } : {})
  };
}

/**
 * Run the three-step password login and return a fresh Oasis-Token.
 *
 * @param {{username: string, password: string}} credentials
 * @param {{fetch?: typeof fetch, signal?: AbortSignal, webid?: string,
 *          ingressCookie?: string, onStep?: (name: string) => void}} [deps]
 * @returns {Promise<string>} The authenticated Oasis-Token (never the anonymous one).
 * @throws {Error & {status?: 'unauthorized'|'unavailable'}} Wrong credentials or a
 *   transport/protocol failure. `status` lets the caller separate the two.
 */
async function loginStepFun(credentials = {}, deps = {}) {
  const username = String(credentials.username || '').trim();
  const password = String(credentials.password || '');
  if (!username || !password) {
    const error = new Error('StepFun username and password are required');
    error.status = 'unauthorized';
    throw error;
  }

  const run = deps.fetch || fetch;
  const webid = String(deps.webid || '').trim();
  const step = typeof deps.onStep === 'function' ? deps.onStep : () => {};

  // Step 1 — the landing page hands out the ingress cookie. A pre-supplied one
  // (a caller replaying a session) skips the request entirely.
  let ingressCookie = String(deps.ingressCookie || '').trim();
  if (!ingressCookie) {
    step('ingress');
    const landing = await run(LOGIN_ORIGIN_URL, {
      method: 'GET', signal: deps.signal, redirect: 'manual', credentials: 'omit',
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html,*/*' }
    });
    // A 3xx is expected here (the site redirects to /login); the Set-Cookie
    // still arrives, and any status means the hop succeeded, so only a
    // transport-level throw aborts the flow.
    ingressCookie = cookieValue(readSetCookies(landing.headers), 'INGRESSCOOKIE');
  }
  if (!ingressCookie) {
    const error = new Error('StepFun did not return an INGRESSCOOKIE');
    error.status = 'unavailable';
    throw error;
  }

  // Step 2 — register this device. The reply is an anonymous token that step
  // 3 authenticates with; it is never the credential we hand back.
  step('register');
  const registered = await readJson(
    await run(REGISTER_DEVICE_URL, {
      method: 'POST', body: '{}', signal: deps.signal, redirect: 'error', credentials: 'omit',
      headers: oasisHeaders({ ingressCookie, webid })
    }),
    'StepFun device registration failed'
  );
  const registerError = payloadError(registered, 'StepFun device registration failed');
  if (registerError) throw registerError;
  const anonymousToken = tokenFromPayload(registered);

  // Step 3 — sign in. `response.data.token` is the authenticated value; the
  // anonymous token goes back as a header, not in the body.
  step('signin');
  const signedIn = await readJson(
    await run(SIGN_IN_URL, {
      method: 'POST', signal: deps.signal, redirect: 'error', credentials: 'omit',
      headers: oasisHeaders({ ingressCookie, anonymousToken, webid }),
      body: JSON.stringify({ username, password })
    }),
    'StepFun sign-in failed'
  );
  const signInError = payloadError(signedIn, 'StepFun sign-in failed');
  if (signInError) throw signInError;

  const token = tokenFromPayload(signedIn);
  if (!token) {
    const error = new Error('StepFun sign-in returned no Oasis-Token');
    error.status = 'unavailable';
    throw error;
  }
  return token;
}

module.exports = {
  ORIGIN,
  PASSPORT,
  REGISTER_DEVICE_URL,
  SIGN_IN_URL,
  LOGIN_ORIGIN_URL,
  loginStepFun,
  normalizeOasisToken,
  readSetCookies,
  cookieValue,
  tokenFromPayload
};
