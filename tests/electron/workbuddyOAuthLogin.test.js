'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runWorkbuddyOAuthLogin, validateLoginUrl } = require('../../src/electron/providers/workbuddy/oauthLogin');

const response = (data) => ({ status: 200, json: async () => data });
function fakeLogin(realm = 'cn', token = {}, identity = {}) {
  const origin = realm === 'cn' ? 'https://www.codebuddy.cn' : 'https://www.workbuddy.ai';
  const platform = realm === 'cn' ? 'workbuddy' : 'workbuddy-ai';
  const data = [{ code: 0, data: { state: 'private-state', authUrl: `${origin}/login?state=private-state&platform=${platform}` } },
    { code: 11217 }, { code: 0, data: { accessToken: 'private-access', refreshToken: 'private-refresh', expiresIn: 60, ...token } },
    { code: 12151 }, { code: 0, data: { uid: 'u1', type: 'personal', name: 'Alice', email: 'a@example.com', ...identity } }];
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); return response(data.shift()); } };
}

test('both realms issue official state, open validated browser URL, poll separate pending states and verify identity', async () => {
  for (const realm of ['cn', 'ai']) {
    const fake = fakeLogin(realm);
    let opened;
    const result = await runWorkbuddyOAuthLogin({ realm, fetch: fake.fetch,
      openExternal: async (url) => { opened = url; }, pollIntervalMs: 0, now: () => 1000 });
    const origin = realm === 'cn' ? 'https://www.codebuddy.cn' : 'https://www.workbuddy.ai';
    assert.equal(fake.calls.length, 5);
    assert.equal(fake.calls[0].url, `${origin}/v2/plugin/auth/state?platform=${realm === 'cn' ? 'workbuddy' : 'workbuddy-ai'}`);
    assert.equal(fake.calls[0].init.method, 'POST');
    assert.ok(opened.startsWith(`${origin}/login?`));
    assert.ok(fake.calls.every(({ init }) => init.credentials === 'omit' && init.redirect === 'error'));
    assert.equal(fake.calls[1].init.headers.Authorization, undefined);
    assert.equal(fake.calls[3].init.headers.Authorization, 'Bearer private-access');
    assert.equal(result.identity.userId, 'u1');
    assert.equal(result.identity.domain, new URL(origin).hostname);
    assert.equal(result.credential.expiresAt, 61000);
    assert.equal(result.identity.accessToken, undefined);
  }
});

test('code 200 success envelopes follow the reference client without relaxing browser or identity validation', async () => {
  const fake = fakeLogin('cn', { domain: 'www.workbuddy.cn', accessToken: 'x'.repeat(4096) });
  const result = await runWorkbuddyOAuthLogin({ realm: 'cn', openExternal: async () => {}, pollIntervalMs: 0,
    fetch: async (...args) => {
      const original = await fake.fetch(...args);
      const payload = await original.json();
      return response({ ...payload, code: payload.code === 0 ? 200 : payload.code });
    } });
  assert.equal(result.credential.accessToken.length, 4096);
  assert.equal(result.identity.domain, 'www.workbuddy.cn');
});

test('official ultimate and exclusive enterprise accounts complete browser login with bound context', async () => {
  for (const type of ['ultimate', 'exclusive']) {
    const fake = fakeLogin('cn', {}, { type, enterpriseId: 'enterprise', departmentFullName: '研发部' });
    const result = await runWorkbuddyOAuthLogin({ realm: 'cn', fetch: fake.fetch,
      openExternal: async () => {}, pollIntervalMs: 0 });
    assert.equal(result.identity.enterpriseId, 'enterprise');
    assert.equal(result.identity.departmentInfo, '研发部');
    const invalid = fakeLogin('cn', {}, { type });
    await assert.rejects(runWorkbuddyOAuthLogin({ realm: 'cn', fetch: invalid.fetch,
      openExternal: async () => {}, pollIntervalMs: 0 }), { code: 'INVALID_IDENTITY' });
  }
});

