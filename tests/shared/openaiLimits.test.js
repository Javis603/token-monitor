'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fetchOpenaiLimits,
  normalizeOpenaiPlan,
  normalizeOpenaiRenewalDate,
  openaiAdminKey,
  openaiBillingPeriod
} = require('../../src/shared/providers/openai/limits');

const KEY = 'sk-admin-test-secret';
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

function page(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => '' },
    json: async () => body
  };
}

function bucket(startMs, value, currency = 'usd') {
  return {
    start_time: Math.floor(startMs / 1000),
    end_time: Math.floor(startMs / 1000) + 86400,
    results: [{ amount: { value, currency } }]
  };
}

function costs(data, extra = {}) {
  return page({ object: 'page', data, has_more: false, next_page: null, ...extra });
}

test('openaiAdminKey prefers an explicit key and strips quotes', () => {
  assert.equal(openaiAdminKey({ OPENAI_ADMIN_KEY: 'env-key' }, '  "sk-admin-explicit"  '), 'sk-admin-explicit');
  assert.equal(openaiAdminKey({ TOKEN_MONITOR_OPENAI_ADMIN_KEY: 'prefixed', OPENAI_ADMIN_KEY: 'bare' }), 'prefixed');
  assert.equal(openaiAdminKey({ OPENAI_ADMIN_KEY: 'bare' }), 'bare');
  assert.equal(openaiAdminKey({}), '');
});

test('plan and renewal normalize the published tiers and reject impossible values', () => {
  assert.equal(normalizeOpenaiPlan(' pro_5x '), 'pro5x');
  assert.equal(normalizeOpenaiPlan('Pro-20x'), 'pro20x');
  assert.equal(normalizeOpenaiPlan('pro500'), 'pro50x');
  assert.equal(normalizeOpenaiPlan(''), '');
  assert.throws(() => normalizeOpenaiPlan('plus'), { code: 'OPENAI_PLAN_INVALID' });
  assert.equal(normalizeOpenaiRenewalDate(' 2026-11-15 '), '2026-11-15');
  assert.equal(normalizeOpenaiRenewalDate(''), '');
  assert.throws(() => normalizeOpenaiRenewalDate('2026-02-31'), { code: 'OPENAI_RENEWAL_DATE_INVALID' });
  assert.throws(() => normalizeOpenaiRenewalDate('15 Nov 2026'), { code: 'OPENAI_RENEWAL_DATE_INVALID' });
});

test('the billing period keeps the anchor day across short months', () => {
  const january = openaiBillingPeriod(Date.UTC(2026, 1, 15), '2026-01-31');
  assert.equal(january.startMs, Date.UTC(2026, 0, 31));
  assert.equal(january.endMs, Date.UTC(2026, 1, 28));

  const march = openaiBillingPeriod(Date.UTC(2024, 2, 1), '2024-01-31');
  assert.equal(march.startMs, Date.UTC(2024, 1, 29));
  assert.equal(march.endMs, Date.UTC(2024, 2, 31));

  const beforeRenewal = openaiBillingPeriod(NOW, '2026-11-15');
  assert.equal(beforeRenewal.startMs, Date.UTC(2026, 9, 15));
  assert.equal(beforeRenewal.endMs, Date.UTC(2026, 10, 15));
});

test('missing plan, renewal, or key does not call Costs', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return costs([]); };
  const base = { openaiAdminKey: KEY, openaiPlan: 'pro5x', openaiRenewalDate: '2026-11-15' };
  for (const options of [
    { ...base, openaiAdminKey: '' },
    { ...base, openaiPlan: '' },
    { ...base, openaiRenewalDate: '' }
  ]) {
    const result = await fetchOpenaiLimits(options, { env: {}, now: () => NOW, fetch });
    assert.equal(result.status, 'notConfigured');
    assert.equal(result.balance, null);
  }
  assert.equal(calls, 0);
});

