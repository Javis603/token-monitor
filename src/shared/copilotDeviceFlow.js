'use strict';

const { normalizedEnterpriseHost } = require('./copilotLimits');

const COPILOT_DEVICE_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const COPILOT_DEVICE_SCOPE = 'read:user';
const DEFAULT_POLL_INTERVAL_SEC = 5;
const SLOW_DOWN_EXTRA_MS = 5000;

function errorWithStatus(status, message) {
  const error = new Error(message || status);
  error.status = status;
  return error;
}

function deviceFlowHost(enterpriseHost) {
  return normalizedEnterpriseHost(enterpriseHost);
}

function verificationUrlHost(parsed) {
  if (!parsed?.hostname) return '';
  return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
}

function isAllowedVerificationUrl(url, enterpriseHost = '') {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (verificationUrlHost(parsed) !== deviceFlowHost(enterpriseHost)) return false;
  return parsed.pathname.startsWith('/login/device') || parsed.pathname.startsWith('/login/oauth');
}

function deviceCodeUrl(enterpriseHost) {
  return `https://${deviceFlowHost(enterpriseHost)}/login/device/code`;
}

function accessTokenUrl(enterpriseHost) {
  return `https://${deviceFlowHost(enterpriseHost)}/login/oauth/access_token`;
}

function formEncode(value) {
  return encodeURIComponent(String(value || ''))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function formBody(parameters) {
  return Object.entries(parameters)
    .map(([key, value]) => `${formEncode(key)}=${formEncode(value)}`)
    .join('&');
}

function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(errorWithStatus('cancelled', 'Sign-in cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      if (signal?.aborted) reject(errorWithStatus('cancelled', 'Sign-in cancelled'));
      else resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(errorWithStatus('cancelled', 'Sign-in cancelled'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

async function fetchForm(url, body, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const timeoutMs = Number(deps.fetchTimeoutMs || 15000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const externalSignal = deps.signal;
  const onAbort = () => controller?.abort();
  externalSignal?.addEventListener?.('abort', onAbort);
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) throw errorWithStatus('unavailable', `${url} returned ${response.status}`);
    return await response.json();
  } catch (error) {
    if (externalSignal?.aborted) throw errorWithStatus('cancelled', 'Sign-in cancelled');
    if (error?.name === 'AbortError') throw errorWithStatus('timedOut', 'GitHub request timed out');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', onAbort);
  }
}

function normalizeDeviceCodeResponse(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const deviceCode = String(source.device_code || source.deviceCode || '').trim();
  const userCode = String(source.user_code || source.userCode || '').trim();
  const verificationUri = String(source.verification_uri || source.verificationUri || '').trim();
  const verificationUriComplete = String(source.verification_uri_complete || source.verificationUriComplete || '').trim();
  const expiresIn = Number(source.expires_in ?? source.expiresIn ?? 0);
  const interval = Number(source.interval ?? source.intervalInSeconds ?? source.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SEC);
  if (!deviceCode || !userCode || !verificationUri) {
    throw errorWithStatus('unavailable', 'GitHub device code response was incomplete');
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: verificationUriComplete || '',
    verificationUrl: verificationUriComplete || verificationUri,
    expiresIn,
    interval: Math.max(0, interval)
  };
}

async function requestDeviceCode(enterpriseHost = '', deps = {}) {
  const body = formBody({
    client_id: COPILOT_DEVICE_CLIENT_ID,
    scope: COPILOT_DEVICE_SCOPE
  });
  const json = await fetchForm(deviceCodeUrl(enterpriseHost), body, deps);
  return normalizeDeviceCodeResponse(json);
}

function parsePollError(json) {
  const error = String(json?.error || '').trim();
  if (!error) return null;
  if (error === 'authorization_pending') return { kind: 'pending' };
  if (error === 'slow_down') return { kind: 'slow_down' };
  if (error === 'expired_token') return { kind: 'expired' };
  if (error === 'access_denied') return { kind: 'denied' };
  return { kind: 'error', message: String(json?.error_description || json?.error || 'GitHub sign-in failed') };
}

async function pollForAccessToken(deviceCode, enterpriseHost = '', deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const body = formBody({
    client_id: COPILOT_DEVICE_CLIENT_ID,
    device_code: deviceCode.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  });
  const url = accessTokenUrl(enterpriseHost);
  const startedAt = (deps.now || Date.now)();
  const deadlineMs = deviceCode.expiresIn > 0 ? startedAt + deviceCode.expiresIn * 1000 : startedAt + 15 * 60 * 1000;
  let intervalMs = deviceCode.interval * 1000;

  while (true) {
    if (deps.signal?.aborted) throw errorWithStatus('cancelled', 'Sign-in cancelled');
    if ((deps.now || Date.now)() >= deadlineMs) throw errorWithStatus('timedOut', 'GitHub sign-in timed out');
    await sleep(intervalMs, deps.signal);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), Number(deps.fetchTimeoutMs || 15000)) : null;
    let json;
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body,
        ...(controller ? { signal: controller.signal } : {})
      });
      json = await response.json();
    } catch (error) {
      if (deps.signal?.aborted) throw errorWithStatus('cancelled', 'Sign-in cancelled');
      if (error?.name === 'AbortError') throw errorWithStatus('timedOut', 'GitHub request timed out');
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }

    const token = String(json?.access_token || json?.accessToken || '').trim();
    if (token) return token;

    const pollError = parsePollError(json);
    if (!pollError || pollError.kind === 'pending') continue;
    if (pollError.kind === 'slow_down') {
      intervalMs += SLOW_DOWN_EXTRA_MS;
      continue;
    }
    if (pollError.kind === 'expired') throw errorWithStatus('timedOut', 'GitHub device code expired');
    if (pollError.kind === 'denied') throw errorWithStatus('denied', 'GitHub sign-in was denied');
    throw errorWithStatus('unavailable', pollError.message || 'GitHub sign-in failed');
  }
}

