'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLimitsRuntime } = require('../../src/shared/limitsRuntime');

const {
  DEFAULT_QUOTA_PER_UNIT,
  CUSTOM_BALANCE_ADAPTER,
  NEWAPI_ACCOUNT_ADAPTER,
  NEWAPI_ACCOUNT_PATH,
  NEWAPI_STATUS_PATH,
  NEWAPI_TOKEN_ADAPTER,
  NEWAPI_TOKEN_USAGE_PATH,
  SUB2API_ADAPTER,
  SUB2API_DASHBOARD_STATS_PATH,
  SUB2API_ME_PATH,
  SUB2API_REFRESH_PATH,
  SUB2API_USAGE_STATS_PATH,
  THIRD_PARTY_ADAPTER_IDS,
  THIRD_PARTY_ADAPTERS,
  THIRD_PARTY_ENV_ACCOUNT_NAME,
  configuredAccounts,
  customBalanceQuota,
  fetchThirdPartyLimits,
  newapiAccessToken,
  newapiApiKey,
  newapiBaseUrl,
  newapiUserId,
  normalizeThirdPartyBaseUrl,
  normalizeCustomAuthMode,
  normalizeCustomCurrency,
  normalizeCustomDivisor,
  normalizeCustomEndpointPath,
  normalizeCustomJsonPath,
  normalizeThirdPartyProfile,
  quotaPerUnit,
  readCustomJsonPath,
  thirdPartyProfileName
} = require('../../src/shared/thirdPartyLimits');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null }
  };
}

function apiFetch(accounts, defaultStatusBody = { quota_per_unit: DEFAULT_QUOTA_PER_UNIT }) {
  return async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    const parsed = new URL(url);
    const matchedPath = [NEWAPI_STATUS_PATH, NEWAPI_ACCOUNT_PATH, NEWAPI_TOKEN_USAGE_PATH]
      .find((path) => parsed.pathname.endsWith(path));
    assert.ok(matchedPath, `unexpected third-party API path: ${parsed.pathname}`);
    const originAndPrefix = `${parsed.origin}${parsed.pathname.slice(0, -matchedPath.length)}`;
    const account = accounts[originAndPrefix];
    assert.ok(account, `unexpected third-party API base URL: ${originAndPrefix}`);

    if (matchedPath === NEWAPI_STATUS_PATH) {
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.headers['New-Api-User'], undefined);
      return response(account.statusStatus || 200, {
        data: account.statusBody || defaultStatusBody
      });
    }
    if (matchedPath === NEWAPI_ACCOUNT_PATH) {
      assert.equal(init.headers.Authorization, `Bearer ${account.accessToken}`);
      assert.equal(init.headers['New-Api-User'], account.userId);
      return response(account.quotaStatus || 200, {
        success: account.quotaSuccess ?? true,
        data: account.accountBody
      });
    }
    assert.equal(init.headers.Authorization, `Bearer ${account.apiKey}`);
    assert.equal(init.headers['New-Api-User'], undefined);
    return response(account.quotaStatus || 200, {
      code: account.quotaSuccess ?? true,
      data: account.tokenBody
    });
  };
}

test('New API helpers accept only the explicit Token Monitor environment surface', () => {
  const env = {
    TOKEN_MONITOR_NEWAPI_BASE_URL: '"https://example.com/v1/"',
    TOKEN_MONITOR_NEWAPI_ACCESS_TOKEN: "'access-token'",
    TOKEN_MONITOR_NEWAPI_USER_ID: '"42"',
    TOKEN_MONITOR_NEWAPI_API_KEY: "'api-key'",
    NEWAPI_BASE_URL: 'https://ignored.example',
    NEWAPI_ACCESS_TOKEN: 'ignored-access',
    NEWAPI_USER_ID: '99',
    NEWAPI_API_KEY: 'ignored-key'
  };
  assert.equal(newapiBaseUrl(env), 'https://example.com');
  assert.equal(newapiAccessToken(env), 'access-token');
  assert.equal(newapiUserId(env), '42');
  assert.equal(newapiApiKey(env), 'api-key');
  assert.equal(newapiAccessToken(env, '"explicit"'), 'explicit');
  assert.equal(newapiApiKey({ NEWAPI_API_KEY: 'ambiguous-key' }), '');
  assert.equal(newapiBaseUrl({ NEWAPI_BASE_URL: 'https://ignored.example' }), '');
});

test('third-party adapters are registered explicitly behind the stable provider id', () => {
  assert.deepEqual(Object.keys(THIRD_PARTY_ADAPTERS), THIRD_PARTY_ADAPTER_IDS);
  assert.deepEqual(
    THIRD_PARTY_ADAPTER_IDS,
    [NEWAPI_ACCOUNT_ADAPTER, NEWAPI_TOKEN_ADAPTER, SUB2API_ADAPTER, CUSTOM_BALANCE_ADAPTER]
  );
  for (const adapter of Object.values(THIRD_PARTY_ADAPTERS)) {
    assert.equal(typeof adapter.normalizeCredentials, 'function');
    assert.equal(typeof adapter.identity, 'function');
    assert.equal(typeof adapter.request, 'function');
    assert.equal(typeof adapter.quota, 'function');
    assert.equal(typeof adapter.planLabel, 'function');
  }
});

