'use strict';

const { realmConfig, normalizeCredential, verifyIdentity, authRequest, authError,
  boundedOperation, isSuccessCode } = require('../../../shared/providers/workbuddy/oauth');

function validateLoginUrl(value, state, realm) {
  const config = realmConfig(realm);
  try {
    const url = new URL(value);
    // URL.port erases explicit :443. Check the raw authority as well.
    if (typeof value !== 'string' || !value.startsWith(`${config.origin}/`)
      || url.origin !== config.origin || url.pathname !== '/login'
      || url.username || url.password || url.port || url.hash
      || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state
      || url.searchParams.getAll('platform').length !== 1 || url.searchParams.get('platform') !== config.platform) {
      throw authError('INVALID_LOGIN_URL');
    }
    return url.toString();
  } catch (_) { throw authError('INVALID_LOGIN_URL'); }
}

async function runWorkbuddyOAuthLogin(options = {}) {
  const { realm, fetch, openExternal, signal, requestTimeoutMs = 15_000,
    timeoutMs = 120_000, pollIntervalMs = 1_000, now = Date.now } = options;
  const config = realmConfig(realm);
  if (typeof openExternal !== 'function') throw authError('BROWSER_UNAVAILABLE');
  return boundedOperation(async (loginSignal) => {
    const request = (path, extra = {}) => authRequest(realm, path, {
      fetch, signal: loginSignal, timeoutMs: requestTimeoutMs, ...extra
    });
    const initial = await request(`/v2/plugin/auth/state?platform=${config.platform}`, { method: 'POST' });
    const state = initial?.data?.state;
    if (!isSuccessCode(initial.code) || typeof state !== 'string' || !state || state.length > 2048
      || /[\x00-\x20\x7f]/.test(state)) throw authError('INVALID_STATE');
    const url = validateLoginUrl(initial.data.authUrl, state, realm);
    try { await boundedOperation(() => openExternal(url), { signal: loginSignal, timeoutMs: requestTimeoutMs }); }
    catch (error) {
      if (['CANCELED', 'TIMEOUT'].includes(error?.code)) throw authError(error.code);
      throw authError('BROWSER_UNAVAILABLE');
    }
    const poll = async (path, pending, headers) => {
      for (;;) {
        const payload = await request(path, { headers });
        if (isSuccessCode(payload.code) && payload.data) return payload.data;
        if (payload.code !== pending) throw authError('LOGIN_FAILED');
        await boundedOperation((delaySignal) => new Promise((resolve) => {
          const timer = setTimeout(done, pollIntervalMs);
          function done() { clearTimeout(timer); delaySignal.removeEventListener('abort', done); resolve(); }
          delaySignal.addEventListener('abort', done, { once: true });
        }), { signal: loginSignal, timeoutMs: requestTimeoutMs + pollIntervalMs });
      }
    };
    const encoded = encodeURIComponent(state);
    const rawCredential = await poll(`/v2/plugin/auth/token?state=${encoded}`, 11217);
    const credential = normalizeCredential(rawCredential, { realm, now: now() });
    const rawIdentity = await poll(`/v2/plugin/login/account?state=${encoded}`, 12151, {
      Authorization: `Bearer ${credential.accessToken}`, 'X-Domain': credential.domain,
      'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true', 'X-No-Department-Info': 'true'
    });
    const identity = verifyIdentity(rawIdentity, { ...rawCredential, domain: credential.domain }, realm);
    if (loginSignal.aborted) throw authError('CANCELED');
    return { credential, identity };
  }, { signal, timeoutMs });
}

module.exports = { runWorkbuddyOAuthLogin, validateLoginUrl };
