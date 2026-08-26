'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  qoderCookie,
  qoderAccessToken,
  qoderSite,
  qoderUsageUrl,
  qoderUserPlanUrl,
  qoderApiQuotaUrl,
  qoderApiPlanUrl,
  parseQoderPlanLabel,
  parseQoderUsage,
  parseQoderApiUsage,
  fetchQoderLimits
} = require('../../src/shared/qoderLimits');

test('qoderCookie reads settings before env and trims quoted cookies', () => {
  assert.equal(qoderCookie({ QODER_COOKIE: 'env-cookie' }, { qoderCookie: '  "settings-cookie"  ' }), 'settings-cookie');
  assert.equal(qoderCookie({ QODER_COOKIE: '  "env-cookie"  ' }), 'env-cookie');
  assert.equal(qoderCookie({ TOKEN_MONITOR_QODER_COOKIE: 'tm-cookie' }), 'tm-cookie');
  assert.equal(qoderCookie({}), '');
});

test('qoderAccessToken reads settings before env and accepts a Bearer prefix', () => {
  assert.equal(qoderAccessToken({ QODER_ACCESS_TOKEN: 'env-token' }, { qoderAccessToken: 'dt-settings' }), 'dt-settings');
  assert.equal(qoderAccessToken({ QODER_ACCESS_TOKEN: 'dt-env' }), 'dt-env');
  assert.equal(qoderAccessToken({ TOKEN_MONITOR_QODER_ACCESS_TOKEN: 'dt-tm' }), 'dt-tm');
  assert.equal(qoderAccessToken({}, { qoderAccessToken: 'Bearer dt-bearer' }), 'Bearer dt-bearer');
  assert.equal(qoderAccessToken({}), '');
});

test('qoderApiQuotaUrl targets the IDE openapi origin per site', () => {
  assert.equal(qoderApiQuotaUrl('cn'), 'https://openapi.qoder.com.cn/api/v2/quota/usage');
  assert.equal(qoderApiQuotaUrl('global'), 'https://openapi.qoder.sh/api/v2/quota/usage');
  assert.equal(qoderApiPlanUrl('cn'), 'https://openapi.qoder.com.cn/api/v2/user/plan');
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

test('parseQoderApiUsage reads the IDE quota payload with add-on credits', () => {
  const usage = parseQoderApiUsage({
    userId: 'u1',
    userType: 'personal_professional',
    usageType: 'credits',
    totalUsagePercentage: 0.02,
    isQuotaExceeded: false,
    expiresAt: 1790352000000,
    upgradeUrl: 'https://qoder.com.cn/pricing?client=qoder',
    userQuota: {
      total: 2000,
      used: 38,
      remaining: 1962,
      percentage: 0.02,
      unit: 'credits'
    },
    isPlanQuotaProrated: false
  });

  assert.equal(usage.usedCredits, 38);
  assert.equal(usage.totalCredits, 2000);
  assert.equal(usage.remainingCredits, 1962);
  assert.equal(usage.usagePercentage, 38 / 2000 * 100);
  assert.equal(usage.unit, 'credits');
  assert.equal(usage.resetsAt, new Date(1790352000000).toISOString());
  assert.equal(usage.window.kind, 'billing');
  assert.equal(usage.window.label, 'Credits');
  assert.equal(usage.window.used, 38);
  assert.equal(usage.window.limit, 2000);
});

test('parseQoderApiUsage merges add-on quota into the window', () => {
  const usage = parseQoderApiUsage({
    expiresAt: 1790352000000,
    userQuota: { total: 2000, used: 1500, remaining: 500, unit: 'credits' },
    addOnQuota: { total: 500, used: 100, remaining: 400, unit: 'credits' }
  });

  assert.equal(usage.usedCredits, 1600);
  assert.equal(usage.totalCredits, 2500);
  assert.equal(usage.remainingCredits, 900);
  assert.equal(usage.usagePercentage, 1600 / 2500 * 100);
});

test('parseQoderApiUsage derives remaining when the payload omits it', () => {
  const usage = parseQoderApiUsage({
    userQuota: { total: 100, used: 30, unit: 'credits' }
  });
  assert.equal(usage.remainingCredits, 70);
});

test('parseQoderApiUsage rejects a payload without usage numbers', () => {
  assert.throws(() => parseQoderApiUsage({ userType: 'personal_professional' }), /missing userQuota/);
});

test('fetchQoderLimits prefers the access token and hits the IDE openapi endpoint', async () => {
  const requests = [];
  const provider = await fetchQoderLimits(
    { qoderAccessToken: 'dt-abc', qoderCookie: 'session=stale', qoderSite: 'cn' },
    {
      env: {},
      now: () => Date.parse('2026-08-25T00:00:00Z'),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith('/api/v2/user/plan')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ user_type: 'personal_professional', plan_tier_name: 'Pro' })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            userId: 'u1',
            userType: 'personal_professional',
            expiresAt: 1790352000000,
            userQuota: { total: 2000, used: 38, remaining: 1962, percentage: 0.02, unit: 'credits' }
          })
        };
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'api');
  assert.equal(provider.region, 'cn');
  assert.equal(provider.accountLabel, 'Pro');
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].used, 38);
  assert.equal(provider.windows[0].limit, 2000);
  assert.equal(provider.windows[0].remaining, 1962);
  assert.equal(requests[0].url, 'https://openapi.qoder.com.cn/api/v2/quota/usage');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer dt-abc');
  assert.equal(requests.some((r) => r.url.includes('qoder.com.cn/api/v2/me/usages')), false);
});

test('fetchQoderLimits reports unauthorized when the access token is rejected', async () => {
  const provider = await fetchQoderLimits(
    { qoderAccessToken: 'dt-expired', qoderSite: 'cn' },
    {
      env: {},
      now: () => Date.parse('2026-08-25T00:00:00Z'),
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) })
    }
  );
  assert.equal(provider.status, 'unauthorized');
  assert.equal(provider.source, 'api');
  assert.equal(provider.windows.length, 0);
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
