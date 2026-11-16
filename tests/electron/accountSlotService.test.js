'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountSlotService, invalidateAccountSlotChange } = require('../../src/electron/limits/accountSlotService');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { LIMIT_PROVIDER_FETCHERS } = require('../../src/shared/limits/registry');
const { limitsAccountConfig } = require('../../src/electron/limits/accountSettings');
const { hashKey } = require('../../src/shared/hashKey');
const balance = { balance_infos: [{ currency: 'USD', total_balance: '10', topped_up_balance: '10' }] };
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
function harness(extra = {}) {
  let settings = { limitsEnabled: true, limitProviders: 'deepseek,qoder', qoderSite: 'global' };
  let fetcher = async () => response(balance);
  let changed = () => {};
  const writes = [];
  const service = createAccountSlotService({ getSettings: () => settings, env: {},
    write: async patch => { writes.push(patch); settings = { ...settings, ...patch }; },
    probeDeps: () => ({ fetch: (...args) => fetcher(...args) }),
    onChanged: (provider, change) => changed(provider, change), ...extra });
  return { service, writes, get settings() { return settings; }, set settings(value) { settings = value; },
    set fetch(value) { fetcher = value; }, set changed(value) { changed = value; } };
}
const add = h => h.service.add('deepseek', { deepseekApiKey: 'SECRET-one' }, 'First');
test('serialized add, rename, pause, order, remove; all results redact values', async () => {
  const h = harness();
  const [a, b] = await Promise.all([add(h), h.service.add('deepseek', { deepseekApiKey: 'SECRET-two' }, 'Second')]);
  assert.equal(a.saved, true); assert.equal(b.accounts.length, 2);
  const [first, second] = b.accounts;
  const results = [a, b, await h.service.rename('deepseek', first.id, 'Renamed'),
    await h.service.setEnabled('deepseek', first.id, false), await h.service.move('deepseek', second.id, 'up')];
  assert.equal(h.service.list('deepseek').accounts[0].id, second.id);
  assert.equal(h.service.list('deepseek').accounts[1].enabled, false);
  results.push(await h.service.remove('deepseek', first.id));
  assert.equal(h.settings.deepseekAccountSlots.length, 1);
  assert.ok(!JSON.stringify(results).includes('SECRET'));
  assert.ok(!JSON.stringify(results).includes('values'));
  assert.equal((await h.service.setEnabled('deepseek', second.id, 'false')).ok, false);
  assert.equal(h.service.list('claude').ok, false);
});
test('probe invalid, incomplete, indeterminate; credential replacement continues history', async () => {
  const h = harness();
  assert.equal((await h.service.add('deepseek', {})).verdict, 'invalid');
  h.fetch = async () => response({}, 401);
  assert.equal((await add(h)).saved, false); assert.equal(h.writes.length, 0);
  h.fetch = async () => { throw new Error('SECRET-error'); };
  const result = await add(h); assert.equal(result.verdict, 'indeterminate');
  const id = result.accounts[0].id;
  h.fetch = async () => response(balance);
  await h.service.replace('deepseek', id, { deepseekApiKey: 'SECRET-old' });
  const old = h.settings.deepseekAccountSlots[0].accountKey;
  const replaced = await h.service.replace('deepseek', id, { deepseekApiKey: 'SECRET-new' });
  assert.equal(replaced.saved, true);
  assert.ok(h.settings.deepseekAccountSlots[0].accountKeyAliases.includes(old));
  assert.ok(!JSON.stringify(replaced).includes('SECRET'));
});
test('Qoder proven server identity differs and is never merged; cookie fallback remains replaceable', async () => {
  const h = harness(); let userId = 'one';
  h.fetch = async (url) => url.includes('/organization-shared-usages/') ? response({}, 404) : response({ userId, total_quota: { quota_summary: { limit_value: 100, used_value: 1, remaining_value: 99 } } });
  const a = await h.service.add('qoder', { qoderCookie: 'token=one', qoderSite: 'global' });
  assert.equal(a.saved, true);
  const id = a.accounts[0].id, old = h.settings.qoderAccountSlots[0].accountKey;
  for (let i = 0; i < 10; i += 1) await h.service.replace('qoder', id, { qoderCookie: `token=rotated${i}`, qoderSite: 'global' });
  userId = 'two';
  assert.equal((await h.service.replace('qoder', id, { qoderCookie: 'token=two', qoderSite: 'global' })).verdict, 'differentAccount');
  assert.equal(h.settings.qoderAccountSlots[0].accountKey, old);
  // There is no override: a different proven account is added as its own account.
  assert.equal((await h.service.replace('qoder', id, { qoderCookie: 'token=two', qoderSite: 'global' }, true)).verdict, 'differentAccount');
  assert.equal((await h.service.add('qoder', { qoderCookie: 'token=two', qoderSite: 'global' })).saved, true);
  assert.equal(h.settings.qoderAccountSlots.length, 2);
  assert.ok(!h.settings.qoderAccountSlots[1].accountKeyAliases.includes(old));
  userId = '';
  assert.equal((await h.service.replace('qoder', id, { qoderCookie: 'token=fallback', qoderSite: 'global' })).saved, true);
});
test('identity writes reject deleted, paused and changed credentials and serialize with mutations', async () => {
  const h = harness(); const a = await add(h); const id = a.accounts[0].id;
  const values = h.settings.deepseekAccountSlots[0].values;
  const identity = { accountKey: hashKey('resolved'), accountKeyAliases: [] };
  assert.equal(await h.service.resolved('deepseek', id, identity, values), true);
  assert.equal(h.settings.deepseekAccountSlots[0].accountKey, identity.accountKey);
  await h.service.replace('deepseek', id, { deepseekApiKey: 'changed' });
  assert.equal(await h.service.resolved('deepseek', id, identity, values), false);
  await h.service.setEnabled('deepseek', id, false);
  assert.equal(await h.service.resolved('deepseek', id, identity, h.settings.deepseekAccountSlots[0].values), false);
  const removal = h.service.remove('deepseek', id);
  const late = h.service.resolved('deepseek', id, identity, values);
  await removal; assert.equal(await late, false); assert.deepEqual(h.settings.deepseekAccountSlots, []);
});
test('real runtime default identity survives restart and rejects a changed default credential', async () => {
  const h = harness(); h.settings = { ...h.settings, deepseekApiKey: 'default' };
  let fail = false;
  const deps = { env: {}, autoStart: false, autoRetry: false, probe: true,
    fetch: async () => { if (fail) throw new Error('offline'); return response(balance); },
    onAccountSlotResolved: (...args) => h.service.resolved(...args) };
  let runtime = createLimitsRuntime(limitsAccountConfig(h.settings, { env: {} }), deps);
  await runtime.refresh({}, 'settings-change');
  // Flush the service lane by enqueueing a read-independent resolution.
  await h.service.resolved('unsupported', '', {}, {});
  runtime.stop(); fail = true;
  assert.equal(h.settings.deepseekDefaultAccountIdentity.accountKey, hashKey('deepseek', 'default'));
  runtime = createLimitsRuntime({ ...limitsAccountConfig(h.settings, { env: {} }), limitProviders: 'deepseek' }, deps);
  try {
    await runtime.refresh({}, 'settings-change');
    assert.equal(runtime.getSnapshot().providers[0].accountKey, hashKey('deepseek', 'default'));
    h.settings = { ...h.settings, deepseekApiKey: 'other' };
    assert.equal(await h.service.resolved('deepseek', null, { accountKey: 'stale', accountKeyAliases: [] }, { deepseekApiKey: 'default', deepseekWebToken: '' }), false);
  } finally { runtime.stop(); }
});
test('real settings-change invalidation removes last slot row; pause/resume and multi-account signal clear', async () => {
  const h = harness(); h.settings = { ...h.settings, deepseekApiKey: 'default' };
  const config = () => ({ ...limitsAccountConfig(h.settings, { env: {} }), limitProviders: 'deepseek' });
  const runtime = createLimitsRuntime(config(), { env: {}, autoStart: false, autoRetry: false, probe: true,
    providerFetchers: { deepseek: LIMIT_PROVIDER_FETCHERS.deepseek }, fetch: async () => response(balance) });
  let refresh;
  h.changed = (provider, change) => {
    runtime.reconfigure(config());
    refresh = invalidateAccountSlotChange({ clearLimits: runtime.clear, refreshLimits: runtime.refresh }, provider, change);
    return refresh;
  };
  try {
    const a = await add(h); await refresh; const id = a.accounts[0].id;
    assert.equal(runtime.getSnapshot().providers.length, 2);
    assert.deepEqual(runtime.getSnapshot().multiAccountProviders, ['deepseek']);
    await h.service.setEnabled('deepseek', id, false); await refresh;
    assert.equal(runtime.getSnapshot().providers.length, 1); assert.equal(runtime.getSnapshot().multiAccountProviders, undefined);
    await h.service.setEnabled('deepseek', id, true); await refresh;
    assert.equal(runtime.getSnapshot().providers.length, 2);
    await h.service.remove('deepseek', id); await refresh;
    assert.equal(runtime.getSnapshot().providers.length, 1); assert.equal(runtime.getSnapshot().multiAccountProviders, undefined);
  } finally { runtime.stop(); }
});
test('queued removal cannot overtake an in-flight credential probe', async () => {
  const h = harness(); const a = await add(h); const id = a.accounts[0].id;
  let release; let started;
  const ready = new Promise(resolve => { started = resolve; });
  h.fetch = async () => { started(); await new Promise(resolve => { release = resolve; }); return response(balance); };
  const replacing = h.service.replace('deepseek', id, { deepseekApiKey: 'next' });
  await ready;
  const removing = h.service.remove('deepseek', id);
  assert.equal(h.settings.deepseekAccountSlots[0].values.deepseekApiKey, 'SECRET-one');
  release(); await replacing; await removing;
  assert.deepEqual(h.settings.deepseekAccountSlots, []);
});
test('slot cap, invalid provider and failed atomic store write expose bounded errors', async () => {
  const h = harness();
  h.settings = { ...h.settings, deepseekAccountSlots: Array.from({ length: 20 }, (_, i) => ({ id: `slot${i}`, values: { deepseekApiKey: 'secret' } })) };
  assert.equal((await add(h)).errorCode, 'slotLimit');
  assert.equal((await h.service.add('__proto__', {})).errorCode, 'unsupportedProvider');
  const failing = harness({ write: () => { throw new Error('SECRET disk path'); } });
  assert.deepEqual(await add(failing), { ok: false, errorCode: 'credentialStorageUnavailable' });
  assert.equal(failing.settings.deepseekAccountSlots, undefined);
});
test('settings-change clears removed account immediately while the replacement refresh is pending', async () => {
  const h = harness(); h.settings = { ...h.settings, deepseekApiKey: 'default' };
  await add(h);
  let release; let block = false;
  const config = () => ({ ...limitsAccountConfig(h.settings, { env: {} }), limitProviders: 'deepseek' });
  const runtime = createLimitsRuntime(config(), { env: {}, autoStart: false, autoRetry: false, probe: true,
    fetch: async () => { if (block) await new Promise(resolve => { release = resolve; }); return response(balance); } });
  let refresh;
  h.changed = (provider, change) => {
    runtime.reconfigure(config());
    refresh = invalidateAccountSlotChange({ clearLimits: runtime.clear, refreshLimits: runtime.refresh }, provider, change);
    return refresh;
  };
  try {
    await runtime.refresh({}, 'settings-change');
    assert.equal(runtime.getSnapshot().providers.length, 2);
    block = true;
    await h.service.remove('deepseek', h.service.list('deepseek').accounts[0].id);
    assert.equal(runtime.getSnapshot().providers.length, 1);
    assert.equal(runtime.getSnapshot().providers[0].windows.length, 1);
    block = false; release?.(); await refresh;
    assert.equal(runtime.getSnapshot().providers.length, 1);
  } finally { block = false; release?.(); runtime.stop(); }
});

