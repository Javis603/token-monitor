'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ZED_BILLING_SUBSCRIPTION_URL,
  ZED_BILLING_USAGE_URL,
  fetchZedLimits,
  formatPlanLabel,
  normalizeZedCookieHeader,
  parseEditPredictionsWindow,
  parseSubscription,
  parseZedBillingUsage,
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
      },
      edit_predictions: {
        used: 0,
        limit: null,
        remaining: null
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
    resetDescription: '',
    detail: 'Unlimited',
    showMeter: false
  }]);
});

test('uses upstream Edit Predictions limits instead of deriving entitlement from the plan', () => {
  assert.deepEqual(parseEditPredictionsWindow({
    edit_predictions: { used: 500, limit: 2000, remaining: 1500 }
  }), {
    kind: 'billing',
    limitId: 'zed.edit-predictions',
    label: 'Edit Predictions',
    used: 500,
    limit: 2000,
    remaining: 1500,
    usedPercent: 25,
    remainingPercent: 75,
    resetDescription: '',
    showMeter: true
  });
  assert.equal(parseEditPredictionsWindow({}), null);
  assert.equal(parseEditPredictionsWindow({ edit_predictions: { used: 0 } }), null);
  assert.equal(parseEditPredictionsWindow({ edit_predictions: { used: 0, limit: 0 } }), null);
});

test('an upstream null Edit Predictions limit is unlimited without a synthetic meter', () => {
  assert.deepEqual(parseEditPredictionsWindow({
    edit_predictions: { used: 0, limit: null, remaining: null }
  }), {
    kind: 'billing',
    limitId: 'zed.edit-predictions',
    label: 'Edit Predictions',
    resetDescription: '',
    detail: 'Unlimited',
    showMeter: false
  });
});

test('does not infer Edit Predictions from a Business plan when usage omits the field', () => {
  const parsed = parseZedBillingUsage(usagePayload({
    plan: 'token_based_zed_business',
    current_usage: {
      token_spend_in_cents: 250,
      token_spend: {
        spend_in_cents: 250,
        limit_in_cents: 1000,
        updated_at: '2026-09-02T01:02:03.000Z'
      }
    }
  }), subscriptionPayload({ name: 'Zed Business' }));
  assert.equal(parsed.planLabel, 'Zed Business');
  assert.deepEqual(parsed.windows, [parsed.window]);
});

test('keeps usage valid without optional subscription data', () => {
  const parsed = parseZedBillingUsage(usagePayload(), null);
  assert.equal(parsed.planLabel, 'Zed Student');
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
  assert.equal(editPredictions.usedPercent, null);
  assert.equal(editPredictions.remainingPercent, null);
  assert.equal(editPredictions.showMeter, false);
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

test('keeps Token Spend and account identity when subscription enrichment is unavailable', async () => {
  const fetchProvider = (subscriptionStatus) => fetchZedLimits(
    { zedCookie: 'zed.session=session-secret' },
    {
      env: {},
      fetch: async (url) => url === ZED_BILLING_USAGE_URL
        ? response(200, usagePayload())
        : response(subscriptionStatus, subscriptionPayload())
    }
  );
  const [enriched, provider] = await Promise.all([fetchProvider(200), fetchProvider(500)]);
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountKey, enriched.accountKey);
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
