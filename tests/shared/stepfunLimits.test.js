'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchStepfunLimits, parseStepfunUsage, stepfunToken, deviceId } = require('../../src/shared/providers/stepfun/limits');

function jwt(device) {
  return `header.${Buffer.from(JSON.stringify({ device_id: device })).toString('base64url')}.signature`;
}

test('StepFun token pair uses refresh device id for the Oasis cookie', async () => {
  const token = `${jwt('access-id')}...${jwt('refresh-id')}`;
  assert.equal(deviceId(token), 'refresh-id');
  const requests = [];
  const result = await fetchStepfunLimits({ stepfunToken: token }, {
    env: {}, now: () => 1770000000000,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => url.includes('QueryStepPlanRateLimit')
        ? { status: 1, five_hour_usage_left_rate: 0.8, weekly_usage_left_rate: 0.6,
          five_hour_usage_reset_time: '1780000000', weekly_usage_reset_time: '1780500000' }
        : { status: 1, subscription: { name: 'Coding Plan' } } };
    }
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.accountLabel, 'Coding Plan');
  assert.deepEqual(result.windows.map(({ kind, usedPercent }) => [kind, usedPercent]), [['session', 20], ['weekly', 40]]);
  assert.equal(requests.length, 2);
  for (const { init } of requests) {
    assert.equal(init.headers['oasis-webid'], 'refresh-id');
    assert.equal(init.headers.Cookie, `Oasis-Token=${token}; Oasis-Webid=refresh-id`);
    assert.equal(init.credentials, 'omit');
  }
});

test('StepFun credit plans use weighted buckets and omit inactive rate windows', () => {
  const windows = parseStepfunUsage({ status: 1, plan_family: 2,
    five_hour_usage_left_rate: 0, weekly_usage_left_rate: 0,
    five_hour_usage_reset_time: '0', weekly_usage_reset_time: '0',
    plan_credit_rate_limit: { subscription_credit_left_rate: 0.9, topup_credit_left_rate: 0.1,
      subscription_credit_reset_time: '1786288293', credit_buckets: [
        { credit_total: '400', credit_residual: '300' },
        { credit_total: '100', credit_residual: '100' }
      ] } });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, 'billing');
  assert.equal(windows[0].usedPercent, 20);
  assert.equal(windows[0].windowMinutes, 43200);
});

test('StepFun missing credit amount and invalid windows do not publish a false quota', () => {
  assert.throws(() => parseStepfunUsage({ status: 1, plan_family: 2 }), /credit balance missing/);
  assert.throws(() => parseStepfunUsage({ status: 1, plan_family: 2,
    plan_credit_rate_limit: { subscription_credit_left_rate: 0.8, credit_buckets: [
      { credit_total: 100, credit_residual: 80 }, { credit_total: 100 }
    ] } }), /credit buckets incomplete/);
  assert.equal(parseStepfunUsage({ status: 1, plan_family: 2,
    plan_credit_rate_limit: { subscription_credit_left_rate: 0.8, credit_buckets: [] }
  })[0].usedPercent, 20);
  assert.throws(() => parseStepfunUsage({ status: 1, five_hour_usage_left_rate: 0,
    weekly_usage_left_rate: 0, five_hour_usage_reset_time: '0', weekly_usage_reset_time: '0' }), /rate windows missing/);
});

test('a stalled optional plan lookup cannot discard a successful quota response', async () => {
  let planSignal;
  const result = await fetchStepfunLimits({ stepfunToken: 'token' }, {
    env: {}, stepfunPlanFetchTimeoutMs: 10,
    fetch: async (url, { signal }) => {
      if (url.includes('QueryStepPlanRateLimit')) return { ok: true, json: async () => ({
        status: 1, five_hour_usage_left_rate: 0.8, weekly_usage_left_rate: 0.6,
        five_hour_usage_reset_time: '1780000000', weekly_usage_reset_time: '1780500000'
      }) };
      planSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.accountLabel, '');
  assert.deepEqual(result.windows.map(({ kind }) => kind), ['session', 'weekly']);
  assert.equal(planSignal.aborted, true);
});

test('StepFun classifies rejected credentials and missing settings', async () => {
  assert.equal(stepfunToken({}, { stepfunToken: 'Oasis-Token=abc...def; Oasis-Webid=device' }), 'abc...def');
  assert.equal((await fetchStepfunLimits({}, { env: {} })).status, 'notConfigured');
  const rejected = await fetchStepfunLimits({ stepfunToken: 'token' }, {
    env: {}, fetch: async () => ({ ok: false, status: 401 })
  });
  assert.equal(rejected.status, 'unauthorized');
});
