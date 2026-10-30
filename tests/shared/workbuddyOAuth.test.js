'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hashKey } = require('../../src/shared/hashKey');
const { normalizeManagedAccounts, workbuddyAccountKey, realmConfig, normalizeCredential,
  refreshCredential, isSuccessCode } = require('../../src/shared/providers/workbuddy/oauth');

const account = { realm: 'cn', userId: 'u1', enterpriseId: '', departmentInfo: '', domain: 'www.codebuddy.cn' };
const credential = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 100,
  refreshExpiresAt: 10_000, domain: account.domain };
const response = (data, status = 200) => ({ status, json: async () => data });

test('CN keys keep existing personal and enterprise subscription identities; AI separates realms', () => {
  assert.equal(workbuddyAccountKey(account), hashKey('workbuddy', 'user:u1'));
  assert.equal(workbuddyAccountKey({ ...account, enterpriseId: 'e1' }), hashKey('workbuddy', 'enterprise:e1:u1'));
  assert.equal(workbuddyAccountKey({ ...account, realm: 'ai' }), hashKey('workbuddy', 'ai:user:u1'));
  for (const realm of ['__proto__', 'constructor', 'unknown', null]) assert.throws(() => realmConfig(realm));
});

test('metadata normalizer redacts nested secrets and enforces realm, domain and identity deduplication', () => {
  const row = { ...account, id: 'a', accountName: 'Name', enabled: true, addedAt: 'today',
    accountKey: 'spoofed', credentials: credential, accessToken: 'secret', domain: account.domain };
  const result = normalizeManagedAccounts([row, { ...row, id: 'b' },
    { ...row, id: '__proto__', userId: 'other' }, { ...row, id: 'x', domain: 'evil.example' },
    { ...row, id: 'ai', realm: 'ai', domain: 'www.workbuddy.ai' }]);
  assert.equal(result.length, 2);
  assert.equal(result[0].accountKey, hashKey('workbuddy', 'user:u1'));
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.deepEqual(Object.keys(result[0]), ['id', 'realm', 'userId', 'enterpriseId', 'departmentInfo',
    'domain', 'accountKey', 'accountName', 'accountEmail', 'enabled', 'addedAt', 'updatedAt']);
});

test('credential normalization derives official millisecond expiry, retains omitted refresh and rejects domains', () => {
  const updated = normalizeCredential({ accessToken: 'new', expiresIn: 60, refreshExpiresIn: 120 },
    { realm: 'cn', now: 1000, previous: credential });
  assert.equal(updated.refreshToken, credential.refreshToken);
  assert.equal(updated.expiresAt, 61000);
  assert.equal(updated.refreshExpiresAt, 121000);
  assert.equal(normalizeCredential({ ...credential, expiresAt: null }, { realm: 'cn' }).expiresAt, null);
  for (const domain of ['https://www.codebuddy.cn', 'www.codebuddy.cn:443', 'www.workbuddy.ai', 'evil.example', 'www.codebuddy.cn\r\nx:y']) {
    assert.throws(() => normalizeCredential({ ...credential, domain }, { realm: 'cn' }), { code: 'INVALID_DOMAIN' });
  }
  assert.throws(() => normalizeCredential({ ...credential, accessToken: { secret: true } }, { realm: 'cn' }), { code: 'INVALID_TOKEN' });
});

test('CN WorkBuddy front-door domains are allowed context, large JWTs are bounded independently of metadata', () => {
  for (const domain of ['www.workbuddy.cn', 'workbuddy.cn']) {
    assert.equal(normalizeCredential({ ...credential, domain }, { realm: 'cn' }).domain, domain);
    assert.equal(normalizeManagedAccounts([{ ...account, id: 'a', domain }])[0].domain, domain);
    assert.throws(() => normalizeCredential({ ...credential, domain }, { realm: 'ai' }), { code: 'INVALID_DOMAIN' });
  }
  const token = 'x'.repeat(4096);
  assert.equal(normalizeCredential({ ...credential, accessToken: token, refreshToken: token }, { realm: 'cn' }).accessToken, token);
  assert.throws(() => normalizeCredential({ ...credential, accessToken: 'x'.repeat(65537) }, { realm: 'cn' }), { code: 'INVALID_TOKEN' });
  assert.equal(normalizeCredential({ ...credential, expiresAt: null, refreshExpiresAt: null }, { realm: 'cn' }).refreshExpiresAt, null);
});

