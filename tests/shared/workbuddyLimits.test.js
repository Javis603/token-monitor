'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  workbuddyAccessToken,
  workbuddyUid,
  workbuddyResourceUrl,
  parseWorkbuddyResource,
  fetchWorkbuddyLimits
} = require('../../src/shared/workbuddyLimits');

test('workbuddyAccessToken reads settings before env and trims quoted values', () => {
  assert.equal(workbuddyAccessToken({ WORKBUDDY_ACCESS_TOKEN: 'env-token' }, { workbuddyAccessToken: '  "settings-token"  ' }), 'settings-token');
  assert.equal(workbuddyAccessToken({ WORKBUDDY_ACCESS_TOKEN: '  "env-token"  ' }), 'env-token');
  assert.equal(workbuddyAccessToken({ TOKEN_MONITOR_WORKBUDDY_ACCESS_TOKEN: 'tm-token' }), 'tm-token');
  assert.equal(workbuddyAccessToken({}), '');
});

test('workbuddyUid reads settings before env', () => {
  assert.equal(workbuddyUid({ WORKBUDDY_UID: 'env-uid' }, { workbuddyUid: 'uid-1' }), 'uid-1');
  assert.equal(workbuddyUid({ WORKBUDDY_UID: 'env-uid' }), 'env-uid');
  assert.equal(workbuddyUid({}), '');
});

test('workbuddyResourceUrl points at the billing meter endpoint', () => {
  assert.equal(workbuddyResourceUrl(), 'https://copilot.tencent.com/v2/billing/meter/get-user-resource');
});

test('parseWorkbuddyResource maps credit packages to limit windows', () => {
  const windows = parseWorkbuddyResource({
    code: 0,
    data: {
      Response: {
        Data: {
          Accounts: [
            {
              PackageCode: 'proMon',
              PackageName: 'Pro Monthly',
              CycleCapacitySizePrecise: '2000',
              CycleCapacityRemainPrecise: '1500',
              CycleEndTime: '2026-09-01T00:00:00Z'
            },
            {
              PackageCode: 'bonus28',
              PackageName: 'Bonus',
              CycleCapacitySizePrecise: '500',
              CycleCapacityRemainPrecise: '200',
              CycleEndTime: '2026-08-20T00:00:00Z'
            }
          ]
        }
      }
    }
  });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].label, 'Pro Monthly');
  assert.equal(windows[0].used, 500);
  assert.equal(windows[0].limit, 2000);
  assert.equal(windows[0].remaining, 1500);
  assert.equal(windows[0].usedPercent, 25);
  assert.equal(windows[0].resetsAt, '2026-09-01T00:00:00.000Z');
  assert.equal(windows[1].label, 'Bonus');
  assert.equal(windows[1].used, 300);
});

test('parseWorkbuddyResource throws when no usable packages exist', () => {
  assert.throws(() => parseWorkbuddyResource({ data: { Response: { Data: { Accounts: [] } } } }), /no usable credit packages/);
});

test('fetchWorkbuddyLimits returns notConfigured without credentials', async () => {
  const result = await fetchWorkbuddyLimits({}, { env: {} });
  assert.equal(result.provider, 'workbuddy');
  assert.equal(result.status, 'notConfigured');
  assert.deepEqual(result.windows, []);
});

test('fetchWorkbuddyLimits reports ok with a valid response', async () => {
  const calls = [];
  const deps = {
    env: {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            Response: {
              Data: {
                Accounts: [
                  { PackageCode: 'proMon', PackageName: 'Pro Monthly', CycleCapacitySizePrecise: '1000', CycleCapacityRemainPrecise: '400', CycleEndTime: '2026-09-01T00:00:00Z' }
                ]
              }
            }
          }
        })
      };
    }
  };
  const result = await fetchWorkbuddyLimits({
    workbuddyAccessToken: 'token-1',
    workbuddyUid: 'uid-1'
  }, deps);
  assert.equal(result.provider, 'workbuddy');
  assert.equal(result.status, 'ok');
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].remaining, 400);
  const [call] = calls;
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer token-1');
  assert.equal(call.init.headers['X-User-Id'], 'uid-1');
  const body = JSON.parse(call.init.body);
  assert.equal(body.ProductCode, 'p_tcaca');
});

test('fetchWorkbuddyLimits maps 401 to unauthorized', async () => {
  const deps = {
    env: {},
    fetch: async () => ({ ok: false, status: 401 })
  };
  const result = await fetchWorkbuddyLimits({
    workbuddyAccessToken: 'token-1',
    workbuddyUid: 'uid-1'
  }, deps);
  assert.equal(result.provider, 'workbuddy');
  assert.equal(result.status, 'unauthorized');
});
