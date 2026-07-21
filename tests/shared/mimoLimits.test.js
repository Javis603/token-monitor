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
const { createLimitsCollector } = require('../../src/shared/limitCollector');

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
  assert.equal(detail.active, true);
  assert.match(detail.resetsAt, /^2099-01-01T00:00:00/);
  assert.deepEqual(parseMimoProfile({ data: { email: 'user@example.com' } }), {
    email: 'user@example.com'
  });
});

test('MiMo usage parser selects only the exact month_total_token item', () => {
  assert.deepEqual(parseMimoPlanUsage({ data: { monthUsage: { items: [
    { name: 'model_a', used: 10, limit: 100 },
    { name: 'MONTH_TOTAL_TOKEN', used: 30, limit: 1000 },
    { name: 'model_b', used: 20, limit: 200 }
  ] } } }), { used: 30, limit: 1000, usedPercent: 3 });
});

test('MiMo plan detail requires explicit activation evidence', () => {
  const now = Date.parse('2026-07-12T00:00:00Z');
  const defaultPlan = parseMimoPlanDetail({ data: {
    planCode: 'default', currentPeriodEnd: '2099-01-01 00:00:00'
  } }, now);
  assert.equal(defaultPlan.active, false);
  assert.equal(defaultPlan.expired, false);

  const labelOnly = parseMimoPlanDetail({ data: { planCode: 'standard' } }, now);
  assert.equal(labelOnly.active, false);

  assert.equal(parseMimoPlanDetail({ data: { status: 'active', planCode: 'standard' } }, now).active, true);
  assert.equal(parseMimoPlanDetail({ data: {
    planCode: 'standard', currentPeriodEnd: '2099-01-01 00:00:00'
  } }, now).active, true);
});

test('MiMo negative statuses never become active', () => {
  for (const status of ['not_active', 'not_available', 'not_valid', 'unknown']) {
    const detail = parseMimoPlanDetail({ data: {
      status,
      planCode: 'standard',
      currentPeriodEnd: '2099-01-01 00:00:00'
    } });
    assert.equal(detail.active, false);
    assert.equal(detail.expired, false);
  }
});

test('MiMo boolean inactive flag blocks future-period activation', () => {
  const detail = parseMimoPlanDetail({ data: {
    planCode: 'standard',
    active: false,
    currentPeriodEnd: '2099-01-01 00:00:00'
  } });
  assert.equal(detail.active, false);
  assert.equal(detail.expired, false);
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
      if (url.endsWith('/tokenPlan/detail')) return response({ code: 0, data: { planCode: 'standard', currentPeriodEnd: '2099-01-01 00:00:00', expired: false } });
      return response({ code: 0, data: { monthUsage: { items: [{ name: 'month_total_token', used: 10, limit: 100, percent: 0.1 }] } } });
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

test('fetchMimoLimits does not activate a default plan with positive quota', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async (url) => {
      if (url.endsWith('/balance')) return response({ code: 0, data: { balance: '9.73', currency: 'CNY' } });
      if (url.endsWith('/tokenPlan/detail')) return response({ code: 0, data: {
        planCode: 'default', status: 'active', currentPeriodEnd: '2099-01-01 00:00:00'
      } });
      if (url.endsWith('/tokenPlan/usage')) return response({ code: 0, data: {
        monthUsage: { items: [{ name: 'month_total_token', used: 1000, limit: 1000, percent: 1 }] }
      } });
      return response({ code: 0, data: {} });
    }
  });
  assert.equal(provider.windows.length, 0);
  assert.equal(provider.balance.planUsed, null);
  assert.equal(provider.balance.planLimit, null);
  assert.equal(provider.balance.planPercent, null);
  assert.equal(provider.balance.planStatus, null);
  assert.equal(provider.accountLabel, '');
});

test('MiMo no-plan code takes priority over active status', () => {
  const detail = parseMimoPlanDetail({ data: {
    planCode: 'default',
    status: 'active',
    currentPeriodEnd: '2099-01-01 00:00:00'
  } });
  assert.equal(detail.active, false);
  assert.equal(detail.expired, false);
});

