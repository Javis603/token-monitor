'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  qoderCookie,
  qoderSite,
  qoderUsageUrl,
  qoderUserPlanUrl,
  parseQoderPlanLabel,
  parseQoderUsage,
  fetchQoderLimits
} = require('../../src/shared/providers/qoder/limits');

test('qoderCookie reads settings before env and trims quoted cookies', () => {
  assert.equal(qoderCookie({ QODER_COOKIE: 'env-cookie' }, { qoderCookie: '  "settings-cookie"  ' }), 'settings-cookie');
  assert.equal(qoderCookie({ QODER_COOKIE: '  "env-cookie"  ' }), 'env-cookie');
  assert.equal(qoderCookie({ TOKEN_MONITOR_QODER_COOKIE: 'tm-cookie' }), 'tm-cookie');
  assert.equal(qoderCookie({}), '');
});

test('qoderSite maps global and China dashboard hosts', () => {
  assert.equal(qoderSite({ qoderSite: 'cn' }), 'cn');
  assert.equal(qoderSite({ qoderSite: 'china' }), 'cn');
  assert.equal(qoderSite({ qoderSite: 'https://qoder.com.cn/account/usage' }), 'cn');
  assert.equal(qoderSite({ qoderSite: 'global' }), 'global');
  assert.equal(qoderUsageUrl('cn'), 'https://qoder.com.cn/api/v2/me/usages/big_model_credits');
  assert.equal(qoderUserPlanUrl('cn'), 'https://qoder.com.cn/api/v1/me/userplan');
});

test('parseQoderPlanLabel maps official plan tiers to display labels', () => {
  assert.equal(parseQoderPlanLabel({ data: { plan_tier: 'PLAN_TIER_PRO_PLUS' } }), 'Pro+');
  assert.equal(parseQoderPlanLabel({ data: { subscription: { planTier: 'PLAN_TIER_ULTRA' } } }), 'Ultra');
  assert.equal(parseQoderPlanLabel({ plan_tier: 'PLAN_TIER_FREE' }), 'Community Edition');
  assert.equal(parseQoderPlanLabel({ data: { current_plan: { plan_tier: 'ORGANIZATION_PLAN_TIER_ENTERPRISE' } } }), 'Enterprise');
});

test('parseQoderUsage emits personal and team credits as separate windows', () => {
  const usage = parseQoderUsage({
    totalQuota: {
      quotaSummary: {
        usedValue: 25,
        limitValue: 100,
        remainingValue: 75,
        unit: 'credits'
      }
    },
    sharedQuota: {
      quotaSummary: {
        usedValue: 10,
        limitValue: 50,
        remainingValue: 40,
        unit: 'credits'
      }
    },
    nextResetAt: '2026-08-01T00:00:00Z'
  }, undefined, { planResetsAt: '2026-09-01T00:00:00.000Z' });

  assert.deepEqual(
    usage.windows.map(({ label, used, limit, remaining, resetsAt }) => ({
      label, used, limit, remaining, resetsAt
    })),
    [
      { label: 'Credits', used: 25, limit: 100, remaining: 75, resetsAt: '2026-08-01T00:00:00.000Z' },
      { label: 'Team credits', used: 10, limit: 50, remaining: 40, resetsAt: '2026-09-01T00:00:00.000Z' }
    ]
  );
  assert.equal(usage.windows[0].remainingPercent, 75);
  assert.equal(usage.windows[1].remainingPercent, 80);
});

test('parseQoderUsage accepts data-wrapped usage payloads', () => {
  const usage = parseQoderUsage({
    data: {
      total_quota: {
        quota_summary: {
          used_value: 42,
          limit_value: 100,
          remaining_value: 58,
          unit: 'credits'
        }
      },
      next_reset_at: 1780272000
    }
  });

  assert.deepEqual(
    usage.windows.map(({ label, used, limit, remaining, resetsAt }) => ({
      label, used, limit, remaining, resetsAt
    })),
    [{ label: 'Credits', used: 42, limit: 100, remaining: 58, resetsAt: '2026-06-01T00:00:00.000Z' }]
  );
});

test('parseQoderUsage omits allowances with no limit', () => {
  const usage = parseQoderUsage({
    totalQuota: { quotaSummary: { usedValue: 0, limitValue: 0, remainingValue: 0, unit: 'credits' } },
    sharedQuota: { quotaSummary: { usedValue: 0, limitValue: 0, remainingValue: 0, unit: 'credits' } }
  });
  assert.deepEqual(usage.windows, []);
});

test('fetchQoderLimits returns notConfigured without a cookie', async () => {
  const provider = await fetchQoderLimits({}, { env: {}, now: () => Date.parse('2026-07-06T00:00:00Z') });
  assert.equal(provider.provider, 'qoder');
  assert.equal(provider.source, 'web');
  assert.equal(provider.status, 'notConfigured');
});

