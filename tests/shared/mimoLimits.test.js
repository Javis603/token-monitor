'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createMimoManagedAccount,
  fetchMimoLimits: fetchMimoLimitsRaw,
  normalizeMimoCookieHeader,
  parseMimoBalance,
  parseMimoPlanDetail,
  parseMimoPlanUsage,
  parseMimoProfile,
  withDetectedMimoAccount
} = require('../../src/shared/providers/mimo/limits');
const { createLimitsCollector } = require('../../src/shared/limits/collector');
const { hashKey } = require('../../src/shared/hashKey');

const COOKIE = 'unrelated=drop; userId=123; api-platform_serviceToken=secret; api-platform_ph=optional';
const ACCOUNT_COOKIE = 'passToken=account-pass-token; userId=999';

// Every case below is about the console lane, so the membership lane is declared
// absent for the whole file: without that these would reach for this machine's
// real MiMo Desktop partition and pick up a row that has nothing to do with what
// they assert. The membership lane has its own suite.
function fetchMimoLimits(options, deps = {}) {
  return fetchMimoLimitsRaw(options, {
    readMimoDesktopAccount: () => ({ ok: false, reason: 'absent' }),
    ...deps
  });
}

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

// Every funded MiMo account ships a `credits` balance window. The Token Plan
// assertions below are about metered quota only, so they look past it.
function planWindows(provider) {
  return (provider.windows || []).filter((window) => window.metric !== 'credits');
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

test('MiMo usage parser reads an over-consumed plan as fully used', () => {
  // MiMo reports `percent` as a 0-1 ratio, and a spent plan overshoots it: the
  // request that exhausts the quota pushes used past limit, so percent lands at
  // 1.005. Reading that as "1% used" rendered an empty plan as 99% left (#292).
  assert.deepEqual(parseMimoPlanUsage({ data: { monthUsage: { items: [{
    name: 'month_total_token', used: 10_050_000, limit: 10_000_000, percent: 1.005
  }] } } }), { used: 10_050_000, limit: 10_000_000, usedPercent: 100 });
  // Same overshoot with no `used` to fall back on.
  assert.deepEqual(parseMimoPlanUsage({ data: { monthUsage: { items: [{
    name: 'month_total_token', limit: 10_000_000, percent: 1.02
  }] } } }), { used: null, limit: 10_000_000, usedPercent: 100 });
});

test('MiMo usage parser prefers used/limit over the reported ratio', () => {
  assert.deepEqual(parseMimoPlanUsage({ data: { monthUsage: { items: [{
    name: 'month_total_token', used: 25, limit: 100, percent: 0.9
  }] } } }), { used: 25, limit: 100, usedPercent: 25 });
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
  assert.equal(planWindows(result[0])[0].usedPercent, 10);
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname).sort(), [
    '/api/v1/balance', '/api/v1/tokenPlan/detail', '/api/v1/tokenPlan/usage', '/api/v1/userProfile'
  ]);
  assert.equal(result[0].accountEmail, 'user@example.com');
  assert.equal(result[0].accountName, '');
  for (const call of calls) {
    assert.equal(call.cookie, 'api-platform_ph=optional; api-platform_serviceToken=secret; userId=123');
  }
});

test('fetchMimoLimits reports an exhausted Token Plan as 0% left', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async (url) => {
      if (url.endsWith('/balance')) return response({ code: 0, data: { balance: '0.34', currency: 'USD' } });
      if (url.endsWith('/tokenPlan/detail')) return response({ code: 0, data: {
        planCode: 'MiMo Lite', status: 'active', currentPeriodEnd: '2099-01-01 00:00:00'
      } });
      if (url.endsWith('/tokenPlan/usage')) return response({ code: 0, data: {
        monthUsage: { items: [{
          name: 'month_total_token', used: 10_050_000, limit: 10_000_000, percent: 1.005
        }] }
      } });
      return response({ code: 0, data: {} });
    }
  });
  const [plan] = planWindows(provider);
  assert.equal(plan.usedPercent, 100);
  assert.equal(plan.remainingPercent, 0);
  assert.equal(plan.remaining, 0);
  assert.equal(provider.balance.planPercent, 100);
});