test('reference success envelopes accept exactly numeric 0/200 and still validate the credential', async () => {
  for (const code of [0, 200]) {
    assert.equal(isSuccessCode(code), true);
    const updated = await refreshCredential(credential, account, { now: () => 1000,
      fetch: async () => replyCode(code, { accessToken: 'new', expiresIn: 60 }) });
    assert.equal(updated.accessToken, 'new');
    await assert.rejects(refreshCredential(credential, account, { now: () => 1000,
      fetch: async () => replyCode(code, {}) }), { code: 'INVALID_TOKEN' });
  }
  for (const code of ['0', '200', null, undefined, 201, 11217]) assert.equal(isSuccessCode(code), false);
  function replyCode(code, data) { return response({ code, data }); }
});

test('refresh uses fixed origin, protected official headers and preserves omitted refresh token', async () => {
  let seen;
  const updated = await refreshCredential(credential, account, { now: () => 1000,
    fetch: async (url, init) => { seen = { url, init }; return response({ code: 0, data: { accessToken: 'new', expiresIn: 60 } }); } });
  assert.equal(seen.url, 'https://www.codebuddy.cn/v2/plugin/auth/token/refresh');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.headers.Authorization, 'Bearer old-access');
  assert.equal(seen.init.headers['X-Refresh-Token'], 'old-refresh');
  assert.equal(seen.init.headers['X-Auth-Refresh-Source'], 'plugin');
  assert.equal(seen.init.headers['X-Domain'], account.domain);
  assert.equal(seen.init.headers.Host, undefined);
  assert.equal(updated.refreshToken, 'old-refresh');
  assert.equal(updated.expiresAt, 61000);
  assert.equal(updated.refreshExpiresAt, 10000);
});

test('Chinese department metadata remains bound while refresh uses Fetch-compatible official headers', async () => {
  const enterprise = { ...account, enterpriseId: 'enterprise', departmentInfo: '研发部' };
  const updated = await refreshCredential(credential, enterprise, { now: () => 1000,
    fetch: async (url, init) => {
      const request = new Request(url, init);
      assert.equal(request.headers.get('X-Enterprise-Id'), 'enterprise');
      assert.equal(request.headers.get('X-Department-Info'), null);
      return response({ code: 0, data: { accessToken: 'rotated', expiresIn: 60, departmentFullName: '研发部' } });
    } });
  assert.equal(updated.accessToken, 'rotated');
  await assert.rejects(refreshCredential(credential, enterprise, { now: () => 1000,
    fetch: async () => response({ code: 0, data: { accessToken: 'rotated', departmentFullName: '另一部门' } })
  }), { code: 'CONTEXT_CHANGED' });
});

test('refresh rejects domain/user/enterprise/department changes without following routing hints', async () => {
  for (const fields of [{ domain: 'evil.example' }, { domain: 'copilot.tencent.com' }, { uid: 'other' },
    { userId: 'other' }, { enterpriseId: 'e2' }, { departmentFullName: 'changed' },
    { account: { uid: 'other', type: 'personal' } }]) {
    let calls = 0;
    await assert.rejects(refreshCredential(credential, account, { now: () => 1000, fetch: async () => {
      calls += 1;
      return response({ code: 0, data: { accessToken: 'new', expiresIn: 60, ...fields } });
    } }), (error) => ['INVALID_DOMAIN', 'CONTEXT_CHANGED'].includes(error.code));
    assert.equal(calls, 1);
  }
});

test('refresh distinguishes confirmed authentication rejection from transient failures and sanitizes exceptions', async () => {
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'unauthorized'],
    [429, 'sourceRateLimited'], [500, 'unavailable'], [503, 'unavailable'], [400, 'unavailable']]) {
    await assert.rejects(refreshCredential(credential, account, { now: () => 1000,
      fetch: async () => response({ code: 999, msg: 'raw-secret-state-url' }, status) }),
    (error) => error.status === expected && !String(error).includes('raw-secret'));
  }
  await assert.rejects(refreshCredential(credential, account, { now: () => 1000,
    fetch: async () => response({ error: 'invalid_grant', error_description: 'raw-secret' }, 400) }), { status: 'unauthorized' });
  await assert.rejects(refreshCredential(credential, account, { now: () => 1000,
    fetch: async () => { throw new Error('secret URL state'); } }),
  (error) => error.status === 'unavailable' && !String(error).includes('secret'));
  for (const status of [200, 400]) {
    await assert.rejects(refreshCredential(credential, account, { now: () => 1000,
      fetch: async () => response({ code: 12153, msg: 'invalid_grant: private-secret' }, status) }), { status: 'unauthorized' });
  }
  for (const [status, expected] of [[429, 'sourceRateLimited'], [503, 'unavailable']]) {
    await assert.rejects(refreshCredential(credential, account, { now: () => 1000,
      fetch: async () => response({ code: 12153 }, status) }), { status: expected });
  }
});
