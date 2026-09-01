'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  fetchBailianLimits,
  normalizeBailianCookieHeader,
  parseBailianUsage
} = require('../../src/shared/bailianLimits');

test('normalizeBailianCookieHeader strips a Cookie: prefix and trims', () => {
  assert.equal(
    normalizeBailianCookieHeader(' Cookie: login_aliyunid_pk=abc; login_aliyunid_ticket=def '),
    'login_aliyunid_pk=abc; login_aliyunid_ticket=def'
  );
  assert.equal(normalizeBailianCookieHeader('not-a-cookie'), '');
});

test('parseBailianUsage maps the mainland GetSubscriptionSummary response', () => {
  const usage = parseBailianUsage({
    code: '200',
    data: {
      Data: {
        Uid: 123456,
        TotalSurplusValue: '239673.78313',
        TotalCount: 1,
        TotalValue: '250000',
        ProductCode: 'sfm_tokenplanteams_dp_cn',
        NearestExpireDate: 1790582400000
      },
      Success: true
    }
  });

  assert.equal(usage.uid, '123456');
  assert.equal(usage.total, 250000);
  assert.equal(usage.remaining, 239673.78313);
  assert.ok(Math.abs(usage.used - 10326.21687) < 1e-6);
  assert.equal(usage.totalCount, 1);
  assert.equal(usage.planName, 'TOKEN PLAN');
  assert.equal(usage.resetsAt, '2026-09-28T08:00:00.000Z');
});

test('fetchBailianLimits returns notConfigured without a cookie', async () => {
  const [provider] = await fetchBailianLimits({}, { env: {} });
  assert.equal(provider.provider, 'bailian');
  assert.equal(provider.status, 'notConfigured');
});

test('fetchBailianLimits posts GetSubscriptionSummary and normalizes a quota window', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('/tool/user/info.json')) {
      return {
        ok: true,
        status: 200,
        text: async () => '{}'
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: '200',
        data: {
          Data: {
            Uid: 123456,
            TotalSurplusValue: '100',
            TotalCount: 1,
            TotalValue: '200',
            NearestExpireDate: 1790582400000
          },
          Success: true
        }
      })
    };
  };

  const [provider] = await fetchBailianLimits(
    { bailianCookie: 'login_aliyunid_pk=abc; login_aliyunid_ticket=def' },
    { env: {}, fetch: fetchFn }
  );

  const quotaCall = calls.find((call) => String(call.url).includes('GetSubscriptionSummary'));
  assert.ok(quotaCall, 'expected a GetSubscriptionSummary request');
  assert.match(quotaCall.url, /GetSubscriptionSummary/);
  assert.equal(quotaCall.init.method, 'POST');
  assert.equal(provider.provider, 'bailian');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'web');
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].kind, 'billing');
  assert.equal(provider.windows[0].limit, 200);
  assert.equal(provider.windows[0].remaining, 100);
});