test('fetchMimoLimits keeps balance when optional Token Plan endpoints fail', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async (url) => url.endsWith('/balance')
      ? response({ code: 0, data: { balance: '7.51', currency: 'CNY' } })
      : response({}, 500)
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.balance.amount, 7.51);
  assert.deepEqual(planWindows(provider), []);
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
  assert.deepEqual(planWindows(provider), []);
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
  assert.equal(planWindows(provider).length, 0);
  assert.equal(provider.balance.planUsed, null);
  assert.equal(provider.balance.planLimit, null);
  assert.equal(provider.balance.planPercent, null);
  assert.equal(provider.balance.planStatus, null);
  // The row names its lane rather than claiming a plan — the assertions above are
  // what says no plan was accepted, and the label must not be the rejected
  // `default` plan code either.
  assert.equal(provider.accountLabel, 'Open Platform');
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
  assert.equal(planWindows(provider).length, 0);
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
  assert.equal(planWindows(provider).length, 1);
  assert.equal(planWindows(provider)[0].remainingPercent, 90);
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
  assert.equal(planWindows(provider)[0].remaining, 0);
  assert.equal(planWindows(provider)[0].remainingPercent, 0);
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
  assert.equal(planWindows(provider).length, 0);
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
    // This drives the real collector, which resolves the real fetcher, so the
    // membership lane is declared absent here too.
    readMimoDesktopAccount: () => ({ ok: false, reason: 'absent' }),
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

test('MiMo exposes the balance as a credits window alongside the token plan', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    now: () => Date.parse('2026-07-26T00:00:00Z'),
    fetch: async (url) => {
      if (url.endsWith('/balance')) return response({ code: 0, data: { balance: '12.50', currency: 'CNY' } });
      if (url.endsWith('/userProfile')) return response({ code: 0, data: { email: 'user@example.com' } });
      if (url.endsWith('/tokenPlan/detail')) return response({ code: 0, data: { planCode: 'standard', currentPeriodEnd: '2099-01-01 00:00:00', expired: false } });
      return response({ code: 0, data: { monthUsage: { items: [{ name: 'month_total_token', used: 22, limit: 100, percent: 0.22 }] } } });
    }
  });

  const plan = provider.windows.find((window) => window.label === 'Token Plan');
  const balance = provider.windows.find((window) => window.metric === 'credits');

  // The token plan is a real metered quota and keeps its percentage.
  assert.ok(plan);
  assert.equal(plan.usedPercent, 22);

  // The balance is money and carries no wire percentage.
  assert.ok(balance);
  assert.equal(balance.kind, 'billing');
  assert.equal(balance.label, 'Balance');
  assert.equal(balance.remaining, provider.balance.amount);
  assert.equal(balance.currency, provider.balance.currency);
  assert.equal(balance.usedPercent, null);
  assert.equal(balance.remainingPercent, null);
});

test('MiMo without a token plan still exposes the balance window', async () => {
  const [provider] = await fetchMimoLimits({ mimoManagedAccounts: [managed()] }, {
    fetch: async (url) => url.endsWith('/balance')
      ? response({ code: 0, data: { balance: '7.51', currency: 'CNY' } })
      : response({}, 500)
  });

  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].metric, 'credits');
  assert.equal(provider.windows[0].remaining, 7.51);
});

// ---- the two sources, together ----------------------------------------------
// The lane resolves its session over one seam and reads its endpoints over the
// other. A fixture that describes the whole lane therefore has to answer both —
// otherwise the half it does not answer walks the real chain over the network and
// the test passes on whatever happens to come back.
function laneSeams(handler) {
  return {
    mimoRequest: async (url, init = {}) => handler(url, init),
    fetch: async (url, init = {}) => handler(url, init)
  };
}


