'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const {
  DEFAULT_ZED_SERVER_URL,
  normalizeZedAccessToken,
  normalizeZedServerUrl
} = require('../shared/zedLimits');

const DEFAULT_TIMEOUT_MS = 120_000;

function loginError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function urlSafeBase64WithPadding(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function decodeUrlSafeBase64(value) {
  const normalized = String(value || '').replace(/-/gu, '+').replace(/_/gu, '/');
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${'='.repeat(padding)}`, 'base64');
}

function generateKeypair() {
  return new Promise((resolve, reject) => {
    crypto.generateKeyPair('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    }, (error, publicKey, privateKey) => {
      if (error) return reject(error);
      resolve({ publicKey: urlSafeBase64WithPadding(publicKey), privateKey });
    });
  });
}

function decryptAccessToken(privateKey, encryptedToken) {
  const encrypted = decodeUrlSafeBase64(encryptedToken);
  const attempts = [
    { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    { padding: crypto.constants.RSA_PKCS1_PADDING }
  ];
  let lastError;
  for (const options of attempts) {
    try {
      const token = normalizeZedAccessToken(
        crypto.privateDecrypt({ key: privateKey, ...options }, encrypted).toString('utf8')
      );
      // The native sign-in contract guarantees encrypted UTF-8, not a fixed
      // access-token length or alphabet. Apply the same header-safety boundary
      // as every later Zed API request instead of assuming today's token shape.
      if (token) return token;
      lastError = new Error('decrypted token has an unexpected format');
    } catch (error) {
      lastError = error;
    }
  }
  throw loginError('TOKEN_DECRYPT_FAILED', `Could not decrypt the Zed access token: ${lastError?.message || 'unknown error'}`);
}

function callbackPage(ok) {
  const title = ok ? 'Sign-in received' : 'Zed sign-in failed';
  const detail = ok
    ? 'Return to Token Monitor to finish connecting this account.'
    : 'Return to Token Monitor for details.';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px system-ui;padding:40px;max-width:560px;margin:auto"><h1>${title}</h1><p>${detail}</p></body></html>`;
}

async function runZedOAuthLogin(options = {}) {
  if (typeof options.openExternal !== 'function') throw new TypeError('openExternal is required');
  const serverUrl = normalizeZedServerUrl(options.serverUrl || DEFAULT_ZED_SERVER_URL, '');
  if (!serverUrl) throw loginError('INVALID_SERVER_URL', 'Zed server URL must be an HTTPS origin');
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  if (signal.aborted) throw signal.reason || loginError('CANCELLED', 'Zed sign-in cancelled');

  // RSA generation is intentionally asynchronous: doing it synchronously here
  // can stall the Electron main process just as the settings UI enters its busy
  // state.
  const { publicKey, privateKey } = await (options.generateKeypair || generateKeypair)();
  let settleCallback;
  const callback = new Promise((resolve, reject) => { settleCallback = { resolve, reject }; });
  // If opening the browser or binding the server fails before we await this
  // promise, the finally block still aborts the callback. Mark that rejection
  // handled without changing what a later `await callback` observes.
  void callback.catch(() => {});
  let settled = false;
  const settle = (method, value) => {
    if (settled) return;
    settled = true;
    settleCallback[method](value);
  };
  const server = http.createServer((request, response) => {
    let url;
    try { url = new URL(request.url || '/', 'http://127.0.0.1'); } catch (_) {}
    if (request.method !== 'GET' || url?.pathname !== '/') {
      response.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'",
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff'
      });
      response.end('Not found');
      return;
    }
    const userId = String(url.searchParams.get('user_id') || '').trim();
    const encryptedToken = String(url.searchParams.get('access_token') || '').trim();
    if (!/^\d+$/u.test(userId) || !encryptedToken) {
      response.writeHead(400, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff'
      });
      response.end(callbackPage(false));
      settle('reject', loginError('INVALID_CALLBACK', 'Zed returned incomplete sign-in details'));
      return;
    }
    let accessToken;
    try {
      accessToken = (options.decryptAccessToken || decryptAccessToken)(privateKey, encryptedToken);
    } catch (error) {
      response.writeHead(400, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff'
      });
      response.end(callbackPage(false));
      settle('reject', error?.code
        ? error
        : loginError('TOKEN_DECRYPT_FAILED', 'Could not decrypt the Zed access token'));
      return;
    }
    response.writeHead(302, {
      location: `${serverUrl}/native_app_signin_succeeded`,
      'cache-control': 'no-store',
      connection: 'close',
      'content-security-policy': "default-src 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    });
    response.end();
    settle('resolve', { userId, accessToken });
  });

  const closeServer = () => new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
  const abort = () => settle('reject', signal.reason || loginError('CANCELLED', 'Zed sign-in cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    settle('reject', loginError('TIMEOUT', 'Zed sign-in timed out'));
    controller.abort();
  }, timeoutMs);

  try {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    } catch (_) {
      throw loginError('CALLBACK_UNAVAILABLE', 'Could not start the Zed sign-in callback');
    }
    const address = server.address();
    if (!address || typeof address === 'string') throw loginError('CALLBACK_UNAVAILABLE', 'Could not start the Zed sign-in callback');
    const url = new URL('/native_app_signin', serverUrl);
    url.searchParams.set('native_app_port', String(address.port));
    url.searchParams.set('native_app_public_key', publicKey);
    await options.openExternal(url.toString());
    return await callback;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.abort();
    await closeServer();
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  decryptAccessToken,
  generateKeypair,
  runZedOAuthLogin,
  _callbackPage: callbackPage,
  _decodeUrlSafeBase64: decodeUrlSafeBase64,
  _urlSafeBase64WithPadding: urlSafeBase64WithPadding
};