test('browser URL requires exact HTTPS origin/path, no credentials/explicit port and unique bound state/platform', () => {
  const good = 'https://www.codebuddy.cn/login?state=s&platform=workbuddy';
  assert.equal(validateLoginUrl(good, 's', 'cn'), good);
  for (const bad of [good.replace('https:', 'http:'), good.replace('.cn/', '.cn:443/'),
    good.replace('.cn/', '.cn:8443/'), good.replace('www.', 'user:password@www.'),
    good.replace('/login?', '/login/else?'), good.replace('www.codebuddy.cn', 'evil.example'),
    good.replace('state=s', 'state=other'), good.replace('platform=workbuddy', 'platform=workbuddy-ai'),
    `${good}&state=s`, `${good}&platform=workbuddy`, `${good}#fragment`,
    good.replace('www.codebuddy.cn', 'www.workbuddy.ai'), ` ${good}`]) {
    assert.throws(() => validateLoginUrl(bad, 's', 'cn'), { code: 'INVALID_LOGIN_URL' });
  }
});

test('terminal token/account codes stop polling and do not expose server errors', async () => {
  for (const terminalAt of [1, 3]) {
    const fake = fakeLogin();
    let calls = 0;
    await assert.rejects(runWorkbuddyOAuthLogin({ realm: 'cn', openExternal: async () => {},
      pollIntervalMs: 0, fetch: async (...args) => {
        const result = await fake.fetch(...args);
        return calls++ === terminalAt ? response({ code: 10081, msg: 'private-state private-access URL' }) : result;
      } }), (error) => error.code === 'LOGIN_FAILED' && !String(error).includes('private'));
    assert.equal(calls, terminalAt + 1);
  }
});

test('login rejects mismatched token identity, enterprise type and domain before publishing credentials', async () => {
  for (const [token, identity] of [[{ uid: 'other' }, {}], [{ enterpriseId: 'e1' }, {}],
    [{ departmentInfo: 'other' }, {}], [{}, { enterpriseId: {} }],
    [{}, { type: 'enterprise' }], [{}, { domain: 'copilot.tencent.com' }], [{}, { uid: '' }]]) {
    const fake = fakeLogin('cn', token, identity);
    await assert.rejects(runWorkbuddyOAuthLogin({ realm: 'cn', fetch: fake.fetch,
      openExternal: async () => {}, pollIntervalMs: 0 }), (error) => ['CONTEXT_CHANGED', 'INVALID_IDENTITY'].includes(error.code));
  }
});

test('per-request and total deadlines include stalled response body, browser open and pending polls', async () => {
  const never = () => new Promise(() => {});
  for (const options of [
    { fetch: never },
    { fetch: async () => ({ status: 200, json: never }) },
    { fetch: fakeLogin().fetch, openExternal: never },
    { fetch: async (url) => url.includes('/auth/state') ? fakeLogin().fetch(url, {}) : response({ code: 11217 }), pollIntervalMs: 0 }
  ]) {
    await assert.rejects(runWorkbuddyOAuthLogin({ realm: 'cn', openExternal: async () => {},
      requestTimeoutMs: 15, timeoutMs: 30, ...options }), { code: 'TIMEOUT' });
  }
});

test('abort stops uncooperative transport, uses sanitized code and starts no work for pre-aborted signal', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const pending = runWorkbuddyOAuthLogin({ realm: 'cn', openExternal: async () => {}, signal: controller.signal,
    fetch: () => { started(); return new Promise(() => {}); } });
  await ready;
  controller.abort(new Error('private-state'));
  await assert.rejects(pending, (error) => error.code === 'CANCELED' && !String(error).includes('private'));
  let calls = 0;
  await assert.rejects(runWorkbuddyOAuthLogin({ realm: 'cn', openExternal: async () => {}, signal: controller.signal,
    fetch: () => { calls++; } }), { code: 'CANCELED' });
  assert.equal(calls, 0);
});
