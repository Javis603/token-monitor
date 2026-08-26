'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fetchTraeLimits,
  parseTraeEntUsage,
  traeAccessToken,
  traeDeviceId,
  traeEntUsageUrl
} = require('../../src/shared/traeLimits');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function pack(limit, used) {
  return {
    entitlement_base_info: { quota: { credits_limit: limit } },
    usage: { credits_amount: used }
  };
}

test('Trae credentials prefer settings, support env aliases, and normalize copied headers', () => {
  assert.equal(traeAccessToken(
    { TRAE_ACCESS_TOKEN: 'env-token' },
    { traeAccessToken: ' "Authorization: Cloud-IDE-JWT settings-token" ' }
  ), 'settings-token');
  assert.equal(traeAccessToken({ TOKEN_MONITOR_TRAE_ACCESS_TOKEN: "'tm-token'" }), 'tm-token');
  assert.equal(traeAccessToken({ TRAE_ACCESS_TOKEN: 'Cloud-IDE-JWT env-token' }), 'env-token');
  assert.equal(traeDeviceId({ TRAE_DEVICE_ID: 'env-device' }, { traeDeviceId: 'device-1' }), 'device-1');
  assert.equal(traeDeviceId({ TOKEN_MONITOR_TRAE_DEVICE_ID: 'tm-device' }), 'tm-device');
  assert.equal(traeAccessToken({}, { traeAccessToken: 'token\r\ninjected' }), '');
  assert.equal(traeDeviceId({}, { traeDeviceId: 'device\ninjected' }), '');
});