test('third-party Base URLs preserve subpaths and strip only a terminal v1', () => {
  assert.equal(normalizeThirdPartyBaseUrl('https://api.example.com/'), 'https://api.example.com');
  assert.equal(normalizeThirdPartyBaseUrl('https://api.example.com/v1'), 'https://api.example.com');
  assert.equal(normalizeThirdPartyBaseUrl('https://api.example.com/prefix/v1/'), 'https://api.example.com/prefix');
  assert.equal(normalizeThirdPartyBaseUrl('http://127.0.0.1:3000/v1'), 'http://127.0.0.1:3000');
  assert.equal(normalizeThirdPartyBaseUrl('https://api.example.com/prefix'), 'https://api.example.com/prefix');
  assert.equal(normalizeThirdPartyBaseUrl('ftp://api.example.com'), '');
  assert.equal(normalizeThirdPartyBaseUrl('https://user:pass@api.example.com'), '');
  assert.equal(normalizeThirdPartyBaseUrl('https://api.example.com?token=secret'), '');
  assert.equal(
    normalizeThirdPartyBaseUrl('https://api.example.com/v1', { stripTerminalV1: false }),
    'https://api.example.com/v1'
  );
});

test('custom balance configuration is declarative and rejects unsafe paths', () => {
  assert.equal(normalizeCustomEndpointPath(''), '/user/balance');
  assert.equal(normalizeCustomEndpointPath('/billing/balance'), '/billing/balance');
  assert.equal(normalizeCustomEndpointPath('/billing/../admin'), '');
  assert.equal(normalizeCustomEndpointPath('/billing%2F..%2Fadmin'), '');
  assert.equal(normalizeCustomEndpointPath('//other.example/balance'), '');
  assert.equal(normalizeCustomEndpointPath('/balance?secret=1'), '');
  assert.equal(normalizeCustomAuthMode('bearer'), 'bearer');
  assert.equal(normalizeCustomAuthMode('x-api-key'), 'x-api-key');
  assert.equal(normalizeCustomAuthMode('basic'), '');
  assert.equal(normalizeCustomJsonPath('data.balance'), 'data.balance');
  assert.equal(normalizeCustomJsonPath('data.__proto__.balance'), '');
  assert.equal(normalizeCustomJsonPath('data[0].balance'), '');
  assert.equal(normalizeCustomCurrency('hkd'), 'HKD');
  assert.equal(normalizeCustomCurrency('US$'), '');
  assert.equal(normalizeCustomDivisor('100'), 100);
  assert.equal(normalizeCustomDivisor(''), 1);
  assert.equal(normalizeCustomDivisor('0'), null);
  assert.equal(readCustomJsonPath({ data: { balance: 12 } }, 'data.balance'), 12);
  assert.equal(readCustomJsonPath({ data: {} }, 'data.balance'), undefined);

  assert.equal(normalizeThirdPartyProfile({
    adapter: CUSTOM_BALANCE_ADAPTER,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret',
    endpointPath: '/billing',
    authMode: 'bearer',
    remainingPath: 'data.balance',
    currency: 'USD',
    divisor: 1
  }).baseUrl, 'https://api.example.com/v1');
  assert.equal(normalizeThirdPartyProfile({
    baseUrl: 'https://api.example.com',
    accessToken: 'secret'
  }), null);
});

test('third-party profile names support Unicode and reserve the environment identity', () => {
  assert.equal(thirdPartyProfileName('工作'), '工作');
  assert.equal(thirdPartyProfileName('ワーク'), 'ワーク');
  assert.equal(thirdPartyProfileName('업무'), '업무');
  assert.equal(thirdPartyProfileName('a  b'), 'a b');
  assert.equal(thirdPartyProfileName('Cafe\u0301'), 'Café');
  assert.equal(thirdPartyProfileName('environment'), '');
  assert.equal(thirdPartyProfileName('a/b'), '');
  assert.equal(thirdPartyProfileName('__proto__'), '');
  assert.equal(thirdPartyProfileName('prototype'), '');
  assert.equal(thirdPartyProfileName('constructor'), '');
  assert.equal(thirdPartyProfileName('x'.repeat(65)), '');
});

test('quota conversion uses the instance setting and falls back to the default on zero', () => {
  assert.equal(quotaPerUnit({ data: { quota_per_unit: 1_000_000 } }), 1_000_000);
  assert.equal(quotaPerUnit({ data: { quota_per_unit: 0 } }), DEFAULT_QUOTA_PER_UNIT);
});

