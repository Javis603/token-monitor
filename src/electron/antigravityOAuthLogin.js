'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const antigravityOAuth = require('../shared/antigravityOAuth');

const DEFAULT_TIMEOUT_MS = 120_000;

function loginError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function callbackPage(ok) {
  const title = ok ? 'Antigravity account connected' : 'Antigravity sign-in failed';
  const detail = ok ? 'You can close this window and return to Token Monitor.' : 'Return to Token Monitor for details.';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px system-ui;padding:40px;max-width:560px;margin:auto"><h1>${title}</h1><p>${detail}</p></body></html>`;
}

async function runAntigravityOAuthLogin(options = {}) {
  const client = options.client || antigravityOAuth.discoverOAuthClient({
    env: options.env,
    logger: options.logger
  });
  if (!client) {
    throw loginError(
      'OAUTH_CLIENT_NOT_FOUND',
      'Antigravity OAuth is unavailable in this build. Update Token Monitor or configure ANTIGRAVITY_OAUTH_CLIENT_ID and ANTIGRAVITY_OAUTH_CLIENT_SECRET.'
    );
  }
  if (typeof options.openExternal !== 'function') throw new TypeError('openExternal is required');
  const state = crypto.randomBytes(32).toString('base64url');
  const { codeVerifier, codeChallenge } = antigravityOAuth.generatePkce();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  if (signal.aborted) throw signal.reason || loginError('CANCELLED', 'Google sign-in cancelled');

  let settleCallback;
  const callback = new Promise((resolve, reject) => { settleCallback = { resolve, reject }; });
  let settled = false;
  const settle = (method, value) => {
    if (settled) return;
    settled = true;
    settleCallback[method](value);
  };
  const server = http.createServer((request, response) => {
    let url;
    try { url = new URL(request.url || '/', 'http://127.0.0.1'); } catch (_) {}
    if (request.method !== 'GET' || url?.pathname !== '/oauth-callback') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const callbackState = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    const oauthError = url.searchParams.get('error') || '';
    const ok = callbackState === state && Boolean(code) && !oauthError;
    response.writeHead(ok ? 200 : 400, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'close',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    });
    response.end(callbackPage(ok));
    // Ignore callbacks with the wrong state instead of letting another local
    // process cancel the real browser flow. The bound loopback port is public
    // to the machine; the random state is the authorization boundary.
    if (callbackState !== state) return;
    if (oauthError) settle('reject', loginError('OAUTH_DENIED', `Google sign-in failed: ${oauthError}`));
    else if (!code) settle('reject', loginError('OAUTH_CODE_MISSING', 'Google sign-in returned no authorization code'));
    else settle('resolve', code);
  });

  const closeServer = () => new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    // This is a one-shot loopback callback. Chromium can retain the HTTP socket
    // after the success page has finished, and server.close() waits for that
    // connection before resolving. Do not keep the account-save IPC pending on
    // the browser's keep-alive timeout.
    server.closeAllConnections();
  });
  const abort = () => settle('reject', signal.reason || loginError('CANCELLED', 'Google sign-in cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    settle('reject', loginError('TIMEOUT', 'Google sign-in timed out'));
    controller.abort();
  }, timeoutMs);

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw loginError('CALLBACK_UNAVAILABLE', 'Could not start the Google sign-in callback');
    const redirectUri = `http://127.0.0.1:${address.port}/oauth-callback`;
    await options.openExternal(antigravityOAuth.authorizationUrl({
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge
    }));
    const code = await callback;
    const credential = await antigravityOAuth.exchangeAuthorizationCode({
      code,
      client,
      redirectUri,
      codeVerifier
    }, {
      fetch: options.fetch,
      signal,
      now: options.now
    });
    const identity = await antigravityOAuth.fetchGoogleIdentity(credential, {
      fetch: options.fetch,
      signal
    });
    return { credential: { ...credential, email: identity.email }, identity };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.abort();
    await closeServer();
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  runAntigravityOAuthLogin,
  _callbackPage: callbackPage
};
