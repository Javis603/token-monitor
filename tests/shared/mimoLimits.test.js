'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createMimoManagedAccount,
  fetchMimoLimits,
  normalizeMimoCookieHeader,
  parseMimoBalance,
  parseMimoPlanDetail,
  parseMimoPlanUsage,
  parseMimoProfile
} = require('../../src/shared/mimoLimits');

const COOKIE = 'unrelated=drop; userId=123; api-platform_serviceToken=secret; api-platform_ph=optional';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function managed(cookieHeader = COOKIE, overrides = {}) {
  return {
    id: 'mimo-1',
    accountKey: 'sha256:mimo-1',
    cookieHeader,
    enabled: true,
    ...overrides
  };
}

test('normalizeMimoCookieHeader keeps only the required MiMo allowlist', () => {
  assert.equal(
    normalizeMimoCookieHeader(COOKIE),
    'api-platform_ph=optional; api-platform_serviceToken=secret; userId=123'
  );
  assert.equal(normalizeMimoCookieHeader('userId=123'), '');
  assert.equal(normalizeMimoCookieHeader('api-platform_serviceToken=secret'), '');
});

test('createMimoManagedAccount rejects incomplete cookies and never preserves unrelated cookies', () => {
  const unnamed = createMimoManagedAccount(COOKIE);
  assert.equal(unnamed.ok, true);
  assert.deepEqual(createMimoManagedAccount('userId=123'), {
    ok: false,
    errorCode: 'missingRequiredCookies',
    missingCookies: ['api-platform_serviceToken']
  });
  assert.deepEqual(createMimoManagedAccount('api-platform_serviceToken=secret'), {
    ok: false,
    errorCode: 'missingRequiredCookies',
    missingCookies: ['userId']
  });
  const result = createMimoManagedAccount(COOKIE);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.account.cookieHeader, /unrelated/);
  assert.match(result.account.accountKey, /^sha256:/);
});

test('createMimoManagedAccount preserves identity when reimported', () => {
  const first = createMimoManagedAccount(COOKIE).account;
  const second = createMimoManagedAccount(
    'api-platform_serviceToken=other; userId=456', [first]
  );
  assert.equal(second.ok, true);
  const reimported = createMimoManagedAccount(COOKIE, [first]);
  assert.equal(reimported.ok, true);
  assert.equal(reimported.account.id, first.id);
});

test('MiMo parsers match the official balance and Token Plan shapes', () => {
  assert.deepEqual(parseMimoBalance({ data: {
    balance: '25.51', currency: 'usd', cashBalance: '20', giftBalance: '5.51'
  } }), { amount: 25.51, currency: 'USD', cashBalance: 20, giftBalance: 5.51 });
  assert.deepEqual(parseMimoPlanUsage({ data: { monthUsage: { items: [{
    name: 'month_total_token', used: 10, limit: 100, percent: 0.1
  }] } } }), { used: 10, limit: 100, usedPercent: 10 });
  const detail = parseMimoPlanDetail({ data: {
    planCode: 'standard', currentPeriodEnd: '2099-01-01 00:00:00', expired: false
  } }, 0);
  assert.equal(detail.label, 'standard');
  assert.equal(detail.expired, false);
  assert.match(detail.resetsAt, /^2099-01-01T00:00:00/);
  assert.deepEqual(parseMimoProfile({ data: { email: 'user@example.com' } }), {
    email: 'user@example.com'
  });
});

test('fetchMimoLimits requests fixed official endpoints concurrently with minimized cookies', async () => {
  const calls = [];
  const result = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    now: () => Date.parse('2026-07-11T00:00:00Z'),
    fetch: async (url, init) => {
      calls.push({ url, cookie: init.headers.Cookie });
      assert.equal(init.redirect, 'manual');
      if (url.endsWith('/balance')) return response({ code: 0, data: { balance: '25.51', currency: 'USD' } });
      if (url.endsWith('/userProfile')) return response({ code: 0, data: { email: 'user@example.com' } });
      if (url.endsWith('/tokenPlan/detail')) return response({ code: 0, data: { planCode: 'standard', expired: false } });
      return response({ code: 0, data: { monthUsage: { items: [{ used: 10, limit: 100, percent: 0.1 }] } } });
    }
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'ok');
  assert.equal(result[0].windows[0].usedPercent, 10);
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname).sort(), [
    '/api/v1/balance', '/api/v1/tokenPlan/detail', '/api/v1/tokenPlan/usage', '/api/v1/userProfile'
  ]);
  assert.equal(result[0].accountEmail, 'user@example.com');
  assert.equal(result[0].accountName, '');
  for (const call of calls) {
    assert.equal(call.cookie, 'api-platform_ph=optional; api-platform_serviceToken=secret; userId=123');
  }
});