test('Trae endpoint remains scoped to the CN API', () => {
  assert.equal(traeEntUsageUrl(), 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage');
});

test('parseTraeEntUsage aggregates valid packs as a credits balance', () => {
  const parsed = parseTraeEntUsage({
    user_entitlement_pack_list: [pack(1000, 250), pack('500', '100'), pack(0, 0)]
  });
  assert.equal(parsed.packCount, 2);
  assert.deepEqual(parsed.window, {
    kind: 'billing',
    label: 'Credits',
    metric: 'credits',
    currency: 'CREDITS',
    used: 350,
    limit: 1500,
    remaining: 1150,
    usedPercent: 350 / 1500 * 100,
    remainingPercent: 100 - (350 / 1500 * 100),
    resetsAt: null,
    showMeter: true
  });
});

test('parseTraeEntUsage fails closed instead of publishing partial credit packs', () => {
  assert.throws(() => parseTraeEntUsage({ user_entitlement_pack_list: [pack(100, 10), {}] }), /unusable active/);
  assert.throws(() => parseTraeEntUsage({ user_entitlement_pack_list: [pack(100, -1)] }), /unusable active/);
  assert.throws(() => parseTraeEntUsage({ user_entitlement_pack_list: [pack(0, 10)] }), /unusable active/);
  assert.throws(() => parseTraeEntUsage({ user_entitlement_pack_list: [] }), /no usable/);
  assert.throws(() => parseTraeEntUsage({}), /no entitlement pack list/);
});

test('parseTraeEntUsage preserves overage while clamping the spendable balance', () => {
  const settledAcrossPacks = parseTraeEntUsage({
    user_entitlement_pack_list: [pack(100, 120), pack(100, 20)]
  });
  assert.equal(settledAcrossPacks.window.used, 140);
  assert.equal(settledAcrossPacks.window.limit, 200);
  assert.equal(settledAcrossPacks.window.remaining, 60);
  assert.equal(settledAcrossPacks.window.usedPercent, 70);
  assert.equal(settledAcrossPacks.window.remainingPercent, 30);

  const exhausted = parseTraeEntUsage({
    user_entitlement_pack_list: [pack(100, 125)]
  });
  assert.equal(exhausted.window.used, 125);
  assert.equal(exhausted.window.limit, 100);
  assert.equal(exhausted.window.remaining, 0);
  assert.equal(exhausted.window.usedPercent, 100);
  assert.equal(exhausted.window.remainingPercent, 0);
});

test('parseTraeEntUsage skips feature entitlements and treats untouched packs as unconsumed', () => {
  // Real-account shape: a free-tier entitlement toggles solo features without a
  // credits_limit, and a pack nobody has drawn from yet reports an empty usage.
  const parsed = parseTraeEntUsage({
    user_entitlement_pack_list: [
      { entitlement_base_info: { quota: { credits_limit: 2000 } }, usage: {} },
      { entitlement_base_info: { quota: { credits_limit: 500, enable_solo_lite: true } }, usage: { credits_amount: 500 } },
      { entitlement_base_info: { quota: { enable_solo_agent: true, enable_solo_lite: true } }, usage: {} }
    ]
  });
  assert.equal(parsed.packCount, 2);
  assert.equal(parsed.window.limit, 2500);
  assert.equal(parsed.window.used, 500);
  assert.equal(parsed.window.remaining, 2000);
});

test('parseTraeEntUsage fails closed when a feature entitlement reports spend', () => {
  assert.throws(() => parseTraeEntUsage({
    user_entitlement_pack_list: [
      pack(100, 10),
      { entitlement_base_info: { quota: { enable_solo_lite: true } }, usage: { credits_amount: 5 } }
    ]
  }), /unusable active/);
});

test('fetchTraeLimits returns notConfigured without a token', async () => {
  const provider = await fetchTraeLimits({}, { env: {}, now: () => 0 });
  assert.equal(provider.provider, 'trae');
  assert.equal(provider.status, 'notConfigured');
  assert.equal(provider.region, 'cn');
  assert.deepEqual(provider.windows, []);
});

test('fetchTraeLimits sends managed credentials and does not expose them', async () => {
  const calls = [];
  const provider = await fetchTraeLimits({
    traeAccessToken: 'token-1',
    traeDeviceId: 'device-1'
  }, {
    env: {},
    now: () => 0,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response({ user_entitlement_pack_list: [pack(2000, 500)] });
    }
  });
  assert.equal(provider.provider, 'trae');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.region, 'cn');
  assert.equal(provider.windows[0].metric, 'credits');
  assert.equal(provider.windows[0].currency, 'CREDITS');
  assert.equal(provider.balance.amount, 1500);
  assert.equal(provider.balance.currency, 'CREDITS');
  assert.equal(JSON.stringify(provider).includes('token-1'), false);
  assert.equal(JSON.stringify(provider).includes('device-1'), false);

  assert.equal(calls[0].url, traeEntUsageUrl());
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Cloud-IDE-JWT token-1');
  assert.equal(calls[0].init.headers['X-User-Region'], 'CN');
  assert.equal(calls[0].init.headers['X-Device-Id'], 'device-1');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.body, '{}');
});

test('fetchTraeLimits normalizes authentication and rate-limit failures', async () => {
  const unauthorized = await fetchTraeLimits({ traeAccessToken: 'token' }, {
    env: {}, fetch: async () => response(null, 403)
  });
  assert.equal(unauthorized.status, 'unauthorized');

  const limited = await fetchTraeLimits({ traeAccessToken: 'token' }, {
    env: {}, fetch: async () => response(null, 429)
  });
  assert.equal(limited.status, 'sourceRateLimited');
});

test('fetchTraeLimits aborts a hung request and keeps body reads within the deadline', async () => {
  const request = await fetchTraeLimits({ traeAccessToken: 'token' }, {
    env: {},
    traeFetchTimeoutMs: 5,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    })
  });
  assert.equal(request.status, 'unavailable');

  const body = await fetchTraeLimits({ traeAccessToken: 'token' }, {
    env: {},
    traeFetchTimeoutMs: 5,
    fetch: async () => ({ ok: true, status: 200, json: async () => new Promise(() => {}) })
  });
  assert.equal(body.status, 'unavailable');
});
