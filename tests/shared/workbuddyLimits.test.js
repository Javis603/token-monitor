'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WORKBUDDY_DEFAULT_ENDPOINT,
  fetchWorkbuddyLimits,
  parseEnterpriseUsage,
  parsePersonalUsage,
  workbuddyAccountKey
} = require('../../src/shared/workbuddyLimits');
const { collectLimitsOnce } = require('../../src/shared/limitCollector');

const NOW = Date.parse('2026-08-09T10:00:00Z');

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
            },
            { CycleCapacitySizePrecise: 'invalid', CycleCapacityRemainPrecise: 10 }
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

test('parsePersonalUsage prefers the reported used amount and excludes non-active packages', () => {
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
      now: () => NOW,
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
  assert.equal(requests[0].init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(requests[0].init.headers['X-User-Id'], 'user-123');
  assert.equal(requests[0].init.headers['X-Domain'], 'copilot.tencent.com');
  assert.equal(requests[0].init.headers['X-Department-Info'], 'Engineering');
  assert.equal(requests[0].init.headers['Accept-Language'], 'en');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0],
    OnlyValidPeriod: true
  });
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
      now: () => NOW,
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
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.equal(requests[0].init.headers.Cookie, undefined);
  assert.equal(requests[0].init.headers['X-User-Id'], undefined);
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

test('limitCollector dispatches the WorkBuddy provider through the shared provider lane', async () => {
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