test('fetchMimoLimits does not infer a Token Plan from quota without detail evidence', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async (url) => {
      if (url.endsWith('/balance')) return response({ code: 0, data: { balance: '9.73', currency: 'CNY' } });
      if (url.endsWith('/tokenPlan/detail')) return response({ code: 0, data: {} });
      if (url.endsWith('/tokenPlan/usage')) return response({ code: 0, data: {
        monthUsage: { items: [{ name: 'month_total_token', used: 0, limit: 1000, percent: 0 }] }
      } });
      return response({ code: 0, data: {} });
    }
  });
  assert.equal(provider.windows.length, 0);
});

test('fetchMimoLimits activates an explicitly active Token Plan', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async (url) => {
      if (url.endsWith('/balance')) return response({ code: 0, data: { balance: '9.73', currency: 'CNY' } });
      if (url.endsWith('/tokenPlan/detail')) return response({ code: 0, data: {
        status: 'active', planCode: 'standard'
      } });
      if (url.endsWith('/tokenPlan/usage')) return response({ code: 0, data: {
        monthUsage: { items: [{ name: 'month_total_token', used: 100, limit: 1000, percent: 0.1 }] }
      } });
      return response({ code: 0, data: {} });
    }
  });
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].remainingPercent, 90);
  assert.equal(provider.balance.planUsed, 100);
  assert.equal(provider.balance.planLimit, 1000);
});

test('fetchMimoLimits keeps an explicitly active exhausted plan at zero remaining', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async (url) => {
      if (url.endsWith('/balance')) return response({ code: 0, data: { balance: '9.73', currency: 'CNY' } });
      if (url.endsWith('/tokenPlan/detail')) return response({ code: 0, data: {
        status: 'subscribed', planCode: 'standard'
      } });
      if (url.endsWith('/tokenPlan/usage')) return response({ code: 0, data: {
        monthUsage: { items: [{ name: 'month_total_token', used: 1000, limit: 1000, percent: 1 }] }
      } });
      return response({ code: 0, data: {} });
    }
  });
  assert.equal(provider.windows[0].remaining, 0);
  assert.equal(provider.windows[0].remainingPercent, 0);
});

test('fetchMimoLimits keeps expired Token Plan behavior', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async (url) => {
      if (url.endsWith('/balance')) return response({ code: 0, data: { balance: '9.73', currency: 'CNY' } });
      if (url.endsWith('/tokenPlan/detail')) return response({ code: 0, data: {
        planCode: 'standard', currentPeriodEnd: '2020-01-01 00:00:00'
      } });
      if (url.endsWith('/tokenPlan/usage')) return response({ code: 0, data: {
        monthUsage: { items: [{ name: 'month_total_token', used: 1000, limit: 1000, percent: 1 }] }
      } });
      return response({ code: 0, data: {} });
    }
  });
  assert.equal(provider.windows.length, 0);
  assert.equal(provider.balance.planStatus, 'expired');
});

test('MiMo no-plan code never becomes expired', () => {
  const detail = parseMimoPlanDetail({ data: {
    planCode: 'default',
    status: 'expired',
    currentPeriodEnd: '2020-01-01 00:00:00'
  } });
  assert.equal(detail.active, false);
  assert.equal(detail.expired, false);
});

test('MiMo no-plan status fields override a historical plan label', () => {
  for (const field of ['status', 'state', 'subscriptionStatus']) {
    const detail = parseMimoPlanDetail({ data: {
      planCode: 'standard',
      [field]: 'default',
      currentPeriodEnd: '2020-01-01 00:00:00'
    } });
    assert.equal(detail.active, false);
    assert.equal(detail.expired, false);
  }
});

test('MiMo usage parser returns empty quota when total item is absent', () => {
  assert.deepEqual(parseMimoPlanUsage({ data: { monthUsage: {
    percent: 0.5,
    items: [
      { name: 'model_a', used: 10, limit: 100 },
      { name: 'model_b', used: 20, limit: 200 }
    ]
  } } }), { used: null, limit: null, usedPercent: null });
});