async function runCopilotDeviceFlowLogin(options = {}, deps = {}) {
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  const enterpriseHost = options.enterpriseHost || '';
  const flowDeps = { ...deps, signal: options.signal || deps.signal };

  onStatus({ phase: 'requesting' });
  const deviceCode = await requestDeviceCode(enterpriseHost, flowDeps);

  let copiedToClipboard = false;
  if (typeof deps.copyToClipboard === 'function') {
    try {
      await deps.copyToClipboard(deviceCode.userCode);
      copiedToClipboard = true;
    } catch (_) {}
  }

  onStatus({
    phase: 'authorize',
    userCode: deviceCode.userCode,
    verificationUrl: deviceCode.verificationUrl,
    expiresIn: deviceCode.expiresIn,
    copiedToClipboard
  });

  if (options.openBrowser !== false && typeof deps.openExternal === 'function') {
    if (!isAllowedVerificationUrl(deviceCode.verificationUrl, enterpriseHost)) {
      throw errorWithStatus('unavailable', 'GitHub returned an unexpected verification URL');
    }
    await deps.openExternal(deviceCode.verificationUrl);
  }

  onStatus({ phase: 'polling', userCode: deviceCode.userCode });
  const accessToken = await pollForAccessToken(deviceCode, enterpriseHost, flowDeps);
  onStatus({ phase: 'success', userCode: deviceCode.userCode });
  return { ok: true, accessToken };
}

function copilotLoginErrorMessage(error) {
  const status = error?.status;
  if (status === 'cancelled') return 'Sign-in cancelled.';
  if (status === 'timedOut') return 'GitHub sign-in timed out. Finish authorization in the browser, then try again.';
  if (status === 'denied') return 'GitHub sign-in was denied.';
  if (status === 'unavailable') return error?.message || 'GitHub sign-in is unavailable right now.';
  return error?.message || 'GitHub sign-in failed.';
}

module.exports = {
  COPILOT_DEVICE_CLIENT_ID,
  COPILOT_DEVICE_SCOPE,
  isAllowedVerificationUrl,
  verificationUrlHost,
  deviceCodeUrl,
  accessTokenUrl,
  requestDeviceCode,
  pollForAccessToken,
  runCopilotDeviceFlowLogin,
  copilotLoginErrorMessage
};
