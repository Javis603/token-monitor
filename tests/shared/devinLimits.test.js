'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  devinBearerToken,
  devinOrganization,
  devinQuotaUrls,
  devinSubscriptionUrls,
  fetchDevinLimits,
  normalizeDevinOrganization,
  parseDevinSubscriptionPlan,
  parseDevinUsage
} = require('../../src/shared/providers/devin/limits');

test('normalizes Devin bearer tokens and organization inputs', () => {
  assert.equal(devinBearerToken({}, { devinBearerToken: 'Authorization: Bearer secret-token' }), 'secret-token');
  assert.equal(devinBearerToken({ DEVIN_BEARER_TOKEN: ' Bearer env-token ' }), 'env-token');
  assert.equal(normalizeDevinOrganization('example-org'), 'org/example-org');
  assert.equal(normalizeDevinOrganization('org/example-org'), 'org/example-org');
  assert.equal(normalizeDevinOrganization('org_GQ6LhcfkW1TSinM6'), 'organizations/org_GQ6LhcfkW1TSinM6');
  assert.equal(normalizeDevinOrganization('https://app.devin.ai/org/example-org/settings/usage'), 'org/example-org');
  assert.equal(devinOrganization({ DEVIN_ORG: 'example-org' }), 'org/example-org');
});

test('prioritizes the internal organization endpoint', () => {
  assert.deepEqual(devinQuotaUrls('org_GQ6LhcfkW1TSinM6').slice(0, 2), [
    'https://app.devin.ai/api/org_GQ6LhcfkW1TSinM6/billing/quota/usage',
    'https://app.devin.ai/api/organizations/org_GQ6LhcfkW1TSinM6/billing/quota/usage'
  ]);
});

test('parses current Devin daily, weekly, plan and balance fields', () => {
  const usage = parseDevinUsage({
    plan_name: 'pro',
    daily_percentage: 0.12,
    weekly_percentage: 42,
    daily_reset_at: '2026-09-24T08:00:00+08:00',
    weekly_reset_at: 1790467200,
    overage_balance: 10
  }, 'organizations/org_GQ6LhcfkW1TSinM6');
  assert.equal(usage.daily.usedPercent, 12);
  assert.equal(usage.weekly.usedPercent, 42);
  assert.equal(usage.daily.resetsAt, '2026-09-24T00:00:00.000Z');
  assert.equal(usage.weekly.resetsAt, '2026-09-27T00:00:00.000Z');
  assert.equal(usage.planName, 'Pro');
  assert.equal(usage.organization, 'org_GQ6LhcfkW1TSinM6');
  assert.equal(usage.overageBalance, 10);
});

test('hides daily quota while keeping nested weekly quota and cents balance', () => {
  const usage = parseDevinUsage({
    hide_daily_quota: true,
    quota_usage: {
      daily_quota: { used: 3, limit: 10 },
      weekly_quota: { remaining_percent: 0.25, next_reset_at: 1790467200000 }
    },
    overage_balance_cents: 7087
  });
  assert.equal(usage.daily, null);
  assert.equal(usage.weekly.usedPercent, 75);
  assert.equal(usage.weekly.resetsAt, '2026-09-27T00:00:00.000Z');
  assert.equal(usage.overageBalance, 70.87);
});

test('keeps Devin current and fallback percentage boundaries distinct', () => {
  const current = parseDevinUsage({ daily_percentage: 1, weekly_percentage: 0.5 });
  assert.equal(current.daily.usedPercent, 1);
  assert.equal(current.weekly.usedPercent, 50);
  assert.equal(parseDevinUsage({ daily_percentage: 0.99 }).daily.usedPercent, 99);
  assert.equal(parseDevinUsage({ daily_percentage: 1.5 }).daily.usedPercent, 1.5);

  const fallback = parseDevinUsage({
    quota_usage: {
      daily_quota: { used_percent: 1 },
      weekly_quota: { remaining_percent: 1 }
    }
  });
  assert.equal(fallback.daily.usedPercent, 100);
  assert.equal(fallback.weekly.usedPercent, 0);
});

