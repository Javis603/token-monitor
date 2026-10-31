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

test('parseQoderUsage merges personal and shared big-model credit quotas', () => {
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
  });

  assert.equal(usage.usedCredits, 35);
  assert.equal(usage.totalCredits, 150);
  assert.equal(usage.remainingCredits, 115);
  assert.equal(usage.usagePercentage, 35 / 150 * 100);
  assert.equal(usage.resetsAt, '2026-08-01T00:00:00.000Z');
  assert.equal(usage.window.kind, 'billing');
  assert.equal(usage.window.label, 'Credits');
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

  assert.equal(usage.usedCredits, 42);
  assert.equal(usage.totalCredits, 100);
  assert.equal(usage.remainingCredits, 58);
  assert.equal(usage.resetsAt, '2026-06-01T00:00:00.000Z');
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
    name: 'includes the member shared cap instead of the whole organization pool',
    personal: { total_quota: quota(0, 0, 0), nextResetAt: '2026-09-22T16:00:00Z' },
    shared: {
      shared_quota: quota(4478, 20000, 15522),
      organization_pool: { used_value: 7252788, limit_value: 300000000, remaining_value: 292747212 }
    },
    expected: { used: 4478, limit: 20000, remaining: 15522, resetsAt: null }
  },
  {
    name: 'combines personal and separately fetched shared credits without double counting',
    personal: {
      data: {
        total_quota: quota(25, 100, 75),
        shared_quota: quota(9, 50, 41),
        next_reset_at: '2026-11-22T16:00:00Z'
      }
    },
    shared: { data: { shared_quota: quota(10, 50, 40) } },
    expected: { used: 35, limit: 150, remaining: 115, resetsAt: '2026-11-22T16:00:00.000Z' }
  },
  {
    name: 'preserves personal credits when no organization quota exists',
    personal: { total_quota: quota(20, 100, 80), nextResetAt: '2026-11-01T00:00:00Z' },
    sharedStatus: 404,
    expected: { used: 20, limit: 100, remaining: 80, resetsAt: '2026-11-01T00:00:00.000Z' }
  },
  {
    name: 'treats a forbidden shared quota as a personal account',
    personal: { total_quota: quota(20, 100, 80), nextResetAt: '2026-11-01T00:00:00Z' },
    sharedStatus: 403,
    expected: { used: 20, limit: 100, remaining: 80, resetsAt: '2026-11-01T00:00:00.000Z' }
  },
  {
    name: 'uses the plan renewal date when the shared quota carries no reset',
    personal: { total_quota: quota(0, 0, 0), nextResetAt: '2026-09-22T16:00:00Z' },
    shared: { shared_quota: quota(4478, 20000, 15522) },
    planResetAt: 1795363200000,
    expected: { used: 4478, limit: 20000, remaining: 15522, resetsAt: '2026-11-22T16:00:00.000Z' }
  },
  {
    name: 'does not report full remaining credits when the shared quota service fails',
    personal: { total_quota: quota(0, 0, 0) },
    sharedStatus: 503,
    expectedStatus: 'unavailable'
  },
  {
    name: 'reports an expired shared quota credential instead of successful zero usage',
    personal: { total_quota: quota(0, 0, 0) },
    sharedStatus: 401,
    expectedStatus: 'unauthorized'
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
    const window = provider.windows[0];
    const { used, limit, remaining, resetsAt } = scenario.expected;
    assert.deepEqual(
      { used: window.used, limit: window.limit, remaining: window.remaining, resetsAt: window.resetsAt },
      { used, limit, remaining, resetsAt }
    );
    assert.equal(window.remainingPercent, Number((100 - used / limit * 100).toFixed(3)));
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
