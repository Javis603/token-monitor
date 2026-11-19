'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WORKBUDDY_DEFAULT_ENDPOINT,
  fetchWorkbuddyLimits,
  parseEnterpriseUsage,
  parsePersonalUsage,
  workbuddyAccountKey
} = require('../../src/shared/providers/workbuddy/limits');
const { collectLimitsOnce } = require('../../src/shared/limits/collector');

const NOW = Date.parse('2026-08-09T10:00:00Z');
const PERSONAL_REQUEST_NOW = new Date(2026, 7, 9, 10, 11, 12).getTime();
const EXPECTED_PERSONAL_REQUEST_BODY = {
  PageNumber: 1,
  PageSize: 100,
  ProductCode: 'p_tcaca',
  Status: [0, 3],
  PackageEndTimeRangeBegin: '2026-08-09 10:11:12',
  PackageEndTimeRangeEnd: '2127-07-16 10:11:12'
};

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test('parsePersonalUsage aggregates valid WorkBuddy resource packages', () => {
  const usage = parsePersonalUsage({
    data: {
      Response: {
        Data: {
          Accounts: [
            {
              Status: 0,
              CycleCapacitySizePrecise: '100',
              CycleCapacityRemainPrecise: '70',
              DeductionEndTime: '2026-09-01T00:00:00Z'
            },
            {
              Status: 0,
              CycleCapacitySizePrecise: 50,
              CycleCapacityRemainPrecise: 20,
              CycleRefreshTime: Date.parse('2026-08-20T00:00:00Z')
            },
            {
              Status: 3,
              CycleCapacitySizePrecise: 900,
              CycleCapacityRemainPrecise: 0
            }
          ]
        }
      }
    }
  });

  assert.equal(usage.used, 60);
  assert.equal(usage.limit, 150);
  assert.equal(usage.remaining, 90);
  assert.equal(usage.resourceCount, 2);
  assert.equal(usage.resetsAt, null);
  assert.equal(usage.window.kind, 'billing');
  assert.equal(usage.window.label, 'Credits');
  assert.equal(usage.window.metric, 'credits');
  assert.equal(usage.window.currency, 'CREDITS');
  assert.equal(usage.window.usedPercent, 40);
});

test('parsePersonalUsage prefers reported usage and excludes requested Status 3 history packages', () => {
  const usage = parsePersonalUsage({
    data: { Response: { Data: { Accounts: [
      {
        Status: 0,
        CycleCapacitySizePrecise: 100,
        CycleCapacityRemainPrecise: 68,
        CycleCapacityUsedPrecise: 31.25
      },
      {
        Status: 3,
        CycleCapacitySizePrecise: 500,
        CycleCapacityRemainPrecise: 0,
        CycleCapacityUsedPrecise: 500
      }
    ] } } }
  });

  assert.equal(usage.limit, 100);
  assert.equal(usage.remaining, 68);
  assert.equal(usage.used, 31.25);
  assert.equal(usage.resourceCount, 1);
});

test('parsePersonalUsage accepts the daemon response wrapper and keeps zero-resource accounts visible as configured', () => {
  const usage = parsePersonalUsage({ data: { data: { Response: { Data: { Accounts: [] } } } } });
  assert.equal(usage.resourceCount, 0);
  assert.equal(usage.window, null);
});

test('parsePersonalUsage distinguishes inactive packages from an unreadable active schema', () => {
  const inactive = parsePersonalUsage({
    data: { Response: { Data: { Accounts: [{
      Status: 3,
      CycleCapacitySizePrecise: 100,
      CycleCapacityRemainPrecise: 0
    }] } } }
  });
  assert.equal(inactive.resourceCount, 0);
  assert.equal(inactive.window, null);

  assert.throws(
    () => parsePersonalUsage({
      data: { Response: { Data: { Accounts: [{
        Status: 0,
        RenamedCapacity: 100,
        RenamedRemaining: 75
      }] } } }
    }),
    /unusable active resource packages/
  );
});

test('parsePersonalUsage fails closed when any active resource package has unusable quota data', () => {
  assert.throws(
    () => parsePersonalUsage({
      data: { Response: { Data: { Accounts: [
        {
          Status: 0,
          CycleCapacitySizePrecise: 100,
          CycleCapacityRemainPrecise: 60
        },
        {
          Status: 0,
          CycleCapacitySizePrecise: 'invalid',
          CycleCapacityRemainPrecise: 20
        },
        {
          Status: 3,
          CycleCapacitySizePrecise: 500,
          CycleCapacityRemainPrecise: 0
        }
      ] } } }
    }),
    /unusable active resource packages/
  );
});

