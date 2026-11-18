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
test('only true alternative lanes declare source selection', () => {
  assert.deepEqual(require('../../src/shared/providers/volcengine/account').sourceSelection.sources, ['api', 'cli']);
  assert.deepEqual(require('../../src/shared/providers/alibaba/account').sourceSelection.sources, ['cli', 'web']);
  const factory = require('../../src/shared/providers/factory/account');
  assert.equal(factory.sourceSelection, undefined);
  assert.ok(factory.sources.every(s => s.relation === 'complement'));
});
test('Volcengine forced API without credentials cannot discover CLI', async () => {
  const f = arkcli();
  const [row] = await volc.fetchVolcengineLimits({ volcengineSourcePreference: 'api' }, f);
  assert.equal(row.status, 'notConfigured'); assert.deepEqual(f.calls, []);
});
test('Volcengine forced CLI bypasses incomplete explicit keys without HTTP fallback', async () => {
  const f = arkcli();
  await volc.fetchVolcengineLimits({ volcengineSourcePreference: 'cli', volcengineAccessKeyId: 'AKLT-incomplete' }, f);
  assert.equal(f.calls.length > 0, true);
});
test('Volcengine probe without draft credentials cannot validate using CLI', async () => {
  const f = arkcli();
  const [row] = await volc.fetchVolcengineLimits({ volcengineSourcePreference: 'cli' }, { ...f, probe: true });
  assert.equal(row.status, 'notConfigured'); assert.deepEqual(f.calls, []);
});
test('Volcengine saved slot ignores CLI preference and preserves API failure', async () => {
  const f = arkcli();
  const [row] = await volc.fetchVolcengineLimits({ volcengineSourcePreference: 'cli', volcengineApiKey: 'saved' }, {
    ...f, accountSlotSaved: true, accountSlotId: 'saved', fetch: async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => '{}'  }) });
  assert.equal(row.status, 'unauthorized'); assert.deepEqual(f.calls, []);
});
test('Alibaba forced Web cannot invoke an available CLI', async () => {
  const f = bailian();
  const [row] = await ali.fetchAlibabaLimits({ alibabaSourcePreference: 'web', alibabaCookie: 'a=b' }, f);
  assert.equal(row.status, 'unauthorized'); assert.equal(row.source, 'web'); assert.deepEqual(f.calls, []);
});
test('Alibaba forced CLI cannot fall back to a configured Cookie', async () => {
  const f = bailian(); f.existsSync = () => false; f.fetch = () => assert.fail('must not read Cookie');
  const [row] = await ali.fetchAlibabaLimits({ alibabaSourcePreference: 'cli', alibabaCookie: 'a=b' }, f);
  assert.equal(row.status, 'notConfigured'); assert.equal(row.source, 'cli');
});
test('Alibaba draft probe and saved/environment slots read their own cookie under CLI preference', async () => {
  for (const extra of [{ probe: true }, { accountSlotSaved: true, accountSlotId: 'saved' }, { accountSlotSaved: true, accountSlotId: 'environment' }]) {
    const f = bailian();
    const [row] = await ali.fetchAlibabaLimits({ alibabaSourcePreference: 'cli', alibabaCookie: 'a=b', alibabaVariant: 'intl-personal' }, { ...f, ...extra });
    assert.equal(row.source, 'web'); assert.equal(row.status, 'unauthorized'); assert.equal(row.region, 'intl-personal'); assert.deepEqual(f.calls, []);
  }
});
test('Alibaba snapshot runs CLI once and retains independent saved and env cookie rows', async () => {
  const f = bailian(); f.env.ALIBABA_TOKEN_PLAN_COOKIE = 'env=cookie';
  const rows = await LIMIT_PROVIDER_FETCHERS.alibaba({ alibabaSourcePreference: 'cli', alibabaAccountSlots: [
    { id: 'saved', values: { alibabaCookie: 'saved=cookie', alibabaVariant: 'intl-personal' } }
  ] }, f);
  assert.equal(f.calls.length, 1); assert.equal(rows.filter(r => r.source === 'cli').length, 1);
  assert.equal(rows.filter(r => r.source === 'web').length, 2);
  assert.ok(rows.some(r => r.region === 'intl-personal'));
});
test('Volcengine forced CLI without slots does not query an environment API key', async () => {
  const f = arkcli();
  f.env.ARK_API_KEY = 'environment-test-key';
  let http = 0;
  f.fetch = async () => { http++; return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) }; };
  await LIMIT_PROVIDER_FETCHERS.volcengine({ volcengineSourcePreference: 'cli' }, f);
  assert.equal(f.calls.filter(a => a[0] === 'auth').length, 1);
  assert.equal(http, 0);
});
test('Volcengine snapshot runs CLI once and independently queries saved API credentials', async () => {
  const f = arkcli(); let http = 0;
  f.fetch = async () => { http++; return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => '{}'  }; };
  await LIMIT_PROVIDER_FETCHERS.volcengine({ volcengineSourcePreference: 'cli', volcengineAccountSlots: [
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
test('Alibaba automatic slot snapshot keeps environment Cookie alongside one CLI reading', async () => {
  const f = bailian(); f.env.ALIBABA_TOKEN_PLAN_COOKIE = 'env=cookie';
  const rows = await LIMIT_PROVIDER_FETCHERS.alibaba({ alibabaAccountSlots: [
    { id: 'saved', values: { alibabaCookie: 'saved=cookie' } }
  ] }, f);
  assert.equal(f.calls.length, 1);
  assert.equal(rows.filter(r => r.source === 'cli').length, 1);
  assert.equal(rows.filter(r => r.source === 'web').length, 2);
});
test('Alibaba forced CLI query failure never uses the available Cookie', async () => {
  const f = bailian(); f.execFile = (_cmd, _args, _opts, cb) => {
    const child = new EventEmitter(); child.stdin = { end() {} }; child.kill = () => {};
    queueMicrotask(() => cb(new Error('CLI failed'), '')); return child;
  };
  f.fetch = () => assert.fail('must not fall back to Cookie');
  const [row] = await ali.fetchAlibabaLimits({ alibabaSourcePreference: 'cli', alibabaCookie: 'a=b' }, f);
  assert.equal(row.source, 'cli'); assert.equal(row.status, 'unavailable');
});