test('New API account adapter exposes whole-account balance and cumulative usage', async () => {
  const [provider] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      production: {
        adapter: NEWAPI_ACCOUNT_ADAPTER,
        baseUrl: 'https://api.example.com/v1',
        accessToken: 'system-access',
        userId: '42',
        enabled: true
      }
    }
  }, {
    env: {},
    now: () => Date.parse('2026-07-24T08:00:00Z'),
    fetch: apiFetch({
      'https://api.example.com': {
        accessToken: 'system-access',
        userId: '42',
        accountBody: {
          group: 'default',
          quota: 25_000_000,
          used_quota: 5_000_000,
          request_count: 12_345
        }
      }
    })
  });

  assert.equal(provider.provider, 'thirdparty');
  assert.equal(provider.accountName, 'production');
  assert.equal(provider.planLabel, 'Account');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.balance.amount, 50);
  assert.equal(provider.balance.currency, 'USD');
  assert.equal(provider.balance.todaySpend, null);
  assert.equal(provider.balance.weekSpend, null);
  assert.equal(provider.balance.monthSpend, null);
  assert.equal(provider.balance.allTimeSpend, 10);
  assert.equal(provider.balance.requestCount, 12_345);
  assert.equal(provider.balance.quotaGroup, 'default');
  assert.deepEqual(provider.windows, [{
    kind: 'billing',
    metric: 'credits',
    label: 'Balance',
    used: 10,
    limit: 60,
    remaining: 50,
    usedPercent: 16.666666666666664,
    remainingPercent: 83.333,
    resetsAt: null,
    windowMinutes: null,
    resetDescription: '',
    detail: '',
    currency: null,
    showMeter: true
  }]);
  const publicJson = JSON.stringify(provider);
  assert.equal(publicJson.includes('system-access'), false);
  assert.equal(publicJson.includes('api.example.com'), false);
  assert.equal(publicJson.includes('"42"'), false);
});

test('New API-compatible account adapter omits the user header when no ID is configured', async () => {
  const [provider] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      compatible: {
        adapter: NEWAPI_ACCOUNT_ADAPTER,
        baseUrl: 'https://compatible.example',
        accessToken: 'account-access'
      }
    }
  }, {
    env: {},
    fetch: apiFetch({
      'https://compatible.example': {
        accessToken: 'account-access',
        userId: undefined,
        accountBody: {
          group: 'default',
          quota: 2_500_000,
          used_quota: 500_000
        }
      }
    })
  });

  assert.equal(provider.status, 'ok');
  assert.equal(provider.planLabel, 'Account');
  assert.equal(provider.balance.amount, 5);
  assert.equal(provider.balance.allTimeSpend, 1);
});

test('New API token adapter exposes only that token quota', async () => {
  const [provider] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      personal: {
        adapter: NEWAPI_TOKEN_ADAPTER,
        baseUrl: 'https://token.example',
        apiKey: 'sk-personal',
        enabled: true
      }
    }
  }, {
    env: {},
    fetch: apiFetch({
      'https://token.example': {
        apiKey: 'sk-personal',
        tokenBody: {
          name: 'daily-driver',
          total_available: 25_000_000,
          total_used: 5_000_000,
          unlimited_quota: false,
          expires_at: 1_800_000_000
        }
      }
    })
  });

  assert.equal(provider.provider, 'thirdparty');
  assert.equal(provider.planLabel, 'API key');
  assert.equal(provider.balance.amount, 50);
  assert.equal(provider.balance.allTimeSpend, 10);
  assert.equal(provider.balance.expiresAt, '2027-01-15T08:00:00.000Z');
  assert.equal(provider.windows[0].label, 'Token quota');
  assert.equal(provider.windows[0].limit, 60);
  assert.equal(JSON.stringify(provider).includes('sk-personal'), false);
});

test('Sub2API adapter reports the dashboard balance without usable enrichment totals', async () => {
  const calls = [];
  const [provider] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      dashboard: {
        adapter: SUB2API_ADAPTER,
        baseUrl: 'https://sub2api.example/v1',
        accessToken: 'dashboard-jwt',
        enabled: true
      }
    }
  }, {
    env: {},
    fetch: async (url, init) => {
      calls.push([url, init]);
      return response(200, {
        code: 0,
        message: 'success',
        data: {
          id: 42,
          username: 'subscriber',
          balance: 12.5
        }
      });
    }
  });

  assert.equal(provider.provider, 'thirdparty');
  assert.equal(provider.accountName, 'dashboard');
  assert.equal(provider.planLabel, 'Account');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.balance.amount, 12.5);
  assert.equal(provider.balance.currency, 'USD');
  assert.equal(provider.balance.allTimeSpend, null);
  const meCall = calls.find(([url]) => url.endsWith(SUB2API_ME_PATH));
  assert.ok(meCall, 'auth/me must be requested');
  assert.equal(meCall[1].method, 'GET');
  assert.equal(meCall[1].headers.Authorization, 'Bearer dashboard-jwt');
  assert.equal(provider.windows[0].label, 'Balance');
  assert.equal(provider.windows[0].remaining, 12.5);
  assert.equal(provider.windows[0].showMeter, false);
  const publicJson = JSON.stringify(provider);
  assert.equal(publicJson.includes('dashboard-jwt'), false);
  assert.equal(publicJson.includes('sub2api.example'), false);
});

