'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createPkce,
  deviceAuthorizationUrl,
  refreshQwenworkSession,
  runQwenworkDeviceFlowLogin
} = require('../../src/shared/providers/qwenwork/deviceFlow');

const apiBaseUrl = 'https://gateway.qwenwork.cn';
const authBaseUrl = 'https://gateway.qwenwork.cn';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) };
}

test('QwenWork PKCE and authorization URL match the desktop device flow', () => {
  const pkce = createPkce();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43,128}$/u);
  assert.match(pkce.challenge, /^[A-Za-z0-9_-]{43}$/u);
  const url = new URL(deviceAuthorizationUrl(authBaseUrl, {
    verifier: pkce.verifier,
    challenge: pkce.challenge,
    nonce: 'fixture-nonce',
    machineId: 'fixture-machine'
  }));
  assert.equal(url.origin, authBaseUrl);
  assert.equal(url.pathname, '/device/selectAccounts');
  assert.equal(url.searchParams.get('challenge'), pkce.challenge);
  assert.equal(url.searchParams.get('challenge_method'), 'S256');
  assert.equal(url.searchParams.get('nonce'), 'fixture-nonce');
  assert.equal(url.searchParams.get('machine_id'), 'fixture-machine');
  assert.equal(url.searchParams.get('client_id'), 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb');
  assert.equal(url.searchParams.get('redirect_uri'), 'qwenwork-cn://');
  assert.equal(url.searchParams.has('verifier'), false);
});

test('The device sign-in opens the browser, retries pending polls and returns a refreshable session', async () => {
  const calls = [];
  const statuses = [];
  let polls = 0;
  const opened = [];
  const result = await runQwenworkDeviceFlowLogin({
    authBaseUrl,
    apiBaseUrl,
    onStatus: (status) => statuses.push(status),
    timeoutMs: 20_000
  }, {
    openExternal: async (url) => opened.push(url),
    sleep: async () => {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      polls += 1;
      if (polls === 1) return response({ error: 'authorization_pending' }, 401);
      return response({ token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 });
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.session.access, 'access-token');
  assert.equal(result.session.refresh, 'refresh-token');
  assert.ok(result.session.expiresAt > Date.now());
  assert.equal(opened.length, 1);
  assert.match(opened[0], /\/device\/selectAccounts\?/u);
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(new URL(url).pathname, '/api/v1/deviceToken/poll');
    assert.equal(new URL(url).searchParams.get('challenge_method'), 'S256');
    assert.ok(new URL(url).searchParams.get('verifier'));
    assert.ok(new URL(url).searchParams.get('nonce'));
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Host, undefined);
  }
  assert.deepEqual(statuses.map((status) => status.phase), ['authorize', 'polling', 'success']);
});

test('A refresh rotates the access and refresh tokens without dropping the device identity', async () => {
  const calls = [];
  const result = await refreshQwenworkSession({
    access: 'old-access',
    refresh: 'old-refresh',
    expiresAt: 1,
    deviceToken: 'old-access',
    deviceRefresh: 'old-refresh',
    machineId: 'machine-a'
  }, {
    apiBaseUrl,
    now: () => Date.parse('2026-11-05T12:00:00Z'),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response({ token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    }
  });
  assert.equal(result.access, 'new-access');
  assert.equal(result.refresh, 'new-refresh');
  assert.equal(result.deviceToken, 'new-access');
  assert.equal(result.deviceRefresh, 'new-refresh');
  assert.equal(result.machineId, 'machine-a');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/deviceToken/refresh');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { refresh_token: 'old-refresh', target: 'c' });
});
