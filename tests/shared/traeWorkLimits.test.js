'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  traeWorkAccessToken,
  traeWorkDeviceId,
  traeWorkEntUsageUrl,
  parseTraeWorkEntUsage,
  fetchTraeWorkLimits
} = require('../../src/shared/traeWorkLimits');

test('traeWorkAccessToken reads settings before env and trims quoted values', () => {
  assert.equal(traeWorkAccessToken({ TRAEWORK_ACCESS_TOKEN: 'env-token' }, { traeWorkAccessToken: '  "settings-token"  ' }), 'settings-token');
  assert.equal(traeWorkAccessToken({ TRAEWORK_ACCESS_TOKEN: '  "env-token"  ' }), 'env-token');
  assert.equal(traeWorkAccessToken({ TOKEN_MONITOR_TRAEWORK_ACCESS_TOKEN: 'tm-token' }), 'tm-token');
  assert.equal(traeWorkAccessToken({}), '');
});

test('traeWorkDeviceId reads settings before env', () => {
  assert.equal(traeWorkDeviceId({ TRAEWORK_DEVICE_ID: 'env-device' }, { traeWorkDeviceId: 'device-1' }), 'device-1');
  assert.equal(traeWorkDeviceId({}), '');
});

test('traeWorkEntUsageUrl points at the pay usage endpoint', () => {
  assert.equal(traeWorkEntUsageUrl(), 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage');
});

test('parseTraeWorkEntUsage aggregates credit packs into one window', () => {
  const result = parseTraeWorkEntUsage({
    is_credits_billing: true,
    user_entitlement_pack_list: [
      { entitlement_base_info: { quota: { credits_limit: 2000 } }, usage: { credits_amount: 300 } },
      { entitlement_base_info: { quota: { credits_limit: 4000 } }, usage: { credits_amount: 1200 } }
    ]
  });
  assert.equal(result.packCount, 2);
  assert.equal(result.window.limit, 6000);
  assert.equal(result.window.used, 1500);
  assert.equal(result.window.remaining, 4500);
  assert.equal(result.window.usedPercent, 25);
  assert.equal(result.window.label, 'Credits');
});

test('parseTraeWorkEntUsage skips packs without a positive limit', () => {
  const result = parseTraeWorkEntUsage({
    user_entitlement_pack_list: [
      { entitlement_base_info: { quota: { credits_limit: 0 } }, usage: { credits_amount: 10 } },
      { entitlement_base_info: { quota: { credits_limit: 100 } }, usage: { credits_amount: 20 } }
    ]
  });
  assert.equal(result.packCount, 1);
  assert.equal(result.window.limit, 100);
});

test('parseTraeWorkEntUsage throws when no usable packs exist', () => {
  assert.throws(() => parseTraeWorkEntUsage({ user_entitlement_pack_list: [] }), /no usable credit packs/);
});

test('fetchTraeWorkLimits returns notConfigured without credentials', async () => {
  const result = await fetchTraeWorkLimits({}, { env: {} });
  assert.equal(result.provider, 'traework');
  assert.equal(result.status, 'notConfigured');
  assert.deepEqual(result.windows, []);
});

test('fetchTraeWorkLimits reports ok with a valid response', async () => {
  const calls = [];
  const deps = {
    env: {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          is_credits_billing: true,
          user_entitlement_pack_list: [
            { entitlement_base_info: { quota: { credits_limit: 2000 } }, usage: { credits_amount: 500 } }
          ]
        })
      };
    }
  };
  const result = await fetchTraeWorkLimits({
    traeWorkAccessToken: 'token-1',
    traeWorkDeviceId: 'device-1'
  }, deps);
  assert.equal(result.provider, 'traework');
  assert.equal(result.status, 'ok');
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].remaining, 1500);
  const [call] = calls;
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Cloud-IDE-JWT token-1');
  assert.equal(call.init.headers['X-User-Region'], 'CN');
  assert.equal(call.init.headers['X-Device-Id'], 'device-1');
});

test('fetchTraeWorkLimits maps 403 to unauthorized', async () => {
  const deps = {
    env: {},
    fetch: async () => ({ ok: false, status: 403 })
  };
  const result = await fetchTraeWorkLimits({ traeWorkAccessToken: 'token-1' }, deps);
  assert.equal(result.provider, 'traework');
  assert.equal(result.status, 'unauthorized');
});