test('Sub2API adapter attaches rolling-month and all-time spend and survives stats failures', async () => {
  const [enriched] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      dashboard: {
        adapter: SUB2API_ADAPTER,
        baseUrl: 'https://stats.example',
        accessToken: 'jwt'
      }
    }
  }, {
    env: {},
    fetch: async (url) => {
      if (url.endsWith(SUB2API_DASHBOARD_STATS_PATH)) {
        return response(200, {
          code: 0,
          message: 'success',
          data: { total_actual_cost: 18.75 }
        });
      }
      return url.endsWith(SUB2API_USAGE_STATS_PATH)
        ? response(200, {
          code: 0,
          message: 'success',
          data: {
            total_requests: 21,
            total_input_tokens: 1234,
            total_output_tokens: 456,
            total_cache_read_tokens: 200,
            total_cache_creation_tokens: 50,
            total_tokens: 1940,
            total_cost: 3,
            average_duration_ms: 850,
            total_actual_cost: 2.5
          }
        })
        : response(200, { code: 0, message: 'success', data: { id: 1, balance: 12.5 } });
    }
  });
  assert.equal(enriched.status, 'ok');
  assert.equal(enriched.balance.amount, 12.5);
  assert.equal(enriched.balance.monthSpend, 2.5);
  assert.equal(enriched.balance.allTimeSpend, 18.75);
  assert.equal(enriched.adapterId, SUB2API_ADAPTER);
  assert.deepEqual(enriched.usageSummary, {
    period: 'month',
    requests: 21,
    inputTokens: 1234,
    outputTokens: 456,
    cacheReadTokens: 200,
    cacheCreationTokens: 50,
    totalTokens: 1940,
    standardCost: 3,
    actualCost: 2.5,
    averageDurationMs: 850
  });

  const [withoutStats] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      legacy: {
        adapter: SUB2API_ADAPTER,
        baseUrl: 'https://legacy.example',
        accessToken: 'jwt'
      }
    }
  }, {
    env: {},
    fetch: async (url) => (
      url.startsWith('https://legacy.example/api/v1/usage/')
        ? response(404, { code: 404, message: 'not found' })
        : response(200, { code: 0, message: 'success', data: { id: 1, balance: 7.5 } })
    )
  });
  assert.equal(withoutStats.status, 'ok');
  assert.equal(withoutStats.balance.amount, 7.5);
  assert.equal(withoutStats.balance.monthSpend, null);
  assert.equal(withoutStats.balance.allTimeSpend, null);
  assert.equal(withoutStats.usageSummary, undefined);
});

test('Sub2API adapter fails closed on business errors and missing balances', async () => {
  const businessError = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      expired: {
        adapter: SUB2API_ADAPTER,
        baseUrl: 'https://expired.example',
        accessToken: 'expired-jwt'
      }
    }
  }, {
    env: {},
    fetch: async () => response(200, { code: 401, message: 'token expired', data: null })
  });
  assert.equal(businessError[0].status, 'unavailable');
  assert.deepEqual(businessError[0].windows, []);

  const missingBalance = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      empty: {
        adapter: SUB2API_ADAPTER,
        baseUrl: 'https://empty.example',
        accessToken: 'jwt'
      }
    }
  }, {
    env: {},
    fetch: async () => response(200, { code: 0, message: 'success', data: { id: 7, username: 'no-balance' } })
  });
  assert.equal(missingBalance[0].status, 'unavailable');

  const unauthorized = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      bad: {
        adapter: SUB2API_ADAPTER,
        baseUrl: 'https://bad.example',
        accessToken: 'bad-jwt'
      }
    }
  }, {
    env: {},
    fetch: async () => response(401, { code: 401, message: 'unauthorized' })
  });
  assert.equal(unauthorized[0].status, 'unauthorized');
  assert.deepEqual(unauthorized[0].windows, []);
});

test('Sub2API adapter renews an expired access token once after persisting the rotation', async () => {
  const calls = [];
  const renewals = [];
  let currentAccess = 'expired-jwt';
  const [provider] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      dashboard: {
        adapter: SUB2API_ADAPTER,
        baseUrl: 'https://renew.example',
        accessToken: currentAccess,
        refreshToken: 'refresh-1'
      }
    }
  }, {
    env: {},
    fetch: async (url, init) => {
      calls.push([init.method, url]);
      if (url.endsWith(SUB2API_REFRESH_PATH)) {
        assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(init.body), { refresh_token: 'refresh-1' });
        currentAccess = 'fresh-jwt';
        return response(200, {
          code: 0,
          message: 'success',
          data: {
            access_token: currentAccess,
            refresh_token: 'refresh-2',
            expires_in: 3600
          }
        });
      }
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.Authorization, `Bearer ${currentAccess}`);
      if (currentAccess === 'expired-jwt') {
        return response(401, { code: 401, message: 'TOKEN_EXPIRED', data: null });
      }
      return response(200, {
        code: 0,
        message: 'success',
        data: { id: 1, username: 'subscriber', balance: 3.5 }
      });
    },
    onThirdPartyCredentialsRenewed: async (renewal) => {
      renewals.push(renewal);
      return true;
    }
  });

  assert.equal(provider.status, 'ok');
  assert.equal(provider.balance.amount, 3.5);
  assert.deepEqual(renewals, [{
    provider: 'thirdparty',
    adapter: SUB2API_ADAPTER,
    accountName: 'dashboard',
    baseUrl: 'https://renew.example',
    previous: { accessToken: 'expired-jwt', refreshToken: 'refresh-1' },
    next: { accessToken: 'fresh-jwt', refreshToken: 'refresh-2' }
  }]);
  assert.deepEqual(calls.filter(([, url]) => !url.startsWith('https://renew.example/api/v1/usage/')), [
    ['GET', 'https://renew.example/api/v1/auth/me'],
    ['POST', 'https://renew.example/api/v1/auth/refresh'],
    ['GET', 'https://renew.example/api/v1/auth/me']
  ]);
  assert.equal(JSON.stringify(provider).includes('refresh-1'), false);
});