// These use the raw fetcher: the rest of the file declares the membership lane
// absent, and what is under test here is precisely that it is not.

test('the membership lane is merged beside the console accounts', async () => {
  let membershipReads = 0;
  const rows = await fetchMimoLimitsRaw({ mimoManagedAccounts: [managed()] }, {
    ...laneSeams(async (url) => {
      const href = String(url);
      if (href.includes('/user/xiaomi/me')) {
        return { status: 200, headers: { get: () => null, getSetCookie: () => [] }, json: async () => ({ code: 0, data: { userId: '123', region: 'CN' } }), text: async () => JSON.stringify({ code: 0, data: { userId: '123', region: 'CN' } }) };
      }
      if (href.includes('/user/xiaomi/subscription/self')) {
        return response({ code: 0, data: { current: { planCode: 'mimo-cn-pro', percent: 60, nextResetTime: '2026-09-15T00:00:00' } } });
      }
      return url.endsWith('/balance')
        ? response({ code: 0, data: { balance: '9.95', currency: 'CNY' } })
        : response({ code: 0, data: null });
    }),
    readMimoDesktopAccount: () => { membershipReads += 1; return { ok: true, cookieHeader: COOKIE, userId: '123' }; }
  });

  assert.equal(membershipReads, 1);
  // One console row keyed by the console lane's identity, one membership row
  // keyed by its own — two products of one account are two rows.
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.accountKey), [
    'sha256:mimo-1',
    hashKey('mimo', '123', 'membership')
  ]);
});

test('the not-configured row is only for a provider with neither source', async () => {
  const neither = await fetchMimoLimitsRaw({}, {
    fetch: async () => response({ code: 0, data: null }),
    readMimoDesktopAccount: () => ({ ok: false, reason: 'absent' })
  });
  // The early return stays what it always was — one provider-level row, not an
  // array — because that is the shape its callers already handle.
  assert.equal(neither.status, 'notConfigured');
  assert.deepEqual(neither.windows, []);

  // No console account configured, but a Desktop session: both lanes mint from
  // the same account cookie, so both come up. What matters is that no
  // provider-level row is among them — one would be read as the whole provider's
  // and would clear the identities these rows just established.
  const membershipOnly = await fetchMimoLimitsRaw({}, {
    ...laneSeams(async (url) => {
      const href = String(url);
      if (href.includes('/user/xiaomi/me')) {
        return {
          status: 200,
          headers: { get: () => null, getSetCookie: () => [] },
          json: async () => ({ code: 0, data: { userId: '123', region: 'CN' } }),
          text: async () => JSON.stringify({ code: 0, data: { userId: '123', region: 'CN' } })
        };
      }
      if (href.includes('/user/xiaomi/subscription/self')) {
        return response({ code: 0, data: { current: { planCode: 'mimo-cn-pro', percent: 60, nextResetTime: '2026-09-15T00:00:00' } } });
      }
      return response({ code: 0, data: { balance: '9.95', currency: 'CNY' } });
    }),
    readMimoDesktopAccount: () => ({ ok: true, cookieHeader: COOKIE, userId: '123' })
  });
  assert.equal(membershipOnly.some((row) => row.accountKey === ''), false);
  assert.deepEqual(membershipOnly.map((row) => row.accountKey).sort(), [
    hashKey('mimo:123'),
    hashKey('mimo', '123', 'membership')
  ].sort());
});

test('a refresh scoped to one console account does not spend the membership lane', async () => {
  let membershipReads = 0;
  await fetchMimoLimitsRaw({
    mimoManagedAccounts: [managed()],
    limitRefreshScope: { provider: 'mimo', accountKey: 'sha256:mimo-1' }
  }, {
    fetch: async () => response({ code: 0, data: { balance: '1', currency: 'USD' } }),
    readMimoDesktopAccount: () => { membershipReads += 1; return { ok: false, reason: 'absent' }; }
  });
  assert.equal(membershipReads, 0);
});