test('slot edits offline preserve sibling readings and update local label and order', async () => {
  const h = harness(); h.settings = { ...h.settings, deepseekApiKey: 'default' };
  const a = await add(h), b = await h.service.add('deepseek', { deepseekApiKey: 'SECRET-two' }, 'Second');
  const id = a.accounts[0].id, second = b.accounts[1].id;
  let offline = false, refresh;
  const config = () => ({ ...limitsAccountConfig(h.settings, { env: {} }), limitProviders: 'deepseek' });
  const runtime = createLimitsRuntime(config(), { env: {}, autoStart: false, autoRetry: false, probe: true,
    fetch: async () => { if (offline) throw new Error('offline'); return response(balance); } });
  h.changed = (provider, change) => {
    runtime.reconfigure(config());
    refresh = invalidateAccountSlotChange({ clearLimits: runtime.clear, refreshLimits: runtime.refresh }, provider, change);
    return refresh;
  };
  const retained = () => {
    const rows = runtime.getSnapshot().providers;
    for (const key of [hashKey('deepseek', 'default'), hashKey('deepseek', 'SECRET-two')]) {
      assert.equal(rows.find(row => row.accountKey === key)?.windows.length, 1);
    }
    return rows;
  };
  try {
    await runtime.refresh({}, 'settings-change'); offline = true;
    await h.service.rename('deepseek', id, 'Renamed'); await refresh;
    assert.equal(retained().find(row => row.accountKey === hashKey('deepseek', 'SECRET-one')).accountName, 'Renamed');
    await h.service.move('deepseek', second, 'up'); await refresh;
    assert.deepEqual(retained().map(row => row.accountKey), ['default', 'SECRET-two', 'SECRET-one'].map(key => hashKey('deepseek', key)));
    await h.service.setEnabled('deepseek', id, false); await refresh;
    assert.equal(retained().length, 2);
    await h.service.setEnabled('deepseek', id, true); await refresh;
    retained();
    await h.service.add('deepseek', { deepseekApiKey: 'SECRET-three' }, 'Third'); await refresh;
    retained();
    await h.service.replace('deepseek', id, { deepseekApiKey: 'replacement' }); await refresh;
    retained();
    await h.service.remove('deepseek', id); await refresh;
    assert.equal(retained().length, 3);
  } finally { runtime.stop(); }
});

