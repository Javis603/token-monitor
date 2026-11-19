'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const volc = require('../../src/shared/providers/volcengine/limits');
const ali = require('../../src/shared/providers/alibaba/limits');
const { LIMIT_PROVIDER_FETCHERS } = require('../../src/shared/limits/registry');
function bailian() {
  const calls = [];
  return { calls, env: { PATH: '/cli' }, platform: 'linux', existsSync: p => p === '/cli/bl',
    execFile(_cmd, args, _opts, cb) {
      calls.push(args);
      const child = new EventEmitter(); child.stdin = { end() {} }; child.kill = () => {};
      queueMicrotask(() => cb(null, JSON.stringify({ Success: true, Data: { Items: [], Total: 0, PageNo: 1, PageSize: 10 } })));
      return child;
    },
    fetch: async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => '{}'  }) };
}
function arkcli() {
  const calls = [];
  return { calls, env: {}, runArkcli: async args => {
    calls.push(args);
    if (args[0] === 'auth') return { logged_in: true, auth_method: 'sso', active_profile: { name: 'test' } };
    if (args[0] === 'plans') return { plans: [] };
    throw Error('unexpected quota call');
  }, fetch: () => assert.fail('CLI must not read API') };
}
test('Volcengine probe without draft credentials cannot validate using CLI', async () => {
  const f = arkcli();
  const [row] = await volc.fetchVolcengineLimits({}, { ...f, probe: true });
  assert.equal(row.status, 'notConfigured'); assert.deepEqual(f.calls, []);
});
test('Volcengine saved slot preserves its API failure without consulting CLI', async () => {
  const f = arkcli();
  const [row] = await volc.fetchVolcengineLimits({ volcengineApiKey: 'saved' }, {
    ...f, accountSlotSaved: true, accountSlotId: 'saved', fetch: async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => '{}'  }) });
  assert.equal(row.status, 'unauthorized'); assert.deepEqual(f.calls, []);
});
test('Alibaba draft probe and saved/environment slots read their own cookie', async () => {
  for (const extra of [{ probe: true }, { accountSlotSaved: true, accountSlotId: 'saved' }, { accountSlotSaved: true, accountSlotId: 'environment' }]) {
    const f = bailian();
    const [row] = await ali.fetchAlibabaLimits({ alibabaCookie: 'a=b', alibabaVariant: 'intl-personal' }, { ...f, ...extra });
    assert.equal(row.source, 'web'); assert.equal(row.status, 'unauthorized'); assert.equal(row.region, 'intl-personal'); assert.deepEqual(f.calls, []);
  }
});
test('Alibaba slot snapshot runs CLI once and retains independent saved and env cookie rows', async () => {
  const f = bailian(); f.env.ALIBABA_TOKEN_PLAN_COOKIE = 'env=cookie';
  const rows = await LIMIT_PROVIDER_FETCHERS.alibaba({ alibabaAccountSlots: [
    { id: 'saved', values: { alibabaCookie: 'saved=cookie', alibabaVariant: 'intl-personal' } }
  ] }, f);
  assert.equal(f.calls.length, 1); assert.equal(rows.filter(r => r.source === 'cli').length, 1);
  assert.equal(rows.filter(r => r.source === 'web').length, 2);
  assert.ok(rows.some(r => r.region === 'intl-personal'));
});
test('Volcengine snapshot runs CLI once and independently queries saved API credentials', async () => {
  const f = arkcli(); let http = 0;
  f.fetch = async () => { http++; return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => '{}'  }; };
  await LIMIT_PROVIDER_FETCHERS.volcengine({ volcengineAccountSlots: [
    { id: 'one', values: { volcengineApiKey: 'saved-one' } }, { id: 'two', values: { volcengineApiKey: 'saved-two' } }
  ] }, f);
  assert.equal(f.calls.filter(a => a[0] === 'auth').length, 1); assert.equal(http, 2);
});
test('Factory draft probing cannot borrow an ambient or Droid credential', async () => {
  const { fetchFactoryLimits } = require('../../src/shared/providers/factory/limits');
  const row = await fetchFactoryLimits({}, { probe: true, env: { FACTORY_API_KEY: 'ambient' },
    fs: { lstatSync: () => assert.fail('must not discover Droid') },
    fetch: () => assert.fail('must not use ambient credential') });
  assert.equal(row.status, 'notConfigured');
});
test('the removed source preference no longer steers collection', async () => {
  // A value persisted by a pre-release build must read as automatic.
  const f = bailian(); f.env.ALIBABA_TOKEN_PLAN_COOKIE = 'env=cookie';
  const rows = await LIMIT_PROVIDER_FETCHERS.alibaba({ alibabaSourcePreference: 'web', alibabaAccountSlots: [
    { id: 'saved', values: { alibabaCookie: 'saved=cookie' } }
  ] }, f);
  assert.equal(f.calls.length, 1);
  assert.equal(rows.filter(r => r.source === 'cli').length, 1);
});