// ---- the minting source ------------------------------------------------------

test('minting never shadows a configured account', async () => {
  const consoleCalls = [];
  const rows = await fetchMimoLimitsRaw({ mimoManagedAccounts: [managed()] }, {
    ...laneSeams(async (url, init = {}) => {
      if (String(url).endsWith('/balance')) consoleCalls.push((init.headers || {}).Cookie || '');
      return url.endsWith('/balance')
        ? response({ code: 0, data: { balance: '1', currency: 'USD' } })
        : response({ code: 0, data: {} });
    }),
    // The store names a different account. It is the membership lane's business
    // and must not become a second console account beside the configured one.
    readMimoDesktopAccount: () => ({ ok: true, cookieHeader: ACCOUNT_COOKIE, userId: '999' })
  });
  assert.equal(consoleCalls.length, 1);
  assert.equal(consoleCalls[0].includes('secret'), true, 'the configured cookie is the one that goes out');
  assert.equal(rows.some((row) => row.accountKey === hashKey('mimo:999')), false);
  assert.equal(rows.some((row) => row.accountKey === 'sha256:mimo-1'), true);
});

test('a minted session is the account a pasted cookie for it would be', async () => {
  // Both routes end on the server-issued user id, so one account reached either
  // way is one row rather than two. The pasted side is built the way the settings
  // path builds it, which is what computes the key from the cookie.
  const pastedAccount = createMimoManagedAccount(COOKIE).account;
  assert.equal(pastedAccount.accountKey, hashKey('mimo:123'));

  const minted = await fetchMimoLimitsRaw({}, {
    ...laneSeams(async (url) => {
      const href = String(url);
      if (href.includes('/user/xiaomi/me')) {
        return {
          status: 200,
          headers: { get: () => null, getSetCookie: () => [] },
          json: async () => ({ code: 0, data: { userId: '123', region: 'CN' } }),
          text: async () => JSON.stringify({ code: 0, data: { userId: '123', region: 'CN' } })
        };
      }
      return response({ code: 0, data: { current: null } });
    }),
    readMimoDesktopAccount: () => ({ ok: true, cookieHeader: COOKIE, userId: '123' })
  });
  assert.equal(minted.some((row) => row.accountKey === pastedAccount.accountKey), true);
});

test('a refused mint is a credential problem and still names the account', async () => {
  const rows = await fetchMimoLimitsRaw({}, {
    // The refusal signature: the console chain lands on the account host's login
    // page and never comes back.
    ...laneSeams(async (url) => {
      const href = String(url);
      if (href.includes('/user/xiaomi/me')) {
        return {
          status: 200,
          headers: { get: () => null, getSetCookie: () => [] },
          json: async () => ({ code: 0, data: { userId: '123', region: 'CN' } }),
          text: async () => JSON.stringify({ code: 0, data: { userId: '123', region: 'CN' } })
        };
      }
      if (href.startsWith('https://account.xiaomi.com')) {
        return { status: 200, headers: { get: () => null, getSetCookie: () => [] }, json: async () => ({}), text: async () => '<html>login</html>' };
      }
      const refusal = JSON.stringify({ code: 401, loginUrl: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform' });
      return { status: 401, headers: { get: () => null, getSetCookie: () => [] }, json: async () => JSON.parse(refusal), text: async () => refusal };
    }),
    readMimoDesktopAccount: () => ({ ok: true, cookieHeader: COOKIE, userId: '123' })
  });
  // The console row is attributable — the partition already knows which account
  // it belongs to — so the refusal is reported against that account rather than
  // as a bare provider-level row the runtime would spread across every account.
  const consoleRow = rows.find((row) => row.accountKey === hashKey('mimo:123'));
  assert.equal(consoleRow.status, 'unauthorized');
  assert.equal(consoleRow.source, 'oauth');
  assert.equal(consoleRow.sourceDetail, 'app');
  assert.ok(rows.every((row) => row.accountKey));
});

test('a membership row is never replaced by the not-configured row', async () => {
  // No console accounts and nothing to mint, but the membership lane has a
  // credential the user configured. A provider-level row here would be read as
  // the whole provider's and would clear the identity the membership just
  // established, so the early return may only fire when *neither* source has
  // anything.
  const rows = await fetchMimoLimitsRaw({ mimoMembershipCookie: 'serviceToken=configured' }, {
    ...laneSeams(async (url) => {
      const href = String(url);
      if (href.includes('/user/xiaomi/me')) {
        return {
          status: 200,
          headers: { get: () => null, getSetCookie: () => [] },
          json: async () => ({ code: 0, data: { userId: '123' } }),
          text: async () => JSON.stringify({ code: 0, data: { userId: '123' } })
        };
      }
      return response({ code: 0, data: { current: { planCode: 'mimo-cn-pro', percent: 60, nextResetTime: '2026-09-15T00:00:00' } } });
    }),
    readMimoDesktopAccount: () => ({ ok: false, reason: 'absent' })
  });
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].accountKey, hashKey('mimo', '123', 'membership'));
});