test('Sub2API renewal requires a persistence callback and fails closed on refresh errors', async () => {
  const [unrenewed] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      stale: {
        adapter: SUB2API_ADAPTER,
        baseUrl: 'https://stale.example',
        accessToken: 'expired-jwt',
        refreshToken: 'refresh-1'
      }
    }
  }, {
    env: {},
    fetch: async (url) => {
      if (url.endsWith(SUB2API_REFRESH_PATH)) throw new Error('refresh must not be called');
      return response(401, { code: 401, message: 'TOKEN_EXPIRED', data: null });
    }
  });
  assert.equal(unrenewed.status, 'unauthorized');
  assert.deepEqual(unrenewed.windows, []);

  const [broken] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      broken: {
        adapter: SUB2API_ADAPTER,
        baseUrl: 'https://broken.example',
        accessToken: 'expired-jwt',
        refreshToken: 'dead-refresh'
      }
    }
  }, {
    env: {},
    fetch: async (url) => (
      url.endsWith(SUB2API_REFRESH_PATH)
        ? response(401, { code: 401, message: 'REFRESH_TOKEN_INVALID', data: null })
        : response(401, { code: 401, message: 'TOKEN_EXPIRED', data: null })
    ),
    onThirdPartyCredentialsRenewed: async () => true
  });
  assert.equal(broken.status, 'unauthorized');
  assert.deepEqual(broken.windows, []);
});

test('Sub2API does not retry with a rotated pair that persistence rejected', async () => {
  let retriedWithFreshToken = false;
  const [provider] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      dashboard: {
        adapter: SUB2API_ADAPTER,
        baseUrl: 'https://persist.example',
        accessToken: 'expired-jwt',
        refreshToken: 'refresh-1'
      }
    }
  }, {
    env: {},
    fetch: async (url, init) => {
      if (url.endsWith(SUB2API_REFRESH_PATH)) {
        return response(200, {
          code: 0,
          data: { access_token: 'fresh-jwt', refresh_token: 'refresh-2' }
        });
      }
      if (url.endsWith(SUB2API_ME_PATH) && init.headers.Authorization === 'Bearer fresh-jwt') {
        retriedWithFreshToken = true;
        return response(200, { code: 0, data: { balance: 2 } });
      }
      return response(401, { code: 401, message: 'TOKEN_EXPIRED', data: null });
    },
    onThirdPartyCredentialsRenewed: async () => false
  });

  assert.equal(provider.status, 'unavailable');
  assert.equal(retriedWithFreshToken, false);
});

test('Sub2API profiles may start from a refresh token and retain both credentials', async () => {
  const normalized = normalizeThirdPartyProfile({
    adapter: SUB2API_ADAPTER,
    baseUrl: 'https://refresh-only.example',
    refreshToken: 'refresh-only'
  });
  assert.equal(normalized.accessToken, '');
  assert.equal(normalized.refreshToken, 'refresh-only');

  const [provider] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      bootstrap: { ...normalized }
    }
  }, {
    env: {},
    fetch: async (url, init) => {
      if (url.endsWith(SUB2API_REFRESH_PATH)) {
        assert.deepEqual(JSON.parse(init.body), { refresh_token: 'refresh-only' });
        return response(200, {
          code: 0,
          message: 'success',
          data: { access_token: 'minted-jwt', refresh_token: 'refresh-next' }
        });
      }
      if (init.headers.Authorization !== 'Bearer minted-jwt') {
        return response(401, { code: 401, message: 'UNAUTHORIZED', data: null });
      }
      return response(200, {
        code: 0,
        message: 'success',
        data: { id: 5, username: 'bootstrap', balance: 1.25 }
      });
    },
    onThirdPartyCredentialsRenewed: async () => true
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.balance.amount, 1.25);

  assert.deepEqual(normalizeThirdPartyProfile({
    adapter: SUB2API_ADAPTER,
    baseUrl: 'https://dashboard.example',
    accessToken: 'dashboard-jwt',
    refreshToken: 'dashboard-refresh'
  }), {
    adapter: SUB2API_ADAPTER,
    baseUrl: 'https://dashboard.example',
    accessToken: 'dashboard-jwt',
    refreshToken: 'dashboard-refresh',
    enabled: true
  });
});

