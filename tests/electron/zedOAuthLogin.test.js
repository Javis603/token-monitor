'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  _callbackPage,
  _decodeUrlSafeBase64,
  decryptAccessToken,
  generateKeypair,
  runZedOAuthLogin
} = require('../../src/electron/zedOAuthLogin');

function encryptToken(publicKey, token, options = {}) {
  const key = crypto.createPublicKey({
    key: _decodeUrlSafeBase64(publicKey),
    type: 'pkcs1',
    format: 'der'
  });
  return crypto.publicEncrypt({
    key,
    padding: options.padding || crypto.constants.RSA_PKCS1_OAEP_PADDING,
    ...(options.oaepHash === false ? {} : { oaepHash: options.oaepHash || 'sha256' })
  }, Buffer.from(token)).toString('base64url');
}

test('Zed login uses the native app callback and decrypts OAEP-SHA256 credentials', async () => {
  const opened = [];
  const accessToken = 'a'.repeat(64);
  const result = await runZedOAuthLogin({
    timeoutMs: 5000,
    openExternal: async (loginUrl) => {
      opened.push(loginUrl);
      const url = new URL(loginUrl);
      assert.equal(url.origin, 'https://zed.dev');
      assert.equal(url.pathname, '/native_app_signin');
      assert.match(url.searchParams.get('native_app_public_key'), /^[A-Za-z0-9_=-]+$/u);
      const callback = new URL(`http://127.0.0.1:${url.searchParams.get('native_app_port')}/`);
      callback.searchParams.set('user_id', '12345');
      callback.searchParams.set('access_token', encryptToken(url.searchParams.get('native_app_public_key'), accessToken));
      const response = await fetch(callback, { redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), 'https://zed.dev/native_app_signin_succeeded');
    }
  });
  assert.equal(opened.length, 1);
  assert.deepEqual(result, { userId: '12345', accessToken });
});

test('Zed login rejects a malformed callback instead of waiting for timeout', async () => {
  let callbackStatus;
  await assert.rejects(runZedOAuthLogin({
    timeoutMs: 5000,
    openExternal: async (loginUrl) => {
      const url = new URL(loginUrl);
      const callback = new URL(`http://127.0.0.1:${url.searchParams.get('native_app_port')}/`);
      callback.searchParams.set('user_id', 'attacker');
      callback.searchParams.set('access_token', 'bad');
      callbackStatus = (await fetch(callback)).status;
    }
  }), (error) => error?.code === 'INVALID_CALLBACK');
  assert.equal(callbackStatus, 400);
});

test('Zed login rejects an undecryptable callback instead of staying busy', async () => {
  let callbackStatus;
  await assert.rejects(runZedOAuthLogin({
    timeoutMs: 5000,
    openExternal: async (loginUrl) => {
      const url = new URL(loginUrl);
      const callback = new URL(`http://127.0.0.1:${url.searchParams.get('native_app_port')}/`);
      callback.searchParams.set('user_id', '77');
      callback.searchParams.set('access_token', 'bad');
      callbackStatus = (await fetch(callback)).status;
    }
  }), (error) => error?.code === 'TOKEN_DECRYPT_FAILED');
  assert.equal(callbackStatus, 400);
});

test('Zed token decryption accepts the legacy PKCS1 v1.5 format', async () => {
  const pair = await generateKeypair();
  const accessToken = 'c'.repeat(64);
  const encrypted = encryptToken(pair.publicKey, accessToken, {
    padding: crypto.constants.RSA_PKCS1_PADDING,
    oaepHash: false
  });
  assert.equal(decryptAccessToken(pair.privateKey, encrypted), accessToken);
});

test('Zed token decryption does not assume a fixed plaintext token shape', async () => {
  const pair = await generateKeypair();
  const accessToken = 'zed-token.with-a-different-length_123';
  const encrypted = encryptToken(pair.publicKey, accessToken);
  assert.equal(decryptAccessToken(pair.privateKey, encrypted), accessToken);
});

test('Zed login does not open a browser after cancellation', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  let opened = false;
  await assert.rejects(runZedOAuthLogin({
    signal: controller.signal,
    openExternal: async () => { opened = true; }
  }), /cancelled/);
  assert.equal(opened, false);
});

test('Zed login closes cleanly when opening the browser fails', async () => {
  await assert.rejects(runZedOAuthLogin({
    openExternal: async () => { throw new Error('browser unavailable'); }
  }), /browser unavailable/);
});

test('Zed callback page does not claim persistence finished', () => {
  const page = _callbackPage(true);
  assert.match(page, /Sign-in received/);
  assert.match(page, /Return to Token Monitor to finish connecting this account/);
  assert.doesNotMatch(page, /account connected/);
});