test('a signed-out MiMo Desktop is reported, and a missing one is not', async () => {
  // The store reads and names an account but carries half a sign-in: an app the
  // user is signed out of rather than a machine without one, so the console lane
  // says so against that account instead of staying quiet. Both lanes agree on
  // this, which is what makes the same machine read the same way twice.
  const signedOut = await fetchMimoLimitsRaw({}, {
    fetch: async () => response({ code: 0, data: null }),
    readMimoDesktopAccount: () => ({ ok: false, reason: 'incomplete', userId: '123' })
  });
  const row = signedOut.find((entry) => entry.accountKey === hashKey('mimo:123'));
  assert.equal(row.status, 'unauthorized');
  assert.equal(signedOut.some((entry) => entry.accountKey === ''), false);

  // The same store with nothing to name stays silent: a provider-wide row would
  // be read as the whole provider's.
  const unnamed = await fetchMimoLimitsRaw({}, {
    fetch: async () => response({ code: 0, data: null }),
    readMimoDesktopAccount: () => ({ ok: false, reason: 'incomplete', userId: '' })
  });
  assert.equal(unnamed.status, 'notConfigured');
});

// ---- the account panel -------------------------------------------------------

test('a detected session is listed once, beside the pasted accounts', () => {
  const stored = [{ id: 'a', accountKey: 'sha256:one', accountEmail: 'a@example.com' }];
  const detected = { id: 'mimo-desktop', accountKey: 'sha256:desktop' };

  // Pasted accounts are removable because Token Monitor stores them; the detected
  // one is not, because it holds nothing but a session the app owns.
  assert.deepEqual(withDetectedMimoAccount(stored, detected), [
    { id: 'a', accountKey: 'sha256:one', accountEmail: 'a@example.com', removable: true },
    { id: 'mimo-desktop', accountKey: 'sha256:desktop', removable: false }
  ]);

  // A stored account that already names the same account keeps the row — one
  // account is one row on the panel as it is in the limits list.
  assert.deepEqual(
    withDetectedMimoAccount([{ id: 'a', accountKey: 'sha256:desktop' }], detected),
    [{ id: 'a', accountKey: 'sha256:desktop', removable: true }]
  );

  // Nothing discovered leaves the list exactly as it was.
  assert.deepEqual(withDetectedMimoAccount(stored, null), [
    { id: 'a', accountKey: 'sha256:one', accountEmail: 'a@example.com', removable: true }
  ]);
  assert.deepEqual(withDetectedMimoAccount([], null), []);
});