test('fetchWorkbuddyLimits sends the private personal billing request without exposing credentials', async () => {
  const requests = [];
  const provider = await fetchWorkbuddyLimits(
    {
      workbuddyAccessToken: 'fixture-access-token',
      workbuddyUserId: 'user-123',
      workbuddyDomain: 'copilot.tencent.com',
      workbuddyDepartmentInfo: 'Engineering',
      workbuddyLocale: 'en'
    },
    {
      env: {},
      now: () => PERSONAL_REQUEST_NOW,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return response({
          data: {
            Response: {
              Data: {
                Accounts: [{
                  CycleCapacitySizePrecise: 100,
                  CycleCapacityRemainPrecise: 76,
                  DeductionEndTime: '2026-09-01T00:00:00Z'
                }]
              }
            }
          }
        });
      }
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${WORKBUDDY_DEFAULT_ENDPOINT}/v2/billing/meter/get-user-resource`);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(requests[0].init.headers['X-User-Id'], 'user-123');
  assert.equal(requests[0].init.headers['X-Domain'], 'copilot.tencent.com');
  assert.equal(requests[0].init.headers['X-Department-Info'], 'Engineering');
  assert.equal(requests[0].init.headers['Accept-Language'], 'en');
  assert.deepEqual(JSON.parse(requests[0].init.body), EXPECTED_PERSONAL_REQUEST_BODY);
  assert.equal(provider.provider, 'workbuddy');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'api');
  assert.equal(provider.sourceDetail, 'unknown');
  assert.equal(provider.accountLabel, 'Personal');
  assert.match(provider.accountKey, /^sha256:/);
  assert.equal(provider.windows[0].remaining, 76);
  assert.equal(provider.windows[0].limit, 100);
  assert.equal(provider.windows[0].metric, 'credits');
  assert.equal(provider.windows[0].currency, 'CREDITS');
  assert.equal(provider.balance.amount, 76);
  assert.equal(provider.balance.currency, 'CREDITS');
  assert.equal(provider.balance.todaySpend, null);
  assert.equal(provider.balance.weekSpend, null);
  assert.equal(provider.balance.monthSpend, null);
  assert.equal(provider.balance.allTimeSpend, null);
  assert.equal(provider.balance.trackingSince, null);
  assert.equal(provider.balance.monthSinceTracking, false);
  assert.doesNotMatch(
    JSON.stringify(provider),
    /fixture-access-token|user-123|enterprise-456|Engineering|copilot\.tencent\.com/
  );
});

test('fetchWorkbuddyLimits uses the WorkBuddy app session without asking users for a token', async () => {
  const requests = [];
  const provider = await fetchWorkbuddyLimits(
    { workbuddyDesktopSessionEnabled: true },
    {
      env: {},
      now: () => PERSONAL_REQUEST_NOW,
      fetch: async () => { throw new Error('the local app fetch should be used'); },
      workbuddyFetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return response({
          data: {
            Response: {
              Data: {
                Accounts: [{
                  AccountId: 'browser-account-1',
                  CycleCapacitySizePrecise: 200,
                  CycleCapacityRemainPrecise: 125,
                  DeductionEndTime: '2026-09-01T00:00:00Z'
                }]
              }
            }
          }
        });
      }
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://copilot.tencent.com/v2/billing/meter/get-user-resource');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.equal(requests[0].init.headers.Cookie, undefined);
  assert.equal(requests[0].init.headers['X-User-Id'], undefined);
  assert.deepEqual(JSON.parse(requests[0].init.body), EXPECTED_PERSONAL_REQUEST_BODY);
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'local');
  assert.equal(provider.sourceDetail, 'app');
  assert.equal(provider.accountLabel, 'Personal');
  assert.equal(provider.windows[0].remaining, 125);
  assert.equal(provider.balance.currency, 'CREDITS');
  assert.match(provider.accountKey, /^sha256:/);
  assert.doesNotMatch(JSON.stringify(provider), /browser-account-1|copilot\.tencent\.com/);
});

test('fetchWorkbuddyLimits reads explicit environment credentials and supports enterprise billing', async () => {
  const requests = [];
  const provider = await fetchWorkbuddyLimits({}, {
    env: {
      TOKEN_MONITOR_WORKBUDDY_ACCESS_TOKEN: 'env-token',
      TOKEN_MONITOR_WORKBUDDY_USER_ID: 'user-123',
      TOKEN_MONITOR_WORKBUDDY_ENTERPRISE_ID: 'enterprise-456'
    },
    now: () => NOW,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return response({ data: { data: { limitNum: 100, credit: 37, cycleResetTime: '2026-09-01T00:00:00Z' } } });
    }
  });

  assert.equal(requests[0].url, 'https://copilot.tencent.com/v2/billing/meter/get-enterprise-user-usage');
  assert.equal(requests[0].init.headers['X-Enterprise-Id'], 'enterprise-456');
  assert.equal(requests[0].init.headers['X-Tenant-Id'], 'enterprise-456');
  assert.deepEqual(JSON.parse(requests[0].init.body), {});
  assert.equal(provider.accountLabel, 'Enterprise');
  assert.equal(provider.windows[0].used, 37);
  assert.equal(provider.windows[0].remaining, 63);
  assert.equal(provider.windows[0].limit, 100);
  assert.equal(provider.windows[0].metric, 'credits');
  assert.equal(provider.windows[0].currency, 'CREDITS');
  assert.equal(provider.windows[0].resetsAt, '2026-09-01T00:00:00.000Z');
  assert.equal(provider.balance.amount, 63);
});

test('parseEnterpriseUsage preserves unlimited enterprise plans without inventing a denominator', () => {
  const usage = parseEnterpriseUsage({ data: { limitNum: -1, credit: 999, cycleResetTime: 1780272000000 } });
  assert.equal(usage.limit, null);
  assert.equal(usage.remaining, null);
  assert.equal(usage.window.showMeter, false);
  assert.equal(usage.window.detail, 'unlimited');
  assert.equal(usage.window.used, 999);
  assert.equal(usage.window.resetsAt, '2026-06-01T00:00:00.000Z');
});

test('parseEnterpriseUsage rejects a limit without a reported usage value', () => {
  assert.throws(
    () => parseEnterpriseUsage({ data: { limitNum: 100 } }),
    /no usage value/
  );
});

test('parseEnterpriseUsage rejects unknown negative limit sentinels', () => {
  assert.throws(
    () => parseEnterpriseUsage({ data: { limitNum: -2, credit: 0 } }),
    /invalid limitNum/
  );
});

test('parseEnterpriseUsage rejects negative reported usage', () => {
  assert.throws(
    () => parseEnterpriseUsage({ data: { limitNum: 100, credit: -1 } }),
    /invalid usage value/
  );
});

test('fetchWorkbuddyLimits fails closed when an enterprise response omits usage', async () => {
  const provider = await fetchWorkbuddyLimits({}, {
    env: {
      TOKEN_MONITOR_WORKBUDDY_ACCESS_TOKEN: 'env-token',
      TOKEN_MONITOR_WORKBUDDY_ENTERPRISE_ID: 'enterprise-456'
    },
    now: () => NOW,
    fetch: async () => response({ data: { limitNum: 100 } })
  });

  assert.equal(provider.status, 'unavailable');
  assert.deepEqual(provider.windows, []);
  assert.equal(provider.balance, null);
});

test('fetchWorkbuddyLimits fails closed for missing credentials and private endpoint errors', async () => {
  let called = false;
  const missing = await fetchWorkbuddyLimits({}, {
    env: {},
    fetch: async () => { called = true; return response({}); }
  });
  assert.equal(missing.status, 'notConfigured');
  assert.equal(called, false);

  const unauthorized = await fetchWorkbuddyLimits({ workbuddyAccessToken: 'fixture-token' }, {
    env: {},
    now: () => NOW,
    fetch: async () => response({ error: 'private detail' }, 401)
  });
  assert.equal(unauthorized.status, 'unauthorized');
  assert.equal(JSON.stringify(unauthorized).includes('private detail'), false);
});

test('fetchWorkbuddyLimits rejects unsuccessful application codes without exposing response details', async () => {
  const provider = await fetchWorkbuddyLimits({ workbuddyAccessToken: 'fixture-token' }, {
    env: {},
    now: () => NOW,
    fetch: async () => response({ code: 401, message: 'private session detail' })
  });
  assert.equal(provider.status, 'unauthorized');
  assert.doesNotMatch(JSON.stringify(provider), /private session detail/);

  for (const code of [0, 200, '0', '200']) {
    const accepted = await fetchWorkbuddyLimits({ workbuddyAccessToken: 'fixture-token' }, {
      env: {},
      now: () => NOW,
      fetch: async () => response({ code, data: { Response: { Data: { Accounts: [] } } } })
    });
    assert.equal(accepted.status, 'ok');
  }
});

test('WorkBuddy always uses the official production billing endpoint', async () => {
  const requests = [];
  await fetchWorkbuddyLimits({ workbuddyAccessToken: 'fixture-token' }, {
    env: {},
    now: () => NOW,
    fetch: async (url) => {
      requests.push(String(url));
      return response({ data: { Response: { Data: { Accounts: [] } } } });
    }
  });
  assert.deepEqual(requests, [`${WORKBUDDY_DEFAULT_ENDPOINT}/v2/billing/meter/get-user-resource`]);
});

test('WorkBuddy account identity prefers authentication identity over response accountId', () => {
  assert.equal(
    workbuddyAccountKey('token-a', 'user-1', '', 'response-a'),
    workbuddyAccountKey('token-b', 'user-1', '', 'response-b')
  );
  assert.equal(
    workbuddyAccountKey('token-a', 'user-1', 'enterprise-1', 'response-a'),
    workbuddyAccountKey('token-b', 'user-1', 'enterprise-1', 'response-b')
  );
  assert.notEqual(
    workbuddyAccountKey('token-a', 'user-1', 'enterprise-1', 'response-a'),
    workbuddyAccountKey('token-a', 'user-1', 'enterprise-2', 'response-a')
  );
});

test('WorkBuddy account identity falls back deterministically from response accountId to token and local app', () => {
  assert.equal(
    workbuddyAccountKey('token-a', '', '', 'response-a'),
    workbuddyAccountKey('token-b', '', '', 'response-a')
  );
  assert.notEqual(
    workbuddyAccountKey('token-a', '', '', ''),
    workbuddyAccountKey('token-b', '', '', '')
  );
  assert.equal(workbuddyAccountKey('', '', '', ''), workbuddyAccountKey('', '', '', ''));
});

test('WorkBuddy Local App is disabled outside the desktop provider lane and does not call its transport', async () => {
  let called = false;
  const provider = await fetchWorkbuddyLimits({}, {
    env: {},
    workbuddyDesktopSessionEnabled: false,
    workbuddyFetch: async () => {
      called = true;
      return response({});
    }
  });
  assert.equal(provider.status, 'notConfigured');
  assert.equal(called, false);
});

test('WorkBuddy Local App reports unsupported desktop platforms without reading a session or requesting billing', async () => {
  let called = false;
  const provider = await fetchWorkbuddyLimits({
    workbuddyDesktopSessionSupported: false,
    workbuddyDesktopSessionEnabled: false
  }, {
    env: {},
    workbuddyFetch: async () => {
      called = true;
      return response({});
    }
  });

  assert.equal(provider.status, 'unavailable');
  assert.equal(provider.source, 'local');
  assert.equal(provider.sourceDetail, 'app');
  assert.equal(called, false);
});

test('the limits collector dispatches the WorkBuddy provider through the shared provider lane', async () => {
  const summary = await collectLimitsOnce(
    { limitsEnabled: true, limitProviders: 'workbuddy', workbuddyAccessToken: 'fixture-token' },
    {
      env: {},
      now: () => NOW,
      fetch: async () => response({
        data: { Response: { Data: { Accounts: [{ CycleCapacitySizePrecise: 20, CycleCapacityRemainPrecise: 15 }] } } }
      })
    }
  );

  assert.deepEqual(summary.providers.map((provider) => provider.provider), ['workbuddy']);
  assert.equal(summary.providers[0].windows[0].remaining, 15);
  assert.equal(summary.providers[0].balance.currency, 'CREDITS');
});

// The app owns the credential and sealed it, so signing in again cannot change
// the outcome. The row has to name that instead of reusing the sign-in prompt.
test('fetchWorkbuddyLimits names an app-sealed credential instead of asking for a sign-in', async () => {
  let requests = 0;
  const provider = await fetchWorkbuddyLimits(
    {
      workbuddyDesktopSessionEnabled: true,
      workbuddyLocalSessionReason: 'encrypted'
    },
    {
      env: {},
      workbuddyFetch: async () => {
        requests += 1;
        return response({});
      }
    }
  );

  assert.equal(requests, 0);
  assert.equal(provider.status, 'notConfigured');
  assert.equal(provider.actionRequired, 'appSessionEncrypted');
  assert.equal(provider.source, 'local');
  assert.equal(provider.sourceDetail, 'app');
  assert.doesNotMatch(JSON.stringify(provider), /encrypted"|envelope|eyJ/);
});

test('other WorkBuddy session read reasons keep the existing sign-in row', async () => {
  const provider = await fetchWorkbuddyLimits(
    {
      workbuddyDesktopSessionEnabled: true,
      workbuddyLocalSessionReason: 'absent'
    },
    {
      env: {},
      workbuddyFetch: async () => {
        throw Object.assign(new Error('WorkBuddy app sign-in is required'), { status: 'notConfigured' });
      }
    }
  );

  assert.equal(provider.status, 'notConfigured');
  assert.equal(Object.hasOwn(provider, 'actionRequired'), false);
});

test('a sealed app credential never outranks the explicit WorkBuddy billing token', async () => {
  const provider = await fetchWorkbuddyLimits(
    {
      workbuddyAccessToken: 'explicit-token',
      workbuddyUserId: 'user-1',
      workbuddyDesktopSessionEnabled: true,
      workbuddyLocalSessionReason: 'encrypted'
    },
    {
      env: {},
      fetch: async () => response({ data: { Response: { Data: { Accounts: [] } } } })
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(Object.hasOwn(provider, 'actionRequired'), false);
});

test('the sealed-credential hint stays inside the desktop provider lane', async () => {
  let requests = 0;
  const provider = await fetchWorkbuddyLimits(
    {
      workbuddyDesktopSessionEnabled: false,
      workbuddyLocalSessionReason: 'encrypted'
    },
    {
      env: {},
      fetch: async () => {
        requests += 1;
        return response({});
      }
    }
  );

  assert.equal(requests, 0);
  assert.equal(provider.status, 'notConfigured');
  assert.equal(Object.hasOwn(provider, 'actionRequired'), false);
});

function managedAccount(id, realm = 'cn', extra = {}) {
  const account = { id, realm, userId: id, enterpriseId: '', accountName: 'Same name',
    domain: realm === 'ai' ? 'www.workbuddy.ai' : 'www.codebuddy.cn', enabled: true, ...extra };
  account.accountKey = workbuddyAccountKey(account);
  return account;
}

function quotaResponse() {
  return response({ code: 0, data: { Accounts: [{ Status: 0,
    CycleCapacitySizePrecise: 100, CycleCapacityRemainPrecise: 70 }] } });
}

test('managed WorkBuddy identities match OAuth keys and preserve existing CN hashes', () => {
  const oauth = require('../../src/shared/providers/workbuddy/oauth');
  for (const realm of ['cn', 'ai']) {
    for (const enterpriseId of ['', 'enterprise']) {
      const account = managedAccount('user', realm, { enterpriseId });
      assert.equal(workbuddyAccountKey(account), oauth.workbuddyAccountKey(account));
      if (realm === 'cn') assert.equal(account.accountKey, workbuddyAccountKey('token', 'user', enterpriseId));
    }
  }
  assert.notEqual(workbuddyAccountKey(managedAccount('user', 'ai')), workbuddyAccountKey(managedAccount('user')));
});

test('managed WorkBuddy accounts collect independently on Linux and preserve failure identities', async () => {
  const accounts = ['ok', 'missing', 'invalid', 'offline', 'limited', 'timeout'].map((id) => managedAccount(id));
  const calls = [];
  const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: accounts,
    workbuddyDesktopSessionSupported: false }, { env: {}, workbuddyFetchTimeoutMs: 20,
    resolveWorkbuddyManagedCredential: async (account, { signal, forceRefresh }) => {
      calls.push(account.id);
      assert.equal(forceRefresh, false);
      assert.ok(signal instanceof AbortSignal);
      if (account.id === 'timeout') return new Promise(() => {});
      const status = { missing: 'notConfigured', invalid: 'unauthorized', offline: 'unavailable', limited: 'sourceRateLimited' }[account.id];
      if (status) throw Object.assign(new Error('secret fixture'), { status });
      return { accessToken: 'private-token', refreshToken: 'private-refresh' };
    }, fetch: async () => quotaResponse() });
  assert.deepEqual(calls, accounts.map((account) => account.id));
  assert.deepEqual(rows.map((row) => row.status), ['ok', 'notConfigured', 'unauthorized', 'unavailable', 'sourceRateLimited', 'unavailable']);
  assert.deepEqual(rows.map((row) => row.accountKey), accounts.map((account) => account.accountKey));
  assert.ok(rows.every((row) => row.sourceDetail === 'managed'));
  assert.doesNotMatch(JSON.stringify(rows), /private-token|private-refresh|secret fixture/);
});

test('WorkBuddy target refresh uses exact accountId/accountKey despite identical names', async () => {
  const accounts = [managedAccount('a'), managedAccount('b')];
  const calls = [];
  const deps = { env: {}, resolveWorkbuddyManagedCredential: async (account) => {
    calls.push(account.id); return { accessToken: 'token' };
  }, fetch: async () => quotaResponse() };
  for (const selector of [{ accountId: 'b' }, { accountKey: accounts[1].accountKey },
    { accountId: 'b', accountKey: accounts[1].accountKey }]) {
    calls.length = 0;
    const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: accounts,
      limitRefreshScope: { provider: 'workbuddy', ...selector } }, deps);
    assert.deepEqual(calls, ['b']);
    assert.equal(rows.length, 1);
  }
  for (const selector of [{ accountName: 'Same name' }, { id: 'b' }, { managedAccountId: 'b' }, { accountId: 'Same name' },
    { accountId: 'a', accountKey: accounts[1].accountKey }]) {
    calls.length = 0;
    assert.deepEqual(await fetchWorkbuddyLimits({ workbuddyManagedAccounts: accounts,
      limitRefreshScope: { provider: 'workbuddy', ...selector } }, deps), []);
    assert.deepEqual(calls, []);
  }
  calls.length = 0;
  await fetchWorkbuddyLimits({ workbuddyManagedAccounts: accounts,
    limitRefreshScope: { provider: 'workbuddy' } }, deps);
  assert.deepEqual(calls, ['a', 'b']);
});

test('WorkBuddy managed accounts suppress duplicate local sessions even when disabled or missing credentials', async () => {
  const account = managedAccount('user');
  const local = { ...account, authenticated: true, accountType: 'personal' };
  let localCalls = 0;
  const deps = { env: {}, workbuddyFetch: async () => { localCalls += 1; return quotaResponse(); } };
  const config = { workbuddyDesktopSessionEnabled: true, workbuddyLocalSessions: [local],
    workbuddyManagedAccounts: [account] };
  const missing = await fetchWorkbuddyLimits(config, deps);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].status, 'notConfigured');
  assert.equal(missing[0].accountKey, account.accountKey);
  assert.equal(localCalls, 0);
  const disabled = await fetchWorkbuddyLimits({ ...config,
    workbuddyManagedAccounts: [{ ...account, enabled: false }] }, deps);
  assert.deepEqual(disabled, []);
  assert.equal(localCalls, 0);
  const legacy = await fetchWorkbuddyLimits({ workbuddyDesktopSessionEnabled: true,
    workbuddyUserId: account.userId, workbuddyManagedAccounts: [{ ...account, enabled: false }] }, deps);
  assert.deepEqual(legacy, []);
  assert.deepEqual(await fetchWorkbuddyLimits({ workbuddyManagedAccounts: [{ ...account, enabled: false }] }, deps), []);
});

test('WorkBuddy combines distinct local/managed realms and retains encrypted local row', async () => {
  const managed = managedAccount('user');
  const localAi = { ...managedAccount('user', 'ai'), authenticated: true, accountType: 'personal' };
  const localCn = { ...managedAccount('encrypted'), authenticated: false, reason: 'encrypted' };
  const requests = [];
  const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: [managed], workbuddyDesktopSessionEnabled: true,
    workbuddyLocalSessions: [localAi, localCn] }, { env: {},
    resolveWorkbuddyManagedCredential: async () => ({ accessToken: 'managed-token' }),
    fetch: async (url, init) => { requests.push({ url, init }); return quotaResponse(); },
    workbuddyFetch: async (url, init, expected) => {
      assert.equal(expected.realm, 'ai');
      assert.equal(expected.accountKey, localAi.accountKey);
      assert.equal(init.headers.Authorization, undefined);
      requests.push({ url, init }); return quotaResponse();
    } });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.status), ['ok', 'ok', 'notConfigured']);
  assert.equal(rows[2].actionRequired, 'appSessionEncrypted');
  assert.equal(rows[2].accountKey, localCn.accountKey);
  assert.deepEqual(requests.map((request) => request.url).sort(), [
    'https://copilot.tencent.com/v2/billing/meter/get-user-resource',
    'https://www.workbuddy.ai/billing/meter/get-user-resource'
  ]);
});

test('WorkBuddy managed 401 refresh awaits persisted rotation and retries with the current token once', async () => {
  const account = managedAccount('user');
  for (const application401 of [false, true]) {
    const events = [];
    let persisted = false;
    const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: [account] }, { env: {},
      resolveWorkbuddyManagedCredential: async (_, { forceRefresh }) => {
        events.push(forceRefresh ? 'refresh' : 'resolve');
        if (forceRefresh) { await Promise.resolve(); persisted = true; events.push('persist'); }
        return { accessToken: forceRefresh ? 'rotated-token' : 'old-token', refreshToken: 'rotated-refresh' };
      }, fetch: async (_, init) => {
        events.push(init.headers.Authorization);
        if (init.headers.Authorization === 'Bearer old-token') {
          return application401 ? response({ code: 401 }) : response({}, 401);
        }
        assert.equal(persisted, true);
        return quotaResponse();
      } });
    assert.equal(rows[0].status, 'ok');
    assert.deepEqual(events, ['resolve', 'Bearer old-token', 'refresh', 'persist', 'Bearer rotated-token']);
    assert.equal(rows[0].accountKey, account.accountKey);
  }
});

test('WorkBuddy stops after one managed refresh and never treats transient billing failures as credential errors', async () => {
  const account = managedAccount('user');
  for (const status of [401, 403, 429, 503]) {
    let renewals = 0;
    let requests = 0;
    const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: [account] }, { env: {},
      resolveWorkbuddyManagedCredential: async (_, { forceRefresh }) => {
        if (forceRefresh) renewals += 1;
        return { accessToken: 'token' };
      }, fetch: async () => { requests += 1; return response({}, status); } });
    assert.equal(renewals, status === 401 ? 1 : 0);
    assert.equal(requests, status === 401 ? 2 : 1);
    assert.equal(rows[0].status, status === 429 ? 'sourceRateLimited' : status === 503 ? 'unavailable' : 'unauthorized');
  }
  let requests = 0;
  const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: [account] }, { env: {},
    resolveWorkbuddyManagedCredential: async (_, { forceRefresh }) => {
      if (forceRefresh) throw Object.assign(new Error('persist failed'), { status: 'unavailable' });
      return { accessToken: 'token' };
    }, fetch: async () => { requests += 1; return response({}, 401); } });
  assert.equal(rows[0].status, 'unavailable');
  assert.equal(requests, 1);
});

test('WorkBuddy AI billing falls back only on HTTP 404 and never crosses realms', async () => {
  const account = managedAccount('user', 'ai');
  for (const status of [404, 401, 403, 429, 503]) {
    const requests = [];
    const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: [account] }, { env: {},
      resolveWorkbuddyManagedCredential: async () => ({ accessToken: 'ai-token', domain: account.domain }),
      fetch: async (url, init) => {
        requests.push(url);
        assert.equal(init.credentials, 'omit');
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers.Authorization, 'Bearer ai-token');
        assert.equal(init.headers.Host, undefined);
        assert.equal(init.headers.Referer, undefined);
        return requests.length === 1 ? response({}, status) : quotaResponse();
      } });
    assert.ok(requests.every((url) => url.startsWith('https://www.workbuddy.ai/')));
    if (status === 404) {
      assert.deepEqual(requests, ['https://www.workbuddy.ai/billing/meter/get-user-resource',
        'https://www.workbuddy.ai/v2/billing/meter/get-user-resource']);
      assert.equal(rows[0].status, 'ok');
    } else assert.ok(requests.every((url) => url === 'https://www.workbuddy.ai/billing/meter/get-user-resource'));
  }
  for (const [realm, domain] of [['cn', 'www.workbuddy.ai'], ['ai', 'www.codebuddy.cn'], ['ai', 'attacker.example']]) {
    const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: [managedAccount('user', realm)] }, {
      env: {}, resolveWorkbuddyManagedCredential: async () => ({ accessToken: 'token', domain }),
      fetch: async () => { throw new Error('realm mismatch must not dispatch'); }
    });
    assert.equal(rows[0].status, 'unavailable');
  }
});

test('managed WorkBuddy requests observe cancellation and bounded billing deadlines', async () => {
  let billingSignal;
  const account = managedAccount('user');
  const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: [account] }, { env: {}, workbuddyFetchTimeoutMs: 10,
    resolveWorkbuddyManagedCredential: async () => ({ accessToken: 'token' }),
    fetch: async (_, init) => { billingSignal = init.signal; return new Promise(() => {}); } });
  assert.equal(rows[0].status, 'unavailable');
  assert.equal(billingSignal.aborted, true);
  const controller = new AbortController();
  controller.abort();
  const canceled = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: [account] }, { env: {}, signal: controller.signal,
    resolveWorkbuddyManagedCredential: async () => { throw new Error('must not resolve'); } });
  assert.equal(canceled[0].status, 'unavailable');
});

test('all WorkBuddy stable rows carry their billing realm as region', async () => {
  for (const realm of ['cn', 'ai']) {
    for (const status of ['ok', 'notConfigured', 'unauthorized', 'unavailable', 'sourceRateLimited']) {
      const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: [managedAccount('user', realm)] }, { env: {},
        resolveWorkbuddyManagedCredential: async () => {
          if (status !== 'ok') throw Object.assign(new Error('fixture'), { status });
          return { accessToken: 'token' };
        }, fetch: async () => quotaResponse() });
      assert.equal(rows[0].status, status);
      assert.equal(rows[0].region, realm);
    }
    const encrypted = await fetchWorkbuddyLimits({ workbuddyDesktopSessionEnabled: true,
      workbuddyRealm: realm, workbuddyLocalSessionReason: 'encrypted' }, { env: {} });
    assert.equal(encrypted.region, realm);
  }
  assert.equal((await fetchWorkbuddyLimits({}, { env: {} })).region, 'cn');
  assert.equal((await fetchWorkbuddyLimits({ workbuddyDesktopSessionSupported: false }, { env: {} })).region, 'cn');
});

test('WorkBuddy full discovery emits explicit removals and partial/scoped discovery keeps known identities', async () => {
  const a = managedAccount('a');
  const b = managedAccount('b', 'ai');
  const prior = [
    { provider: 'workbuddy', sourceDetail: 'managed', accountKey: a.accountKey, region: 'cn' },
    { provider: 'workbuddy', sourceDetail: 'app', accountKey: b.accountKey, region: 'ai' }
  ];
  const base = { previousLimits: { providers: prior }, workbuddyManagedAccounts: [], workbuddyDesktopSessionEnabled: true,
    workbuddyLocalSessions: [{ realm: 'cn', authenticated: false, reason: 'absent' },
      { realm: 'ai', authenticated: false, reason: 'absent' }] };
  const deps = { env: {}, workbuddyFetch: async () => { throw Object.assign(new Error('absent'), { status: 'notConfigured' }); } };
  const full = await fetchWorkbuddyLimits(base, deps);
  assert.deepEqual(full.filter((row) => row.removed).map((row) => row.accountKey), [a.accountKey, b.accountKey]);
  for (const config of [
    { ...base, limitRefreshScope: { provider: 'workbuddy', accountKey: a.accountKey } },
    { ...base, workbuddyManagedAccounts: undefined, workbuddyLocalSessionsComplete: false },
    { ...base, workbuddyManagedAccounts: undefined,
      workbuddyLocalSessions: [{ realm: 'ai', authenticated: false, reason: 'malformed' }] },
    { ...base, workbuddyManagedAccounts: undefined,
      workbuddyLocalSessions: [{ realm: 'ai', authenticated: false, reason: 'encrypted' }] }
  ]) {
    const rows = await fetchWorkbuddyLimits(config, deps);
    assert.equal((Array.isArray(rows) ? rows : [rows]).some((row) => row.removed), false);
  }
  const failed = await fetchWorkbuddyLimits({ ...base, workbuddyManagedAccounts: [a],
    workbuddyLocalSessions: [{ ...b, authenticated: true, accountType: 'personal' }] }, {
    env: {}, resolveWorkbuddyManagedCredential: async () => { throw Object.assign(new Error('missing'), { status: 'notConfigured' }); },
    workbuddyFetch: async () => { throw Object.assign(new Error('offline'), { status: 'unavailable' }); }
  });
  assert.equal(failed.some((row) => row.removed), false);
  assert.deepEqual(failed.map((row) => row.accountKey), [a.accountKey, b.accountKey]);
  const disabled = await fetchWorkbuddyLimits({ ...base, workbuddyManagedAccounts: [{ ...a, enabled: false }],
    workbuddyLocalSessions: [{ ...a, authenticated: true }] }, deps);
  assert.ok(disabled.some((row) => row.removed && row.accountKey === a.accountKey));
});

test('WorkBuddy runtime retires removed rows only after complete discovery and one-shot drops markers', async () => {
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const account = managedAccount('runtime-local');
  let sessions = [{ ...account, authenticated: true, accountType: 'personal' }];
  const runtime = createLimitsRuntime({ limitProviders: ['workbuddy'] }, {
    autoStart: false, env: {}, providerPhysicalBoundMs: () => 1000,
    resolveConfigSnapshot: () => ({ workbuddyManagedAccounts: [], workbuddyDesktopSessionEnabled: true,
      workbuddyLocalSessions: sessions }),
    workbuddyFetch: async (_, __, expected) => {
      if (!expected.userId) throw Object.assign(new Error('unreadable'), { status: 'notConfigured' });
      return quotaResponse();
    }
  });
  try {
    await runtime.refresh({ provider: 'workbuddy' }, 'manual');
    assert.ok(runtime.getSnapshot().providers.some((row) => row.accountKey === account.accountKey));
    sessions = [{ realm: 'cn', authenticated: false, reason: 'malformed' }];
    await runtime.refresh({ provider: 'workbuddy' }, 'manual');
    assert.ok(runtime.getSnapshot().providers.some((row) => row.accountKey === account.accountKey));
    sessions = [{ realm: 'cn', authenticated: false, reason: 'absent' }];
    await runtime.refresh({ provider: 'workbuddy' }, 'manual');
    assert.equal(runtime.getSnapshot().providers.some((row) => row.accountKey === account.accountKey), false);
    assert.equal(runtime.getSnapshot().providers.some((row) => row.removed), false);
    const oneShot = await collectLimitsOnce({ limitsEnabled: true, limitProviders: ['workbuddy'], workbuddyManagedAccounts: [],
      previousLimits: { providers: [{ provider: 'workbuddy', accountKey: account.accountKey, sourceDetail: 'managed' }] } }, { env: {} });
    assert.equal(oneShot.providers.some((row) => row.removed), false);
    assert.equal(oneShot.providers.some((row) => row.accountKey === account.accountKey), false);
  } finally { runtime.stop(); }
});

test('managed enterprise billing with a Chinese department dispatches Fetch-compatible bound identity headers', async () => {
  const identity = { id: 'enterprise', realm: 'cn', userId: 'user', enterpriseId: 'enterprise',
    departmentInfo: '研发部', domain: 'www.codebuddy.cn', enabled: true };
  let dispatched = 0;
  const result = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: [identity] }, {
    env: {}, resolveWorkbuddyManagedCredential: async () => ({ accessToken: 'fixture-token', domain: identity.domain }),
    fetch: async (url, init) => {
      const request = new Request(url, init);
      assert.equal(request.headers.get('X-User-Id'), identity.userId);
      assert.equal(request.headers.get('X-Enterprise-Id'), identity.enterpriseId);
      assert.equal(request.headers.get('X-Department-Info'), null);
      dispatched++;
      return response({ data: { limitNum: 100, credit: 20 } });
    }
  });
  assert.equal(dispatched, 1);
  assert.equal(result[0].accountKey, workbuddyAccountKey(identity));
  assert.equal(result[0].status, 'ok');
});
