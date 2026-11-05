'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  fetchQwenworkLimits,
  parseQwenworkAccount,
  parseQwenworkQuota,
  qwenworkBaseUrl,
  qwenworkToken
} = require('../../src/shared/providers/qwenwork/limits');

const options = { qwenworkToken: 'fixture-token' };
const now = () => Date.parse('2026-11-05T12:00:00Z');

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) };
}

function quota(overrides = {}) {
  return {
    user_id: 'user-a',
    is_quota_exceeded: false,
    user_quota: { total: 46000, used: 45508.66, remaining: 491.34, percentage: 0.989318695652174, unit: 'credits' },
    add_on_quota: null,
    org_resource_package: null,
    ...overrides
  };
}

function account(overrides = {}) {
  return {
    code: 'ok',
    data: {
      user: { id: 'user-a', name: 'Test User', email: 'test@example.com', organization: { name: 'Test Org' } },
      plan: { name: '企业基础版', next_refresh_date: '2026-11-08T16:00:00Z' },
      quota: { total: 46000, used: 45508.66, remaining: 491.34 },
      ...overrides
    }
  };
}

function deps(handler) {
  const calls = [];
  return {
    calls,
    env: {},
    now,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    }
  };
}

test('QwenWork token precedence is env, then the magpie sign-in, and expired sign-ins are skipped', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-token-'));
  fs.mkdirSync(path.join(home, 'magpie'), { recursive: true });
  fs.writeFileSync(path.join(home, 'magpie', 'plugin-auth.json'), JSON.stringify({
    qwenwork: { access: 'magpie-token', expires: Date.now() + 3_600_000 }
  }));
  const env = { MAGPIE_HOME: path.join(home, 'magpie') };
  assert.equal(qwenworkToken(env), 'magpie-token');
  env.QWENWORK_TOKEN = ' env-token ';
  assert.equal(qwenworkToken(env), 'env-token');

  fs.writeFileSync(path.join(home, 'magpie', 'plugin-auth.json'), JSON.stringify({
    qwenwork: { access: 'stale', expires: 1 }
  }));
  assert.equal(qwenworkToken({ MAGPIE_HOME: path.join(home, 'magpie') }), '');
});

test('QwenWork base URL accepts only its HTTPS gateways', () => {
  assert.equal(qwenworkBaseUrl({}), 'https://gateway.qwenwork.cn');
  assert.equal(qwenworkBaseUrl({ QWENWORK_BASE_URL: 'https://gateway.qwenwork.ai' }), 'https://gateway.qwenwork.ai');
  for (const value of ['http://gateway.qwenwork.cn', 'https://evil.example', 'https://gateway.qwenwork.cn/path',
    'https://user:password@gateway.qwenwork.cn']) {
    assert.throws(() => qwenworkBaseUrl({ QWENWORK_BASE_URL: value }), /QWENWORK_BASE_URL/);
  }
});

test('Quota parsing normalizes the gateway fraction and keeps additional pools separate', () => {
  const parsed = parseQwenworkQuota(quota({
    add_on_quota: { total: 1000, used: 200, remaining: 800, percentage: 0.2, unit: 'credits' },
    shared_quota: { used: 10, cap: 40, remaining: 30, unit: 'credits' }
  }));
  assert.equal(parsed.windows.length, 3);
  assert.equal(parsed.windows[0].label, 'Credits');
  assert.ok(Math.abs(parsed.windows[0].usedPercent - 98.9318695652174) < 1e-9);
  assert.equal(parsed.windows[1].label, 'Add-on credits');
  assert.equal(parsed.windows[1].additional, true);
  assert.equal(parsed.windows[2].label, 'Team credits');
  assert.equal(parsed.exceeded, false);

  for (const body of [null, {}, { user_quota: { total: 0, used: 0 } },
    { user_quota: { total: 10, used: 11 } }, { user_quota: { total: 10, used: -1 } }]) {
    assert.throws(() => parseQwenworkQuota(body), /QwenWork/);
  }
});

test('Account parsing carries identity, plan and reset time', () => {
  const parsed = parseQwenworkAccount(account());
  assert.deepEqual(parsed.user, { id: 'user-a', name: 'Test User', email: 'test@example.com', organization: 'Test Org' });
  assert.deepEqual(parsed.plan, { name: '企业基础版', resetsAt: '2026-11-08T16:00:00.000Z' });
});