test('a replacement saved offline keeps the proof that the slot is a Qoder server account', async () => {
  const h = harness(); let userId = 'one';
  const online = async url => url.includes('/organization-shared-usages/') ? response({}, 404)
    : response({ userId, total_quota: { quota_summary: { limit_value: 100, used_value: 1, remaining_value: 99 } } });
  h.fetch = online;
  const a = await h.service.add('qoder', { qoderCookie: 'token=one', qoderSite: 'global' });
  const id = a.accounts[0].id;
  h.fetch = async () => { throw new Error('offline'); };
  assert.equal((await h.service.replace('qoder', id, { qoderCookie: 'token=offline', qoderSite: 'global' })).verdict, 'indeterminate');
  h.fetch = online; userId = 'two';
  const replaced = await h.service.replace('qoder', id, { qoderCookie: 'token=two', qoderSite: 'global' });
  assert.equal(replaced.verdict, 'differentAccount');
  assert.equal(replaced.saved, false);
});

test('quoted Qoder cookie still proves a different server account', async () => {
  const h = harness(); let userId = 'one';
  h.fetch = async url => url.includes('/organization-shared-usages/') ? response({}, 404)
    : response({ userId, total_quota: { quota_summary: { limit_value: 100, used_value: 1, remaining_value: 99 } } });
  const a = await h.service.add('qoder', { qoderCookie: "\"'token=one'\"", qoderSite: 'global' });
  assert.equal(a.saved, true);
  userId = 'two';
  const replaced = await h.service.replace('qoder', a.accounts[0].id, { qoderCookie: 'token=two', qoderSite: 'global' });
  assert.equal(replaced.verdict, 'differentAccount');
  assert.equal(replaced.saved, false);
});