const QODER_TEST_COOKIE = 'session=test-cookie';
const quota = (used, limit, remaining) => ({
  quota_summary: { used_value: used, limit_value: limit, remaining_value: remaining, unit: 'credits' }
});

for (const scenario of [
  {
    name: 'keeps personal and team credits as separate windows',
    personal: {
      data: {
        total_quota: quota(25, 100, 75),
        shared_quota: quota(9, 50, 41),
        next_reset_at: '2026-11-22T16:00:00Z'
      }
    },
    shared: { data: { shared_quota: quota(10, 50, 40), next_reset_at: '2026-12-01T00:00:00Z' } },
    expectedWindows: [
      { label: 'Credits', used: 25, limit: 100, remaining: 75, resetsAt: '2026-11-22T16:00:00.000Z' },
      { label: 'Team credits', used: 10, limit: 50, remaining: 40, resetsAt: '2026-12-01T00:00:00.000Z' }
    ]
  },
  {
    name: 'includes the member shared cap instead of the whole organization pool',
    personal: { total_quota: quota(0, 0, 0), nextResetAt: '2026-09-22T16:00:00Z' },
    shared: {
      shared_quota: quota(4478, 20000, 15522),
      organization_pool: { used_value: 7252788, limit_value: 300000000, remaining_value: 292747212 }
    },
    expectedWindows: [
      { label: 'Team credits', used: 4478, limit: 20000, remaining: 15522, resetsAt: null }
    ]
  },
  {
    name: 'preserves personal credits when no organization quota exists',
    personal: { total_quota: quota(20, 100, 80), nextResetAt: '2026-11-01T00:00:00Z' },
    sharedStatus: 404,
    expectedWindows: [
      { label: 'Credits', used: 20, limit: 100, remaining: 80, resetsAt: '2026-11-01T00:00:00.000Z' }
    ]
  },
  {
    name: 'treats a forbidden shared quota as a personal account',
    personal: { total_quota: quota(20, 100, 80), nextResetAt: '2026-11-01T00:00:00Z' },
    sharedStatus: 403,
    expectedWindows: [
      { label: 'Credits', used: 20, limit: 100, remaining: 80, resetsAt: '2026-11-01T00:00:00.000Z' }
    ]
  },
  {
    name: 'uses the plan renewal date when team credits carry no reset',
    personal: { total_quota: quota(0, 0, 0), nextResetAt: '2026-09-22T16:00:00Z' },
    shared: { shared_quota: quota(4478, 20000, 15522) },
    planResetAt: 1795363200000,
    expectedWindows: [
      { label: 'Team credits', used: 4478, limit: 20000, remaining: 15522, resetsAt: '2026-11-22T16:00:00.000Z' }
    ]
  },
  {
    name: 'does not report full remaining credits when the shared quota service fails',
    personal: { total_quota: quota(0, 0, 0) },
    sharedStatus: 503,
    expectedStatus: 'unavailable'
  },
  {
    name: 'retains last-good credits when the shared quota rejects the session',
    personal: { total_quota: quota(0, 0, 0) },
    sharedStatus: 401,
    expectedStatus: 'unavailable'
  },
  {
    name: 'keeps personal credits when the shared quota rejects the session',
    personal: { total_quota: quota(20, 100, 80), nextResetAt: '2026-11-01T00:00:00Z' },
    sharedStatus: 401,
    expectedWindows: [
      { label: 'Credits', used: 20, limit: 100, remaining: 80, resetsAt: '2026-11-01T00:00:00.000Z' }
    ]
  },
  {
    name: 'omits allowances with no limit',
    personal: { total_quota: quota(0, 0, 0) },
    shared: { shared_quota: quota(0, 0, 0) },
    expectedWindows: []
  },
]) {
  test(`fetchQoderLimits ${scenario.name}`, async () => {
    const provider = await fetchQoderLimits(
      { qoderCookie: QODER_TEST_COOKIE, qoderSite: 'cn' },
      {
        env: {},
        fetch: async (url, init) => {
          assert.equal(init.headers.Cookie, QODER_TEST_COOKIE);
          assert.equal(init.headers.Origin, 'https://qoder.com.cn');
          switch (String(url)) {
            case 'https://qoder.com.cn/api/v2/me/usages/big_model_credits':
              return new Response(JSON.stringify(scenario.personal));
            case 'https://qoder.com.cn/api/v1/me/organization-shared-usages/big_model_credits':
              return new Response(JSON.stringify(scenario.shared || {}), { status: scenario.sharedStatus || 200 });
            case 'https://qoder.com.cn/api/v1/me/userplan':
              return new Response(JSON.stringify({
                plan_tier: 'PLAN_TIER_TEAM',
                ...(scenario.planResetAt ? { next_refresh_date: scenario.planResetAt } : {})
              }));
            default:
              throw new Error(`Unexpected quota URL: ${url}`);
          }
        }
      }
    );
    assert.equal(provider.status, scenario.expectedStatus || 'ok');
    if (scenario.expectedStatus) {
      assert.deepEqual(provider.windows, []);
      return;
    }
    assert.deepEqual(
      provider.windows.map(({ label, used, limit, remaining, resetsAt }) => ({
        label, used, limit, remaining, resetsAt
      })),
      scenario.expectedWindows
    );
    for (const window of provider.windows) {
      assert.equal(window.remainingPercent, Number((100 - window.used / window.limit * 100).toFixed(3)));
    }
  });
}

