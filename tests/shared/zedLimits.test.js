'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ZED_BILLING_SUBSCRIPTION_URL,
  ZED_BILLING_USAGE_URL,
  fetchZedLimits,
  formatPlanLabel,
  normalizeZedCookieHeader,
  parseSubscription,
  parseZedBillingUsage,
  unlimitedEditPredictionsWindow,
  zedCookie
} = require('../../src/shared/zedLimits');

function usagePayload(overrides = {}) {
  return {
    plan: 'token_based_zed_student',
    current_usage: {
      token_spend_in_cents: 250,
      token_spend: {
        spend_in_cents: 250,
        limit_in_cents: 1000,
        updated_at: '2026-09-02T01:02:03.000Z'
      }
    },
    ...overrides
  };
}

function subscriptionPayload(overrides = {}) {
  return {
    subscription: {
      id: 1596962,
      name: 'Zed Student',
      status: 'active',
      period: {
        start_at: '2026-09-01T00:00:00.000Z',
        end_at: '2026-10-01T00:00:00.000Z'
      },
      ...overrides
    }
  };
}

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null }
  };
}

test('normalizes only Zed billing cookies and requires zed.session', () => {
  assert.equal(
    normalizeZedCookieHeader('Cookie: analytics=drop; zed.session=abc=def; c15t=xyz; __cf_bm=cf; other=no'),
    'zed.session=abc=def; c15t=xyz; __cf_bm=cf'
  );
  assert.equal(normalizeZedCookieHeader('c15t=xyz; other=no'), '');
  assert.equal(normalizeZedCookieHeader('zed.session=abc\nInjected: yes'), '');
});

test('prefers an explicit Zed Cookie and falls back to environment settings', () => {
  assert.equal(
    zedCookie({ TOKEN_MONITOR_ZED_COOKIE: 'zed.session=env' }, { zedCookie: 'zed.session=setting' }),
    'zed.session=setting'
  );
  assert.equal(zedCookie({ ZED_COOKIE: 'zed.session=alias' }), 'zed.session=alias');
});

test('normalizes Zed billing plan names', () => {
  assert.equal(formatPlanLabel('token_based_zed_student'), 'Zed Student');
  assert.equal(formatPlanLabel('zed-pro'), 'Zed Pro');
});

test('parses Token Spend first and keeps its reset without subscription renewal copy', () => {
  const parsed = parseZedBillingUsage(usagePayload(), subscriptionPayload());
  assert.equal(parsed.planLabel, 'Zed Student');
  assert.equal(parsed.subscriptionId, '1596962');
  assert.equal(parsed.usageUpdatedAt, '2026-09-02T01:02:03.000Z');
  assert.deepEqual(parsed.window, {
    kind: 'billing',
    limitId: 'zed.token-spend',
    label: 'Token Spend',
    used: 2.5,
    limit: 10,
    remaining: 7.5,
    usedPercent: 25,
    remainingPercent: 75,
    resetsAt: '2026-10-01T00:00:00.000Z',
    currency: 'USD',
    showMeter: true
  });
  assert.deepEqual(parsed.windows, [parsed.window, {
    kind: 'billing',
    limitId: 'zed.edit-predictions',
    label: 'Edit Predictions',
    used: 0,
    limit: null,
    remaining: null,
    usedPercent: 0,
    resetDescription: '',
    detail: 'Unlimited',
    showMeter: true
  }]);
});

test('derives unlimited Edit Predictions only for plans whose allowance is documented as unlimited', () => {
  for (const plan of ['Zed Pro', 'Zed Pro Trial', 'Zed Student', 'Zed Business']) {
    assert.equal(unlimitedEditPredictionsWindow(plan)?.detail, 'Unlimited');
  }
  assert.equal(unlimitedEditPredictionsWindow('Zed Free'), null);
  assert.equal(unlimitedEditPredictionsWindow('Zed Free Trial'), null);
  assert.equal(unlimitedEditPredictionsWindow(''), null);
});

test('keeps usage valid without optional subscription data', () => {
  const parsed = parseZedBillingUsage(usagePayload(), null);
  assert.equal(parsed.planLabel, 'Zed Student');
  assert.equal(parsed.subscriptionId, '');
  assert.equal(parsed.window.resetsAt, null);
  assert.equal(parseSubscription({}), null);
});

test('rejects billing payloads without a positive spend limit', () => {
  assert.throws(
    () => parseZedBillingUsage(usagePayload({
      current_usage: { token_spend: { spend_in_cents: 0, limit_in_cents: 0 } }
    })),
    /missing token spend/
  );
});

test('fetches dashboard usage and subscription with an explicit Cookie header', async () => {
  const calls = [];
  const provider = await fetchZedLimits(
    { zedCookie: 'zed.session=session-secret; c15t=challenge; analytics=drop' },
    {
      env: {},
      now: () => Date.parse('2026-09-02T02:00:00.000Z'),
      fetch: async (url, init) => {
        calls.push({ url, init });
        return url === ZED_BILLING_USAGE_URL
          ? response(200, usagePayload())
          : response(200, subscriptionPayload());
      }
    }
  );

  assert.equal(provider.provider, 'zed');
  assert.equal(provider.source, 'web');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.planLabel, 'Zed Student');
  assert.match(provider.accountKey, /^sha256:/u);
  assert.deepEqual(provider.windows.map((window) => window.limitId), [
    'zed.token-spend',
    'zed.edit-predictions'
  ]);
  const editPredictions = provider.windows.find((window) => window.limitId === 'zed.edit-predictions');
  assert.equal(editPredictions.detail, 'Unlimited');
  assert.equal(editPredictions.usedPercent, 0);
  assert.equal(editPredictions.remainingPercent, 100);
  assert.equal(editPredictions.showMeter, true);
  assert.deepEqual(calls.map((call) => call.url).sort(), [
    ZED_BILLING_SUBSCRIPTION_URL,
    ZED_BILLING_USAGE_URL
  ].sort());
  for (const call of calls) {
    assert.equal(call.init.headers.Cookie, 'zed.session=session-secret; c15t=challenge');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.redirect, 'error');
  }
});

test('keeps Token Spend when subscription enrichment is unavailable', async () => {
  const provider = await fetchZedLimits(
    { zedCookie: 'zed.session=session-secret' },
    {
      env: {},
      fetch: async (url) => url === ZED_BILLING_USAGE_URL
        ? response(200, usagePayload())
        : response(500)
    }
  );
  assert.equal(provider.status, 'ok');
  const tokenSpend = provider.windows.find((window) => window.limitId === 'zed.token-spend');
  assert.equal(tokenSpend.used, 2.5);
  assert.equal(tokenSpend.resetsAt, null);
});

test('maps missing, rejected, and rate-limited Cookies to shared statuses', async () => {
  const missing = await fetchZedLimits({}, { env: {} });
  assert.equal(missing.status, 'notConfigured');

  const rejected = await fetchZedLimits(
    { zedCookie: 'zed.session=expired' },
    { env: {}, fetch: async () => response(401) }
  );
  assert.equal(rejected.status, 'unauthorized');

  const rateLimited = await fetchZedLimits(
    { zedCookie: 'zed.session=busy' },
    { env: {}, fetch: async () => response(429) }
  );
  assert.equal(rateLimited.status, 'sourceRateLimited');
});