test('fetchMimoLimits keeps balance when optional Token Plan endpoints fail', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async (url) => url.endsWith('/balance')
      ? response({ code: 0, data: { balance: '7.51', currency: 'CNY' } })
      : response({}, 500)
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.balance.amount, 7.51);
  assert.deepEqual(provider.windows, []);
});

test('fetchMimoLimits does not synthesize a Token Plan from zero-valued no-plan responses', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async (url) => {
      if (url.endsWith('/balance')) return response({ code: 0, data: { balance: '0', currency: 'USD' } });
      if (url.endsWith('/tokenPlan/detail')) return response({ code: 0, data: { expired: false } });
      return response({ code: 0, data: { monthUsage: { items: [{ used: 0, limit: 0, percent: 0 }] } } });
    }
  });
  assert.equal(provider.status, 'ok');
  assert.deepEqual(provider.windows, []);
  assert.equal(provider.balance.amount, 0);
  assert.equal(provider.balance.planUsed, null);
  assert.equal(provider.balance.planLimit, null);
  assert.equal(provider.balance.planPercent, null);
  assert.equal(provider.balance.planStatus, null);
});

test('fetchMimoLimits rejects a successful-looking response without a balance', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async () => response({ code: 0, data: {} })
  });
  assert.equal(provider.status, 'unavailable');
});

test('fetchMimoLimits maps an expired browser session to unauthorized', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async () => response({}, 401)
  });
  assert.equal(provider.status, 'unauthorized');
  assert.equal(provider.accountLabel, '');
});

test('fetchMimoLimits maps string auth codes to unauthorized', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async () => response({ code: '401', message: 'expired' })
  });
  assert.equal(provider.status, 'unauthorized');
});

test('fetchMimoLimits returns one row per enabled account and skips disabled accounts', async () => {
  const accounts = [managed(COOKIE), managed('userId=456; api-platform_serviceToken=second', {
    id: 'mimo-2', accountKey: 'sha256:mimo-2', enabled: false
  })];
  const result = await fetchMimoLimits({ mimoManagedAccounts: accounts }, {
    fetch: async (url) => url.endsWith('/balance')
      ? response({ code: 0, data: { balance: '1', currency: 'USD' } })
      : response({ code: 0, data: {} })
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].accountKey, 'sha256:mimo-1');
});

test('fetchMimoLimits starts managed accounts in parallel', async () => {
  const accounts = [
    managed(COOKIE),
    managed('userId=456; api-platform_serviceToken=second', {
      id: 'mimo-2', accountKey: 'sha256:mimo-2'
    })
  ];
  let balanceStarts = 0;
  let releaseBalances;
  const balanceGate = new Promise((resolve) => { releaseBalances = resolve; });
  const pending = fetchMimoLimits({ mimoManagedAccounts: accounts }, {
    fetch: async (url) => {
      if (url.endsWith('/balance')) {
        balanceStarts += 1;
        await balanceGate;
        return response({ code: 0, data: { balance: '1', currency: 'USD' } });
      }
      return response({ code: 0, data: {} });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(balanceStarts, 2);
  releaseBalances();
  const result = await pending;
  assert.equal(result.length, 2);
});

test('fetchMimoLimits times out one account without blocking the others', async () => {
  const accounts = [
    managed(COOKIE),
    managed('userId=456; api-platform_serviceToken=second', {
      id: 'mimo-2', accountKey: 'sha256:mimo-2'
    })
  ];
  let timerCount = 0;
  const result = await fetchMimoLimits({ mimoManagedAccounts: accounts }, {
    accountTimeoutMs: 10,
    setTimeout: (callback) => {
      timerCount += 1;
      if (timerCount === 1) queueMicrotask(callback);
      return timerCount;
    },
    clearTimeout: () => {},
    fetch: async (_url, init) => {
      if (init.headers.Cookie.includes('userId=123')) return new Promise(() => {});
      return response({ code: 0, data: { balance: '2', currency: 'USD' } });
    }
  });
  assert.equal(result.length, 2);
  assert.equal(result.find((provider) => provider.accountKey === 'sha256:mimo-1').status, 'unavailable');
  assert.equal(result.find((provider) => provider.accountKey === 'sha256:mimo-2').status, 'ok');
});
