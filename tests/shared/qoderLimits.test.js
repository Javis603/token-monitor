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
} = require('../../src/shared/qoderLimits');

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

test('fetchQoderLimits requests the selected site with the dashboard cookie', async () => {
  const requests = [];
  const provider = await fetchQoderLimits(
    { qoderCookie: 'session=abc', qoderSite: 'cn' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith('/api/v1/me/userplan')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: { plan_tier: 'PLAN_TIER_PRO_PLUS' }
            })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_quota: {
              quota_summary: {
                used_value: 20,
                limit_value: 100,
                remaining_value: 80,
                usage_percentage: 20,
                unit: 'credits'
              }
            }
          })
        };
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.region, 'cn');
  assert.equal(provider.accountLabel, 'Pro+');
  assert.equal(provider.windows.length, 1);
  assert.equal(requests[0].url, 'https://qoder.com.cn/api/v2/me/usages/big_model_credits');
  assert.equal(requests[1].url, 'https://qoder.com.cn/api/v1/me/userplan');
  assert.equal(requests[0].init.headers.Cookie, 'session=abc');
  assert.equal(requests[0].init.headers.Origin, 'https://qoder.com.cn');
});