test('suppresses unallocated quotas and accepts a zero extra usage balance', () => {
  const usage = parseDevinUsage({
    has_quota_allocation: false,
    is_quota_plan: false,
    daily_percentage: 0,
    weekly_percentage: 0,
    quota_usage: { daily_quota: { used_percent: 25 } },
    overage_balance: 0
  });
  assert.equal(usage.daily, null);
  assert.equal(usage.weekly, null);
  assert.equal(usage.overageBalance, 0);
});

test('honors hidden weekly quota and keeps a balance-only response', () => {
  const hidden = parseDevinUsage({
    daily_percentage: 3,
    weekly_percentage: 7,
    hide_weekly_quota: true,
    overage_balance: 10
  });
  assert.equal(hidden.daily.usedPercent, 3);
  assert.equal(hidden.weekly, null);
  const balanceOnly = parseDevinUsage({ overage_balance: 10 });
  assert.equal(balanceOnly.daily, null);
  assert.equal(balanceOnly.weekly, null);
  assert.equal(balanceOnly.overageBalance, 10);
});

test('ignores numeric reset metadata when finding fallback quota windows', () => {
  const usage = parseDevinUsage({
    daily_reset_at: 1790467200,
    weekly_reset_at: 1790467200,
    quota_usage: {
      daily_quota: { used_percent: 25 },
      weekly_quota: { used_percent: 40 }
    }
  });
  assert.equal(usage.daily.usedPercent, 25);
  assert.equal(usage.weekly.usedPercent, 40);
  assert.throws(() => parseDevinUsage({ daily_reset_at: 1790467200 }), /missing Devin quota windows/);
});

test('does not turn scalar capacity metadata into used quota', () => {
  assert.throws(() => parseDevinUsage({ daily_limit: 100, weekly_total: 200 }), /missing Devin quota windows/);

  const withUsage = parseDevinUsage({
    daily_limit: 100,
    weekly_max: 200,
    quota_usage: {
      daily_quota: { used_percent: 25 },
      weekly_quota: { used_percent: 40 }
    }
  });
  assert.equal(withUsage.daily.usedPercent, 25);
  assert.equal(withUsage.weekly.usedPercent, 40);

  const structured = parseDevinUsage({ daily_limit: { used: 25, limit: 100 } });
  assert.equal(structured.daily.usedPercent, 25);
});

test('rejects a payload with no quota or balance data', () => {
  assert.throws(() => parseDevinUsage({}), /missing Devin quota windows/);
});

test('fetchDevinLimits sends scoped auth and maps all quota surfaces', async () => {
  const calls = [];
  const provider = await fetchDevinLimits({
    devinBearerToken: 'Bearer secret-token',
    devinOrganization: 'org_GQ6LhcfkW1TSinM6'
  }, {
    env: {},
    now: () => Date.parse('2026-09-23T12:00:00Z'),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_name: 'pro',
          daily_percentage: 0,
          weekly_percentage: 25,
          daily_reset_at: '2026-09-24T00:00:00Z',
          weekly_reset_at: '2026-09-27T00:00:00Z',
          overage_balance: 10
        })
      };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://app.devin.ai/api/org_GQ6LhcfkW1TSinM6/billing/quota/usage');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[0].init.headers['x-cog-org-id'], 'org_GQ6LhcfkW1TSinM6');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Pro');
  assert.equal(provider.windows[0].kind, 'daily');
  assert.equal(provider.windows[1].kind, 'weekly');
  assert.equal(provider.windows[2].metric, 'credits');
  assert.equal(provider.windows[2].remaining, 10);
  assert.equal(provider.balance.amount, 10);
});

