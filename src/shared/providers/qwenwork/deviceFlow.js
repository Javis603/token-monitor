'use strict';

const crypto = require('node:crypto');
const { errorWithStatus } = require('../../limits/providerHelpers');

// QwenWork's desktop client signs in with the same PKCE device flow: the
// browser authorizes a nonce, and the client polls the gateway for the device
// token. The flow needs no redirect handler, so Token Monitor can run it
// without registering a custom URL scheme.
const QWENWORK_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';
const QWENWORK_AUTH_BASE_URL = 'https://gateway.qwenwork.cn';
const QWENWORK_REDIRECT_URI = 'qwenwork-cn://';
const QWENWORK_DEVICE_AUTHORIZE_PATH = '/device/selectAccounts';
const QWENWORK_DEVICE_POLL_PATH = '/api/v1/deviceToken/poll';
const QWENWORK_DEVICE_REFRESH_PATH = '/api/v1/deviceToken/refresh';
const QWENWORK_POLL_INTERVAL_MS = 1000;
const QWENWORK_LOGIN_TIMEOUT_MS = 300_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function createPkce() {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function deviceAuthorizationUrl(authBaseUrl, flow) {
  const url = new URL(QWENWORK_DEVICE_AUTHORIZE_PATH, authBaseUrl);
  url.searchParams.set('challenge', flow.challenge);
  url.searchParams.set('challenge_method', 'S256');
  url.searchParams.set('nonce', flow.nonce);
  url.searchParams.set('machine_id', flow.machineId);
  url.searchParams.set('client_id', QWENWORK_CLIENT_ID);
  url.searchParams.set('redirect_uri', QWENWORK_REDIRECT_URI);
  return url.href;
}

function sessionExpiry(body, fallbackNow = Date.now()) {
  const at = Date.parse(String(body?.expires_at ?? '').trim());
  if (Number.isFinite(at)) return at;
  const expiresIn = Number(body?.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return fallbackNow + expiresIn * 1000;
  return fallbackNow + DAY_MS;
}

function parseDeviceToken(body, now = Date.now()) {
  const token = String(body?.token ?? '').trim();
  if (!token) throw errorWithStatus('unavailable', 'QwenWork returned an empty device token');
  return {
    access: token,
    refresh: String(body?.refresh_token ?? '').trim(),
    expiresAt: sessionExpiry(body, now),
    deviceToken: token,
    deviceRefresh: String(body?.refresh_token ?? '').trim()
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(errorWithStatus('cancelled', 'QwenWork sign-in cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      if (signal?.aborted) reject(errorWithStatus('cancelled', 'QwenWork sign-in cancelled'));
      else resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(errorWithStatus('cancelled', 'QwenWork sign-in cancelled'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

async function requestJson(url, init, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutMs = Number(deps.fetchTimeoutMs || 15000);
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const externalSignal = deps.signal;
  const onAbort = () => controller?.abort();
  externalSignal?.addEventListener?.('abort', onAbort);
  try {
    const response = await fetchImpl(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
    if (externalSignal?.aborted) throw errorWithStatus('cancelled', 'QwenWork sign-in cancelled');
    if (response.status === 401 || response.status === 403) {
      throw errorWithStatus('unauthorized', `QwenWork rejected the request (HTTP ${response.status})`);
    }
    return { response, body: await response.json().catch(() => null) };
  } catch (error) {
    if (externalSignal?.aborted) throw errorWithStatus('cancelled', 'QwenWork sign-in cancelled');
    if (error?.name === 'AbortError') throw errorWithStatus('timedOut', 'QwenWork request timed out');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', onAbort);
  }
}

function pollUrl(baseUrl, flow) {
  const url = new URL(QWENWORK_DEVICE_POLL_PATH, baseUrl);
  url.searchParams.set('nonce', flow.nonce);
  url.searchParams.set('verifier', flow.verifier);
  url.searchParams.set('challenge_method', 'S256');
  return url.href;
}

async function runQwenworkDeviceFlowLogin(options = {}, deps = {}) {
  if (!options.authBaseUrl) throw errorWithStatus('unavailable', 'QwenWork authorization host is not configured');
  if (!options.apiBaseUrl) throw errorWithStatus('unavailable', 'QwenWork gateway is not configured');
  if (typeof deps.openExternal !== 'function') throw errorWithStatus('unavailable', 'Opening the browser is unavailable');
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  const now = deps.now || Date.now;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : QWENWORK_LOGIN_TIMEOUT_MS;
  const flow = {
    ...createPkce(),
    nonce: crypto.randomUUID(),
    machineId: crypto.randomUUID()
  };
  const url = deviceAuthorizationUrl(options.authBaseUrl, flow);
  onStatus({ phase: 'authorize', url });
  await deps.openExternal(url);
  onStatus({ phase: 'polling' });
  const deadline = now() + timeoutMs;
  while (true) {
    if (deps.signal?.aborted) throw errorWithStatus('cancelled', 'QwenWork sign-in cancelled');
    if (now() >= deadline) throw errorWithStatus('timedOut', 'QwenWork sign-in timed out');
    let body = null;
    try {
      const result = await requestJson(pollUrl(options.apiBaseUrl, flow), {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-Request-Id': crypto.randomUUID() }
      }, deps);
      if (result.response.ok) body = result.body;
    } catch (error) {
      if (error?.status === 'cancelled' || error?.status === 'timedOut') throw error;
      // An unauthorized or not-yet-authorized poll is the normal pending state
      // for this endpoint; keep polling until the deadline.
    }
    if (body && String(body.token ?? '').trim()) {
      const session = { ...parseDeviceToken(body, now()), machineId: flow.machineId };
      onStatus({ phase: 'success' });
      return { ok: true, session };
    }
    await (deps.sleep || sleep)(deps.pollIntervalMs ?? QWENWORK_POLL_INTERVAL_MS, deps.signal);
  }
}

async function refreshQwenworkSession(session, deps = {}) {
  if (!session?.refresh) throw errorWithStatus('unauthorized', 'QwenWork sign-in has no refresh token');
  const apiBaseUrl = deps.apiBaseUrl;
  if (!apiBaseUrl) throw errorWithStatus('unavailable', 'QwenWork gateway is not configured');
  const { response, body } = await requestJson(new URL(QWENWORK_DEVICE_REFRESH_PATH, apiBaseUrl).href, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh, target: 'c' })
  }, deps);
  if (!response.ok) throw errorWithStatus('unauthorized', `QwenWork refresh failed (HTTP ${response.status})`);
  const token = String(body?.token ?? '').trim();
  if (!token) throw errorWithStatus('unauthorized', 'QwenWork refresh returned no token');
  return {
    ...session,
    access: token,
    refresh: String(body?.refresh_token ?? session.refresh).trim(),
    deviceToken: token,
    deviceRefresh: String(body?.refresh_token ?? session.deviceRefresh ?? session.refresh).trim(),
    expiresAt: sessionExpiry(body, (deps.now || Date.now)())
  };
}

module.exports = {
  QWENWORK_AUTH_BASE_URL,
  QWENWORK_CLIENT_ID,
  QWENWORK_DEVICE_AUTHORIZE_PATH,
  QWENWORK_DEVICE_POLL_PATH,
  QWENWORK_DEVICE_REFRESH_PATH,
  QWENWORK_LOGIN_TIMEOUT_MS,
  QWENWORK_POLL_INTERVAL_MS,
  QWENWORK_REDIRECT_URI,
  createPkce,
  deviceAuthorizationUrl,
  parseDeviceToken,
  refreshQwenworkSession,
  runQwenworkDeviceFlowLogin,
  sessionExpiry
};