test('Sub2API account identity stays stable when its access token is replaced', async () => {
  const collect = async (accessToken) => {
    const [provider] = await fetchThirdPartyLimits({
      thirdPartyProfiles: {
        dashboard: {
          adapter: SUB2API_ADAPTER,
          baseUrl: 'https://stable.example',
          accessToken
        }
      }
    }, {
      env: {},
      fetch: async (url) => (
        url.includes('/usage/stats')
          ? response(404, { code: 404, message: 'not found' })
          : response(200, { code: 0, message: 'success', data: { id: 42, balance: 3.5 } })
      )
    });
    return provider;
  };

  const before = await collect('dashboard-jwt-before');
  const after = await collect('dashboard-jwt-after');
  assert.equal(before.status, 'ok');
  assert.equal(after.status, 'ok');
  assert.equal(before.accountKey, after.accountKey);
  assert.equal(JSON.stringify([before, after]).includes('dashboard-jwt'), false);
});

test('Sub2API credential replacement keeps one LimitsRuntime identity', async (t) => {
  let accessToken = 'dashboard-jwt-before';
  const runtime = createLimitsRuntime({ limitProviders: ['thirdparty'] }, {
    autoStart: false,
    autoRetry: false,
    cleanupGraceMs: 0,
    maxConcurrency: 1,
    providerPhysicalBoundMs: () => 100,
    resolveConfigSnapshot: () => ({
      limitProviders: ['thirdparty'],
      thirdPartyProfiles: {
        dashboard: {
          adapter: SUB2API_ADAPTER,
          baseUrl: 'https://runtime.example',
          accessToken
        }
      }
    }),
    probeProvider: async (_provider, config, context, deps) => fetchThirdPartyLimits(config, {
      ...deps,
      env: {},
      signal: context.signal,
      fetch: async (url) => (
        url.includes('/usage/stats')
          ? response(404, { code: 404, message: 'not found' })
          : response(200, { code: 0, message: 'success', data: { id: 42, balance: 3.5 } })
      )
    })
  });
  t.after(() => runtime.stop());

  await runtime.refresh({ provider: 'thirdparty' }, 'startup');
  const originalKey = runtime.getSnapshot().providers[0].accountKey;
  accessToken = 'dashboard-jwt-after';
  await runtime.refresh({ provider: 'thirdparty' }, 'credential-save');

  const providers = runtime.getSnapshot().providers;
  assert.equal(providers.length, 1);
  assert.equal(providers[0].accountKey, originalKey);
  assert.equal(providers[0].status, 'ok');
});

test('custom adapter maps one GET response without exposing configuration', async () => {
  const calls = [];
  const [provider] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      relay: {
        adapter: CUSTOM_BALANCE_ADAPTER,
        baseUrl: 'https://relay.example/v1',
        apiKey: 'relay-key',
        endpointPath: '/billing/balance',
        authMode: 'x-api-key',
        remainingPath: 'data.remaining_cents',
        usedPath: 'data.used_cents',
        totalPath: 'data.total_cents',
        currency: 'HKD',
        divisor: 100
      }
    }
  }, {
    env: {},
    fetch: async (url, init) => {
      calls.push([url, init]);
      return response(200, {
        data: {
          remaining_cents: 1250,
          used_cents: 750,
          total_cents: 2000
        }
      });
    }
  });

  assert.equal(provider.status, 'ok');
  assert.equal(provider.planLabel, 'Custom');
  assert.equal(provider.balance.amount, 12.5);
  assert.equal(provider.balance.currency, 'HKD');
  assert.equal(provider.balance.allTimeSpend, 7.5);
  assert.equal(provider.windows[0].limit, 20);
  assert.equal(provider.windows[0].remaining, 12.5);
  assert.equal(provider.windows[0].used, 7.5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://relay.example/v1/billing/balance');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].headers['x-api-key'], 'relay-key');
  assert.equal(calls[0][1].headers.Authorization, undefined);
  const publicJson = JSON.stringify(provider);
  assert.equal(publicJson.includes('relay-key'), false);
  assert.equal(publicJson.includes('relay.example'), false);
  assert.equal(publicJson.includes('remaining_cents'), false);
});

test('unlimited account and token quota never invent a zero balance', async () => {
  const providers = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      account: {
        adapter: NEWAPI_ACCOUNT_ADAPTER,
        baseUrl: 'https://account.example',
        accessToken: 'access',
        userId: '7'
      },
      token: {
        adapter: NEWAPI_TOKEN_ADAPTER,
        baseUrl: 'https://token.example',
        apiKey: 'key'
      }
    }
  }, {
    env: {},
    fetch: apiFetch({
      'https://account.example': {
        accessToken: 'access',
        userId: '7',
        accountBody: { group: 'default', quota: -1, used_quota: 1_000_000 }
      },
      'https://token.example': {
        apiKey: 'key',
        tokenBody: {
          name: 'unlimited',
          total_available: 0,
          total_used: 2_500_000,
          unlimited_quota: true
        }
      }
    })
  });

  for (const provider of providers) {
    assert.equal(provider.status, 'ok');
    assert.equal(provider.balance.amount, null);
    assert.equal(provider.windows[0].showMeter, false);
    assert.equal(provider.windows[0].detail, 'Unlimited');
  }
  assert.equal(providers[0].balance.allTimeSpend, 2);
  assert.equal(providers[1].balance.allTimeSpend, 5);
});