test('parses the Devin subscription plan slug', () => {
  assert.equal(parseDevinSubscriptionPlan({ slug: 'teams-v2', status: 'active' }), 'Teams');
  assert.equal(parseDevinSubscriptionPlan({ slug: 'pro' }), 'Pro');
  assert.equal(parseDevinSubscriptionPlan({ plan_name: 'enterprise' }), 'Enterprise');
  assert.equal(parseDevinSubscriptionPlan({ plan: { slug: 'custom_plan' } }), 'Custom Plan');
  assert.equal(parseDevinSubscriptionPlan({ status: 'active' }), '');
  assert.equal(parseDevinSubscriptionPlan(null), '');
});

test('devinSubscriptionUrls scopes the subscription endpoint to the organization', () => {
  assert.deepEqual(devinSubscriptionUrls('org_GQ6LhcfkW1TSinM6'), [
    'https://app.devin.ai/api/billing/subscription',
    'https://app.devin.ai/api/organizations/org_GQ6LhcfkW1TSinM6/billing/subscription',
    'https://app.devin.ai/api/org_GQ6LhcfkW1TSinM6/billing/subscription'
  ]);
  assert.deepEqual(devinSubscriptionUrls('org/example-org'), [
    'https://app.devin.ai/api/billing/subscription',
    'https://app.devin.ai/api/org/example-org/billing/subscription',
    'https://app.devin.ai/api/example-org/billing/subscription'
  ]);
});

test('fetchDevinLimits falls back to the subscription endpoint for the plan label', async () => {
  const calls = [];
  const provider = await fetchDevinLimits({
    devinBearerToken: 'Bearer secret-token',
    devinOrganization: 'org_GQ6LhcfkW1TSinM6'
  }, {
    env: {},
    now: () => Date.parse('2026-09-23T12:00:00Z'),
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith('/billing/subscription')) {
        return { ok: true, status: 200, json: async () => ({ slug: 'teams-v2', status: 'active' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          daily_percentage: 0,
          weekly_percentage: 25,
          overage_balance: 10
        })
      };
    }
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.planLabel, 'Teams');
  assert.equal(provider.accountLabel, 'Teams');
  assert.ok(calls.some((url) => url === 'https://app.devin.ai/api/billing/subscription'));
});

test('fetchDevinLimits keeps working when the subscription lookup fails', async () => {
  const provider = await fetchDevinLimits({
    devinBearerToken: 'Bearer secret-token',
    devinOrganization: 'org_example'
  }, {
    env: {},
    now: () => 0,
    fetch: async (url) => {
      if (url.includes('/billing/subscription')) {
        return { ok: false, status: 404, json: async () => ({ detail: 'Not found' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ daily_percentage: 10, weekly_percentage: 20 })
      };
    }
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.planLabel, '');
  assert.equal(provider.windows.length, 2);
});

test('fetchDevinLimits distinguishes missing setup and rejected credentials', async () => {
  const missing = await fetchDevinLimits({}, { env: {}, now: () => 0 });
  assert.equal(missing.status, 'notConfigured');

  const rejected = await fetchDevinLimits({
    devinBearerToken: 'token',
    devinOrganization: 'org_example'
  }, {
    env: {},
    now: () => 0,
    fetch: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'Unauthorized' }) })
  });
  assert.equal(rejected.status, 'unauthorized');
});

test('fetchDevinLimits returns only a balance window for an account without quota allocation', async () => {
  const provider = await fetchDevinLimits({
    devinBearerToken: 'token',
    devinOrganization: 'org_example'
  }, {
    env: {},
    now: () => 0,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        has_quota_allocation: false,
        daily_percentage: 0,
        weekly_percentage: 0,
        overage_balance: 0
      })
    })
  });
  assert.equal(provider.status, 'ok');
  assert.deepEqual(provider.windows.map((window) => window.kind), ['billing']);
  assert.equal(provider.windows[0].remaining, 0);
  assert.equal(provider.balance.amount, 0);
});