test('replaced Qoder credential cannot reuse remembered identity on keyless failure', async () => {
  const h = harness(); let userId = 'one';
  const transport = async url => url.includes('/organization-shared-usages/') ? response({}, 404)
    : response({ userId, total_quota: { quota_summary: { limit_value: 100, used_value: 1, remaining_value: 99 } } });
  h.fetch = transport;
  const a = await h.service.add('qoder', { qoderCookie: 'token=one', qoderSite: 'global' });
  let offline = false;
  const config = () => ({ ...limitsAccountConfig(h.settings, { env: {} }), limitProviders: 'qoder' });
  const runtime = createLimitsRuntime(config(), { env: {}, autoStart: false, autoRetry: false,
    fetch: async (...args) => { if (offline) throw new Error('offline'); return transport(...args); } });
  try {
    await runtime.refresh({}, 'settings-change');
    const old = runtime.getSnapshot().providers[0].accountKey;
    // A replacement that cannot prove a different account (no user id) is saved under a new key.
    userId = '';
    await h.service.replace('qoder', a.accounts[0].id, { qoderCookie: 'token=two', qoderSite: 'global' });
    const key = h.settings.qoderAccountSlots[0].accountKey; assert.notEqual(key, old);
    offline = true; runtime.reconfigure(config());
    await runtime.refresh({}, 'settings-change');
    assert.deepEqual(runtime.getSnapshot().providers.map(row => row.accountKey), [key]);
  } finally { runtime.stop(); }
});