test('fetchQoderLimits physically aborts a hung request within its configured bound', async () => {
  let signal;
  const provider = await fetchQoderLimits(
    { qoderCookie: 'session=hung' },
    {
      env: {},
      qoderFetchTimeoutMs: 5,
      fetch: async (_url, init) => {
        signal = init.signal;
        return new Promise(() => {});
      }
    }
  );

  assert.equal(provider.status, 'unavailable');
  assert.equal(signal.aborted, true);
});

test('fetchQoderLimits keeps the response body read inside the deadline', async () => {
  let signal;
  const provider = await fetchQoderLimits(
    { qoderCookie: 'session=hung-body' },
    {
      env: {},
      qoderFetchTimeoutMs: 5,
      fetch: async (_url, init) => {
        signal = init.signal;
        return {
          ok: true,
          status: 200,
          json: () => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          })
        };
      }
    }
  );

  assert.equal(provider.status, 'unavailable');
  assert.equal(signal.aborted, true);
});

// Exercise provider results through the runtime: a single fetch cannot prove
// that an incomplete reading preserves previously displayed quota windows.
for (const scenario of [
  { name: '401', status: 401, partialPersonal: true },
  { name: 'missing quota', body: {} },
  { name: 'invalid quota', body: { shared_quota: { quota_summary: { used_value: 'invalid', limit_value: 50 } } } },
  { name: 'null payload', body: null },
  { name: 'explicit zero quota', body: { shared_quota: quota(0, 0, 0) }, clearsTeam: true },
  { name: 'personal-only account', status: 404, clearsTeam: true }
]) {
  test(`Qoder runtime handles ${scenario.name} after a successful team reading`, async () => {
    const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
    let attempt = 0;
    let clock = Date.parse('2026-11-01T00:00:00Z');
    const runtime = createLimitsRuntime({ limitProviders: ['qoder'] }, {
      autoStart: false,
      now: () => clock,
      probeProvider: async () => {
        attempt += 1;
        return [await fetchQoderLimits({ qoderCookie: QODER_TEST_COOKIE }, {
          env: {},
          now: () => clock,
          fetch: async (url) => {
            if (url.includes('/organization-shared-usages/')) {
              return new Response(JSON.stringify(attempt === 1
                ? { shared_quota: quota(10, 50, 40) } : scenario.body ?? null),
              { status: attempt === 1 ? 200 : scenario.status || 200 });
            }
            if (url.endsWith('/userplan')) return new Response(JSON.stringify({ plan_tier: 'PLAN_TIER_TEAM' }));
            return new Response(JSON.stringify({ total_quota: quota(attempt === 1 ? 20 : 30, 100, attempt === 1 ? 80 : 70) }));
          }
        })];
      }
    });
    try {
      await runtime.refresh({ provider: 'qoder' }, 'credential-edit');
      const before = runtime.getSnapshot().providers[0];
      assert.deepEqual(before.windows.map((window) => window.label), ['Credits', 'Team credits']);
      clock += 60_000;
      await runtime.refresh({ provider: 'qoder' }, 'credential-edit');
      const after = runtime.getSnapshot().providers[0];
      assert.equal(after.status, scenario.clearsTeam ? 'ok' : 'unavailable');
      assert.equal(after.updatedAt, scenario.clearsTeam ? new Date(clock).toISOString() : before.updatedAt);
      assert.equal(after.windows.find((window) => window.label === 'Credits').used,
        scenario.partialPersonal || scenario.clearsTeam ? 30 : 20);
      if (scenario.clearsTeam) {
        assert.deepEqual(after.windows.map((window) => window.label), ['Credits']);
      } else {
        assert.deepEqual(after.windows.find((window) => window.label === 'Team credits'),
          before.windows.find((window) => window.label === 'Team credits'));
      }
      assert.equal(Object.hasOwn(after, 'invalidateCachedWindowLabels'), false);
    } finally {
      runtime.stop();
    }
  });
}
