'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const test = require('node:test');

const { runAntigravityOAuthLogin } = require('../../src/electron/antigravityOAuthLogin');

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('Antigravity OAuth login binds a loopback callback and ignores the wrong state', async () => {
  const opened = [];
  const result = await runAntigravityOAuthLogin({
    client: { clientId: 'client', clientSecret: 'secret' },
    timeoutMs: 5000,
    openExternal: async (authUrl) => {
      opened.push(authUrl);
      const auth = new URL(authUrl);
      const redirect = new URL(auth.searchParams.get('redirect_uri'));
      assert.equal(redirect.hostname, '127.0.0.1');
      assert.equal(redirect.pathname, '/oauth-callback');
      const wrong = new URL(redirect);
      wrong.searchParams.set('state', 'wrong');
      wrong.searchParams.set('code', 'attacker');
      assert.equal((await fetch(wrong)).status, 400);
      redirect.searchParams.set('state', auth.searchParams.get('state'));
      redirect.searchParams.set('code', 'real-code');
      assert.equal((await fetch(redirect)).status, 200);
    },
    fetch: async (url, init = {}) => {
      if (String(url).includes('/token')) {
        assert.match(init.body, /code=real-code/);
        return response(200, {
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600
        });
      }
      if (String(url).includes('/userinfo')) {
        assert.equal(init.headers.authorization, 'Bearer access');
        return response(200, { email: 'Person@Example.com', name: 'Person' });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });
  assert.equal(opened.length, 1);
  assert.equal(result.identity.email, 'person@example.com');
  assert.equal(result.credential.refreshToken, 'refresh');
});

test('Antigravity OAuth login does not open a browser after cancellation', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  let opened = false;
  await assert.rejects(runAntigravityOAuthLogin({
    client: { clientId: 'client', clientSecret: 'secret' },
    signal: controller.signal,
    openExternal: async () => { opened = true; }
  }), /cancelled/);
  assert.equal(opened, false);
});

test('Antigravity OAuth login does not wait for a retained callback socket', async () => {
  let socket;
  const startedAt = Date.now();
  const result = await runAntigravityOAuthLogin({
    client: { clientId: 'client', clientSecret: 'secret' },
    timeoutMs: 5000,
    openExternal: async (authUrl) => {
      const auth = new URL(authUrl);
      const redirect = new URL(auth.searchParams.get('redirect_uri'));
      redirect.searchParams.set('state', auth.searchParams.get('state'));
      redirect.searchParams.set('code', 'real-code');
      await new Promise((resolve, reject) => {
        socket = net.createConnection(Number(redirect.port), redirect.hostname, () => {
          socket.write(
            `GET ${redirect.pathname}${redirect.search} HTTP/1.1\r\n`
            + `Host: ${redirect.host}\r\nConnection: keep-alive\r\n\r\n`
            + 'GET /unfinished HTTP/1.1\r\n'
          );
        });
        socket.once('error', reject);
        socket.on('data', (chunk) => {
          if (chunk.toString().includes('Antigravity account connected')) resolve();
        });
      });
    },
    fetch: async (url) => {
      if (String(url).includes('/token')) {
        return response(200, { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
      }
      if (String(url).includes('/userinfo')) {
        return response(200, { email: 'person@example.com', name: 'Person' });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  assert.equal(result.identity.email, 'person@example.com');
  assert.ok(Date.now() - startedAt < 1000, 'login should not wait for callback keep-alive');
  if (!socket.destroyed) await once(socket, 'close', { signal: AbortSignal.timeout(500) });
  assert.equal(socket.destroyed, true);
});