test('status request failure fails closed instead of guessing the conversion unit', async () => {
  const [provider] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      fallback: {
        adapter: NEWAPI_ACCOUNT_ADAPTER,
        baseUrl: 'https://fallback.example',
        accessToken: 'access',
        userId: '8'
      }
    }
  }, {
    env: {},
    fetch: apiFetch({
      'https://fallback.example': {
        accessToken: 'access',
        userId: '8',
        statusStatus: 500,
        accountBody: { quota: 500_000, used_quota: 500_000 }
      }
    })
  });
  assert.equal(provider.status, 'unavailable');
  assert.deepEqual(provider.windows, []);
});

test('successful status response without a unit uses the documented New API default', async () => {
  const [provider] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      fallback: {
        adapter: NEWAPI_ACCOUNT_ADAPTER,
        baseUrl: 'https://fallback.example',
        accessToken: 'access',
        userId: '8'
      }
    }
  }, {
    env: {},
    fetch: apiFetch({
      'https://fallback.example': {
        accessToken: 'access',
        userId: '8',
        statusBody: {},
        accountBody: { quota: 500_000, used_quota: 500_000 }
      }
    })
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.balance.amount, 1);
  assert.equal(provider.balance.allTimeSpend, 1);
});

test('invalid or unauthorized adapter responses fail closed', async () => {
  const unauthorized = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      bad: {
        adapter: NEWAPI_ACCOUNT_ADAPTER,
        baseUrl: 'https://bad.example',
        accessToken: 'bad',
        userId: '9'
      }
    }
  }, {
    env: {},
    fetch: apiFetch({
      'https://bad.example': {
        accessToken: 'bad',
        userId: '9',
        quotaStatus: 401,
        accountBody: null
      }
    })
  });
  assert.equal(unauthorized[0].status, 'unauthorized');
  assert.deepEqual(unauthorized[0].windows, []);

  const malformed = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      malformed: {
        adapter: NEWAPI_TOKEN_ADAPTER,
        baseUrl: 'https://malformed.example',
        apiKey: 'key'
      }
    }
  }, {
    env: {},
    fetch: apiFetch({
      'https://malformed.example': {
        apiKey: 'key',
        tokenBody: { total_available: null, total_used: null }
      }
    })
  });
  assert.equal(malformed[0].status, 'unavailable');

  const rejectedEnvelope = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      rejected: {
        adapter: NEWAPI_ACCOUNT_ADAPTER,
        baseUrl: 'https://rejected.example',
        accessToken: 'access',
        userId: '10'
      }
    }
  }, {
    env: {},
    fetch: apiFetch({
      'https://rejected.example': {
        accessToken: 'access',
        userId: '10',
        quotaSuccess: false,
        accountBody: { quota: 500_000, used_quota: 0 }
      }
    })
  });
  assert.equal(rejectedEnvelope[0].status, 'unavailable');

  const nonNumericCustomBalance = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      custom: {
        adapter: CUSTOM_BALANCE_ADAPTER,
        baseUrl: 'https://custom.example',
        apiKey: 'custom-key',
        endpointPath: '/balance',
        authMode: 'bearer',
        remainingPath: 'data.remaining',
        currency: 'USD',
        divisor: 1
      }
    }
  }, {
    env: {},
    fetch: async () => response(200, { data: { remaining: 'not-a-number' } })
  });
  assert.equal(nonNumericCustomBalance[0].status, 'unavailable');
  assert.deepEqual(nonNumericCustomBalance[0].windows, []);
  assert.equal(customBalanceQuota(
    { data: { remaining: true } },
    { divisor: 1, remainingPath: 'data.remaining' }
  ), null);
  assert.equal(customBalanceQuota(
    { data: { remaining: [12] } },
    { divisor: 1, remainingPath: 'data.remaining' }
  ), null);
});

test('configured accounts deduplicate exact adapter identities but keep distinct modes', () => {
  const accounts = configuredAccounts({
    thirdPartyProfiles: {
      work: {
        adapter: NEWAPI_ACCOUNT_ADAPTER,
        baseUrl: 'https://one.example/v1',
        accessToken: 'access',
        userId: '11'
      },
      duplicate: {
        adapter: NEWAPI_ACCOUNT_ADAPTER,
        baseUrl: 'https://one.example',
        accessToken: 'access',
        userId: '11'
      },
      token: {
        adapter: NEWAPI_TOKEN_ADAPTER,
        baseUrl: 'https://one.example',
        apiKey: 'access'
      },
      disabled: {
        adapter: NEWAPI_TOKEN_ADAPTER,
        baseUrl: 'https://disabled.example',
        apiKey: 'disabled',
        enabled: false
      },
      malformed: null
    }
  }, { env: {} });

  assert.deepEqual(accounts, [
    {
      name: 'work',
      adapter: NEWAPI_ACCOUNT_ADAPTER,
      baseUrl: 'https://one.example',
      accessToken: 'access',
      userId: '11',
      enabled: true
    },
    {
      name: 'token',
      adapter: NEWAPI_TOKEN_ADAPTER,
      baseUrl: 'https://one.example',
      apiKey: 'access',
      enabled: true
    }
  ]);
});