test('MiMo usage parser preserves direct month quota compatibility', () => {
  assert.deepEqual(parseMimoPlanUsage({ data: { monthUsage: {
    used: 20,
    limit: 200,
    percent: 0.1,
    items: []
  } } }), { used: 20, limit: 200, usedPercent: 10 });
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

test('fetchMimoLimits refresh scope probes only the requested account', async () => {
  const accounts = [
    managed(COOKIE),
    managed('userId=456; api-platform_serviceToken=second', {
      id: 'mimo-2', accountKey: 'sha256:mimo-2'
    })
  ];
  const cookies = [];
  const result = await fetchMimoLimits({
    mimoManagedAccounts: accounts,
    limitRefreshScope: { provider: 'mimo', accountKey: 'sha256:mimo-2' }
  }, {
    fetch: async (url, init) => {
      cookies.push(init.headers.Cookie);
      return url.endsWith('/balance')
        ? response({ code: 0, data: { balance: '1', currency: 'USD' } })
        : response({ code: 0, data: {} });
    }
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].accountKey, 'sha256:mimo-2');
  assert.ok(cookies.length > 0);
  assert.ok(cookies.every((cookie) => cookie.includes('userId=456')));
});

test('fetchMimoLimits fails closed for a provider-only scope with multiple accounts', async () => {
  const accounts = [
    managed(COOKIE),
    managed('userId=456; api-platform_serviceToken=second', {
      id: 'mimo-2', accountKey: 'sha256:mimo-2'
    })
  ];
  let fetchCalls = 0;

  await assert.rejects(fetchMimoLimits({
    mimoManagedAccounts: accounts,
    limitRefreshScope: { provider: 'mimo' }
  }, {
    fetch: async () => {
      fetchCalls += 1;
      return response({ code: 0, data: {} });
    }
  }), /requires an account identifier/);

  assert.equal(fetchCalls, 0);
});

test('LimitsRuntime compatibility distinguishes provider-wide and account-scoped MiMo refreshes', async () => {
  const accounts = [
    managed(COOKIE),
    managed('userId=456; api-platform_serviceToken=second', {
      id: 'mimo-2', accountKey: 'sha256:mimo-2'
    })
  ];
  let fetchCalls = 0;
  const cookies = [];
  const oldAt = '2026-07-20T00:00:00.000Z';
  const collector = createLimitsCollector({
    limitsEnabled: true,
    limitProviders: 'mimo',
    mimoManagedAccounts: accounts,
    previousLimits: {
      updatedAt: oldAt,
      refreshMs: 300000,
      providers: accounts.map((account) => ({
        provider: 'mimo',
        accountKey: account.accountKey,
        status: 'ok',
        updatedAt: oldAt,
        windows: []
      }))
    }
  }, {
    fetch: async (url, init) => {
      fetchCalls += 1;
      cookies.push(init.headers.Cookie);
      return url.endsWith('/balance')
        ? response({ code: 0, data: { balance: '1', currency: 'USD' } })
        : response({ code: 0, data: {} });
    }
  });

  const full = await collector.refreshScope({ provider: 'mimo' });
  assert.deepEqual(
    full.providers.map((provider) => provider.accountKey),
    ['sha256:mimo-1', 'sha256:mimo-2']
  );
  assert.ok(fetchCalls > 0);
  assert.ok(cookies.some((cookie) => cookie.includes('userId=123')));
  assert.ok(cookies.some((cookie) => cookie.includes('userId=456')));
  const firstAccountUpdatedAt = full.providers[0].updatedAt;
  cookies.length = 0;

  const summary = await collector.refreshScope({
    provider: 'mimo',
    accountKey: 'sha256:mimo-2'
  });
  assert.deepEqual(
    summary.providers.map((provider) => provider.accountKey),
    ['sha256:mimo-1', 'sha256:mimo-2']
  );
  assert.equal(summary.providers[0].updatedAt, firstAccountUpdatedAt);
  assert.ok(cookies.length > 0);
  assert.ok(cookies.every((cookie) => cookie.includes('userId=456')));
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