for (const operation of ['replace', 'remove', 'disable']) test(`late slot dispatch after ${operation} cannot publish or persist old identities`, async () => {
  const h = harness(); const added = await add(h); const id = added.accounts[0].id;
  let release, started, refresh;
  const ready = new Promise(resolve => { started = resolve; });
  const observations = [], states = [], published = [];
  const { createAccountSlotFetcher } = require('../../src/shared/limits/accountSlotFetcher');
  const { limitProviderEntry } = require('../../src/shared/limits/registry');
  const fetcher = createAccountSlotFetcher({ ...limitProviderEntry('deepseek'), fetchLimits: async (options, deps) => {
    states.push(deps.providerRuntimeState);
    if (options.deepseekApiKey === 'SECRET-one') {
      started(); await new Promise(resolve => { release = resolve; });
      return { provider: 'deepseek', status: 'ok', accountKey: 'LATE', accountKeyAliases: ['LATE-ALIAS'], windows: [] };
    }
    return { provider: 'deepseek', status: 'ok', accountKey: hashKey('deepseek', options.deepseekApiKey), windows: [] };
  } });
  const config = () => ({ ...limitsAccountConfig(h.settings, { env: {} }), limitProviders: 'deepseek' });
  const runtime = createLimitsRuntime(config(), { env: {}, autoStart: false, autoRetry: false,
    providerFetchers: { deepseek: fetcher }, onUpdate: snapshot => published.push(snapshot),
    onAccountSlotResolved: (...args) => { observations.push(args); return h.service.resolved(...args); } });
  h.changed = (provider, change) => {
    runtime.reconfigure(config());
    refresh = invalidateAccountSlotChange({ clearLimits: runtime.clear, refreshLimits: runtime.refresh }, provider, change);
    return refresh;
  };
  try {
    const old = runtime.refresh({}, 'settings-change'); await ready;
    if (operation === 'replace') await h.service.replace('deepseek', id, { deepseekApiKey: 'new' });
    else if (operation === 'remove') await h.service.remove('deepseek', id);
    else await h.service.setEnabled('deepseek', id, false);
    release(); await old; published.push(runtime.getSnapshot()); await refresh;
    await h.service.resolved('unsupported', '', {}, {});
    published.push(runtime.getSnapshot());
    assert.ok(!JSON.stringify([published, observations, h.settings, states.map(state => [...state.values()])]).includes('LATE'));
    if (operation === 'remove') assert.deepEqual(h.settings.deepseekAccountSlots, []);
    else if (operation === 'disable') assert.equal(h.settings.deepseekAccountSlots[0].enabled, false);
    else assert.deepEqual(runtime.getSnapshot().providers.map(row => row.accountKey), [hashKey('deepseek', 'new')]);
  } finally { release?.(); runtime.stop(); }
});