test('custom account identity stays stable across mapping and display changes', async () => {
  const common = {
    adapter: CUSTOM_BALANCE_ADAPTER,
    baseUrl: 'https://custom.example',
    apiKey: 'custom-key',
    endpointPath: '/balance',
    authMode: 'bearer'
  };
  const fetch = async () => response(200, {
    data: {
      remaining: 12,
      balance: 12_000,
      used: 3
    }
  });
  const [original] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      custom: {
        ...common,
        remainingPath: 'data.remaining',
        usedPath: 'data.used',
        currency: 'USD',
        divisor: 1
      }
    }
  }, { env: {}, fetch });
  const [remapped] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      custom: {
        ...common,
        remainingPath: 'data.balance',
        currency: 'USDT',
        divisor: 1_000
      }
    }
  }, { env: {}, fetch });

  assert.equal(original.status, 'ok');
  assert.equal(remapped.status, 'ok');
  assert.equal(original.accountKey, remapped.accountKey);
  assert.equal(original.balance.currency, 'USD');
  assert.equal(remapped.balance.currency, 'USDT');
  assert.equal(original.balance.amount, remapped.balance.amount);
});

test('environment configuration prefers account quota and falls back to token quota', () => {
  assert.deepEqual(configuredAccounts({}, {
    env: {
      TOKEN_MONITOR_NEWAPI_BASE_URL: 'https://compatible-env.example',
      TOKEN_MONITOR_NEWAPI_ACCESS_TOKEN: 'access-only'
    }
  }), [{
    name: THIRD_PARTY_ENV_ACCOUNT_NAME,
    adapter: NEWAPI_ACCOUNT_ADAPTER,
    baseUrl: 'https://compatible-env.example',
    accessToken: 'access-only',
    enabled: true
  }]);

  assert.deepEqual(configuredAccounts({}, {
    env: {
      TOKEN_MONITOR_NEWAPI_BASE_URL: 'https://env.example/v1',
      TOKEN_MONITOR_NEWAPI_ACCESS_TOKEN: 'access',
      TOKEN_MONITOR_NEWAPI_USER_ID: '12',
      TOKEN_MONITOR_NEWAPI_API_KEY: 'api-key'
    }
  }), [{
    name: THIRD_PARTY_ENV_ACCOUNT_NAME,
    adapter: NEWAPI_ACCOUNT_ADAPTER,
    baseUrl: 'https://env.example',
    accessToken: 'access',
    userId: '12',
    enabled: true
  }]);

  assert.deepEqual(configuredAccounts({}, {
    env: {
      TOKEN_MONITOR_NEWAPI_BASE_URL: 'https://env.example/v1',
      TOKEN_MONITOR_NEWAPI_API_KEY: 'api-key'
    }
  }), [{
    name: THIRD_PARTY_ENV_ACCOUNT_NAME,
    adapter: NEWAPI_TOKEN_ADAPTER,
    baseUrl: 'https://env.example',
    apiKey: 'api-key',
    enabled: true
  }]);
});

test('scoped refresh fetches only the selected third-party profile', async () => {
  const calls = [];
  const [provider] = await fetchThirdPartyLimits({
    thirdPartyProfiles: {
      work: {
        adapter: NEWAPI_TOKEN_ADAPTER,
        baseUrl: 'https://work.example',
        apiKey: 'work'
      },
      personal: {
        adapter: NEWAPI_TOKEN_ADAPTER,
        baseUrl: 'https://personal.example',
        apiKey: 'personal'
      }
    },
    limitRefreshScope: { provider: 'thirdparty', accountName: 'personal' }
  }, {
    env: {},
    fetch: async (url, init) => {
      calls.push([url, init.headers.Authorization]);
      return url.endsWith(NEWAPI_STATUS_PATH)
        ? response(200, { data: { quota_per_unit: DEFAULT_QUOTA_PER_UNIT } })
        : response(200, {
          code: true,
          data: {
            total_available: 500_000,
            total_used: 0,
            unlimited_quota: false
          }
        });
    }
  });
  assert.equal(provider.accountName, 'personal');
  assert.ok(calls.every(([url]) => url.startsWith('https://personal.example')));
  assert.equal(calls.find(([url]) => url.endsWith(NEWAPI_TOKEN_USAGE_PATH))[1], 'Bearer personal');
});

test('an already-aborted third-party refresh propagates cancellation without a request', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    fetchThirdPartyLimits({
      thirdPartyProfiles: {
        work: {
          adapter: NEWAPI_TOKEN_ADAPTER,
          baseUrl: 'https://work.example',
          apiKey: 'key'
        }
      }
    }, {
      env: {},
      signal: controller.signal,
      fetch: async () => {
        throw new Error('should not fetch');
      }
    }),
    /cancelled/
  );
});