test('the estimate subtracts USD costs inside the renewal period', async () => {
  const urls = [];
  const result = await fetchOpenaiLimits({
    openaiAdminKey: KEY,
    openaiPlan: 'pro-5x',
    openaiRenewalDate: '2026-11-15'
  }, {
    env: {},
    now: () => NOW,
    fetch: async (url) => {
      urls.push(String(url));
      return costs([
        bucket(Date.UTC(2026, 9, 14), 40),
        bucket(Date.UTC(2026, 9, 15), 10),
        bucket(Date.UTC(2026, 10, 4), 5.5)
      ]);
    }
  });

  const query = new URL(urls[0]);
  assert.equal(query.searchParams.get('start_time'), String(Date.UTC(2026, 9, 15) / 1000));
  assert.equal(query.searchParams.get('end_time'), String(Date.UTC(2026, 10, 5) / 1000));
  assert.equal(query.searchParams.get('bucket_width'), '1d');
  assert.equal(query.searchParams.has('project_ids'), false);
  assert.equal(result.status, 'ok');
  assert.equal(result.planLabel, 'Pro 5x');
  assert.equal(result.windows[0].used, 15.5);
  assert.equal(result.windows[0].limit, 100);
  assert.equal(result.windows[0].remaining, 84.5);
  assert.equal(result.windows[0].usedPercent, 15.5);
  assert.equal(result.windows[0].currency, 'USD');
  assert.equal(result.windows[0].boundaryKind, 'expiry');
  assert.equal(result.windows[0].resetsAt, '2026-11-15T00:00:00.000Z');
  assert.equal(result.balance.amount, 84.5);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.match(result.accountKey, /^sha256:/);
});

test('cost pages are summed and a truncated page fails closed', async () => {
  let calls = 0;
  const result = await fetchOpenaiLimits({
    openaiAdminKey: KEY,
    openaiPlan: 'pro20x',
    openaiRenewalDate: '2026-11-15'
  }, {
    env: {},
    now: () => NOW,
    fetch: async (url) => {
      calls += 1;
      if (!String(url).includes('page=')) {
        return costs([bucket(Date.UTC(2026, 9, 15), 20)], { has_more: true, next_page: 'cursor-2' });
      }
      return costs([bucket(Date.UTC(2026, 10, 1), 30)]);
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.windows[0].used, 50);
  assert.equal(result.windows[0].limit, 200);
  assert.equal(result.windows[0].remaining, 150);

  const truncated = await fetchOpenaiLimits({
    openaiAdminKey: KEY,
    openaiPlan: 'pro50x',
    openaiRenewalDate: '2026-11-15'
  }, {
    env: {},
    now: () => NOW,
    fetch: async () => costs([], { has_more: true, next_page: '' })
  });
  assert.equal(truncated.status, 'unavailable');
  assert.equal(truncated.windows.length, 0);
});

test('auth failures and unreadable costs do not become a full allowance', async () => {
  const options = { openaiAdminKey: KEY, openaiPlan: 'pro5x', openaiRenewalDate: '2026-11-15' };
  const unauthorized = await fetchOpenaiLimits(options, {
    env: {},
    now: () => NOW,
    fetch: async () => page({}, 401)
  });
  assert.equal(unauthorized.status, 'unauthorized');

  const forbidden = await fetchOpenaiLimits(options, {
    env: {},
    now: () => NOW,
    fetch: async () => page({}, 403)
  });
  assert.equal(forbidden.status, 'unauthorized');

  const foreign = await fetchOpenaiLimits(options, {
    env: {},
    now: () => NOW,
    fetch: async () => costs([bucket(Date.UTC(2026, 10, 4), 1, 'eur')])
  });
  assert.equal(foreign.status, 'unavailable');

  const malformed = await fetchOpenaiLimits(options, {
    env: {},
    now: () => NOW,
    fetch: async () => page({ data: { amount: { value: 0, currency: 'usd' } } })
  });
  assert.equal(malformed.status, 'unavailable');
});

test('spend above the allowance clamps remaining at zero and the meter at 100', async () => {
  const result = await fetchOpenaiLimits({
    openaiAdminKey: KEY,
    openaiPlan: 'pro5x',
    openaiRenewalDate: '2026-11-15'
  }, {
    env: {},
    now: () => NOW,
    fetch: async () => costs([bucket(Date.UTC(2026, 10, 1), 150)])
  });
  assert.equal(result.windows[0].used, 150);
  assert.equal(result.windows[0].limit, 100);
  assert.equal(result.windows[0].remaining, 0);
  assert.equal(result.windows[0].usedPercent, 100);
  assert.equal(result.balance.amount, 0);
});

test('environment config is enough when no saved account is present', async () => {
  const result = await fetchOpenaiLimits({}, {
    env: {
      OPENAI_ADMIN_KEY: KEY,
      OPENAI_SUBSCRIPTION_PLAN: '20x',
      OPENAI_SUBSCRIPTION_RENEWAL: '2026-11-15'
    },
    now: () => NOW,
    fetch: async () => costs([bucket(Date.UTC(2026, 10, 2), 1)])
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.planLabel, 'Pro 20x');
  assert.equal(result.windows[0].limit, 200);
  assert.equal(result.windows[0].remaining, 199);
});