test('a slot whose id is "default" is still a slot, and the default identity is untouched', async () => {
  const h = harness();
  h.settings = { ...h.settings, deepseekAccountSlots: [{ id: 'default', values: { deepseekApiKey: 'SECRET-slot' } }] };
  const identity = { accountKey: hashKey('slot-account'), accountKeyAliases: [] };
  assert.equal(await h.service.resolved('deepseek', 'default', identity, { deepseekApiKey: 'SECRET-slot' }), true);
  assert.equal(h.settings.deepseekAccountSlots[0].accountKey, identity.accountKey);
  assert.equal(h.settings.deepseekDefaultAccountIdentity, undefined);
});

test('a replacement changes only the fields it names, and needs an existing id', async () => {
  const h = harness(); let userId = 'one';
  h.fetch = async url => url.includes('/organization-shared-usages/') ? response({}, 404)
    : response({ userId, total_quota: { quota_summary: { limit_value: 100, used_value: 1, remaining_value: 99 } } });
  const a = await h.service.add('qoder', { qoderCookie: 'token=one', qoderSite: 'cn' });
  const id = a.accounts[0].id;
  assert.equal((await h.service.replace('qoder', id, { qoderCookie: 'token=again' })).saved, true);
  assert.equal(h.settings.qoderAccountSlots[0].values.qoderSite, 'cn');
  for (const missing of ['', undefined, 'nope']) {
    assert.equal((await h.service.replace('qoder', missing, { qoderCookie: 'token=x' })).errorCode, 'accountNotFound');
  }
  assert.equal(h.settings.qoderAccountSlots.length, 1);
});

test('a Qoder proof survives an answer without a user id, and its own old key still counts as itself', async () => {
  const h = harness(); let userId = 'one';
  h.fetch = async url => url.includes('/organization-shared-usages/') ? response({}, 404)
    : response({ ...(userId ? { userId } : {}), total_quota: { quota_summary: { limit_value: 100, used_value: 1, remaining_value: 99 } } });
  const a = await h.service.add('qoder', { qoderCookie: 'token=one', qoderSite: 'global' });
  const id = a.accounts[0].id; const proven = h.settings.qoderAccountSlots[0].accountKey;
  userId = '';
  assert.equal((await h.service.replace('qoder', id, { qoderCookie: 'token=anon' })).saved, true);
  assert.equal(h.settings.qoderAccountSlots[0].serverIdentity, true);
  userId = 'two';
  assert.equal((await h.service.replace('qoder', id, { qoderCookie: 'token=two' })).verdict, 'differentAccount');
  userId = 'one';
  const back = await h.service.replace('qoder', id, { qoderCookie: 'token=one-again' });
  assert.equal(back.saved, true);
  assert.equal(h.settings.qoderAccountSlots[0].accountKey, proven);
});

test('renaming and reordering re-project rows without asking the provider again', async () => {
  const h = harness(); const changes = [];
  h.changed = (provider, change) => changes.push([provider, change.refresh]);
  const a = await add(h); const b = await h.service.add('deepseek', { deepseekApiKey: 'SECRET-two' }, 'Second');
  const id = a.accounts[0].id; changes.length = 0;
  await h.service.rename('deepseek', id, 'Renamed');
  await h.service.move('deepseek', b.accounts[1].id, 'up');
  await h.service.setEnabled('deepseek', id, false);
  await h.service.remove('deepseek', id);
  assert.deepEqual(changes, [['deepseek', false], ['deepseek', false], ['deepseek', true], ['deepseek', true]]);
});