test('The provider reads account and quota, then attaches the plan reset to the credit window', async () => {
  const d = deps((url) => url.includes('account-context') ? response(account()) : response(quota()));
  const result = await fetchQwenworkLimits(options, d);
  assert.equal(result.status, 'ok');
  assert.equal(result.planLabel, '企业基础版');
  assert.equal(result.accountName, 'Test User');
  assert.equal(result.accountEmail, 'test@example.com');
  assert.match(result.accountKey, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].resetsAt, '2026-11-08T16:00:00.000Z');
  assert.ok(Math.abs(result.windows[0].usedPercent - 98.9318695652174) < 1e-9);
  assert.deepEqual(d.calls.map(({ url }) => new URL(url).pathname), [
    '/api/v1/adapter/user/account-context',
    '/api/v2/quota/usage'
  ]);
  for (const { init } of d.calls) {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    assert.equal(init.headers.Host, undefined);
    assert.ok(init.signal);
  }
});

test('The account allowance survives a quota endpoint failure, and auth failures stay explicit', async () => {
  const fallback = await fetchQwenworkLimits(options, deps((url) => url.includes('account-context')
    ? response(account({ quota: { total: 900, used: 100, remaining: 800 } }))
    : response({ error: 'unavailable' }, 503)));
  assert.equal(fallback.status, 'ok');
  assert.equal(fallback.windows[0].limit, 900);
  assert.equal(fallback.windows[0].used, 100);

  const denied = await fetchQwenworkLimits(options, deps(() => response({ error: 'unauthorized' }, 401)));
  assert.equal(denied.status, 'unauthorized');

  const limited = await fetchQwenworkLimits(options, deps(() => response({ error: 'limited' }, 429)));
  assert.equal(limited.status, 'sourceRateLimited');
});

test('A missing token returns notConfigured without touching the network', async () => {
  const d = deps(() => { throw new Error('must not fetch'); });
  d.env.MAGPIE_HOME = path.join(os.tmpdir(), 'no-such-magpie-home');
  const result = await fetchQwenworkLimits({}, d);
  assert.equal(result.status, 'notConfigured');
  assert.deepEqual(result.windows, []);
  assert.equal(d.calls.length, 0);
});

test('A stored QwenWork session is used before the magpie sign-in', async () => {
  const d = deps((url) => url.includes('account-context') ? response(account()) : response(quota()));
  const session = {
    access: 'session-access',
    refresh: 'session-refresh',
    expiresAt: Date.now() + 3_600_000,
    deviceToken: 'session-access',
    deviceRefresh: 'session-refresh'
  };
  const result = await fetchQwenworkLimits({ qwenworkSession: session }, d);
  assert.equal(result.status, 'ok');
  for (const { init } of d.calls) assert.equal(init.headers.Authorization, 'Bearer session-access');
});

test('An expired stored session refreshes and reports the rotated session once', async () => {
  const calls = [];
  const renewed = [];
  const d = {
    env: {},
    now,
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/v1/deviceToken/refresh')) {
        return response({ token: 'renewed-access', refresh_token: 'renewed-refresh', expires_in: 3600 });
      }
      if (url.includes('account-context')) return response(account());
      return response(quota());
    },
    onQwenworkSessionRenewed: async (value) => renewed.push(value)
  };
  const result = await fetchQwenworkLimits({
    qwenworkSession: { access: 'old-access', refresh: 'old-refresh', expiresAt: 1 }
  }, d);
  assert.equal(result.status, 'ok');
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/deviceToken/refresh');
  assert.equal(renewed.length, 1);
  assert.equal(renewed[0].previousSession.access, 'old-access');
  assert.equal(renewed[0].session.access, 'renewed-access');
  for (const { url, init } of calls.slice(1)) {
    assert.equal(init.headers.Authorization, 'Bearer renewed-access');
    assert.ok(!url.endsWith('/deviceToken/refresh'));
  }
});

test('A rejected refresh keeps the provider unauthorized instead of retrying the expired access token', async () => {
  const d = deps((url) => url.endsWith('/api/v1/deviceToken/refresh')
    ? response({ error: 'expired' }, 401)
    : response(account()));
  d.env.MAGPIE_HOME = path.join(os.tmpdir(), 'no-such-magpie-home');
  const result = await fetchQwenworkLimits({
    qwenworkSession: { access: 'old-access', refresh: 'old-refresh', expiresAt: 1 }
  }, d);
  assert.equal(result.status, 'unauthorized');
  assert.equal(d.calls.length, 1);
  assert.equal(new URL(d.calls[0].url).pathname, '/api/v1/deviceToken/refresh');
});
