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
  assert.equal(h.service.list('claude').ok, true);
  assert.equal((await h.service.add('claude', {})).errorCode, 'providerEditorRequired');
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
test('a new Volcengine slot cannot borrow a retained fixed secret', async () => {
  const h = harness();
  h.settings = { ...h.settings, volcengineAccessKeyId: 'AKLT-fixed', volcengineSecretAccessKey: 'fixture-fixed-secret' };
  h.fetch = async () => response({ Result: { QuotaUsage: [{ Level: 'session', Percent: 10 }] } });
  const result = await h.service.add('volcengine', { volcengineAccessKeyId: 'AKLT-new-slot' });
  assert.equal(result.saved, false);
  assert.equal(h.writes.length, 0);
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
    const a = await add(h); await refresh; const id = a.accounts.find(slot => slot.id !== 'default').id;
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
test('Volcengine Agent-only answers never adopt the saved Coding identity', async () => {
  const values = { volcengineAccessKeyId: 'AKLT-fixture', volcengineSecretAccessKey: 'fixture-secret' };
  const { accountSlotKeys } = require('../../src/shared/providers/volcengine/limits');
  const [coding, agent] = accountSlotKeys(values);
  const options = { volcengineSourcePreference: 'api', volcengineAccountSlots: [{ id: 'saved', accountKey: coding, values }] };
  const updates = [];
  const fetch = async url => String(url).includes('GetAFPUsage')
    ? response({ Result: { PlanType: 'Medium', AFPFiveHour: { Quota: 200, Used: 50 } } }) : response({}, 503);
  const rows = await LIMIT_PROVIDER_FETCHERS.volcengine(options, { env: {}, fetch,
    onAccountSlotResolved: (...args) => updates.push(args) });
  assert.equal(rows.find(row => row.accountKey === agent)?.status, 'ok');
  assert.ok(!rows.find(row => row.accountKey === agent)?.accountKeyAliases?.includes(coding));
  assert.deepEqual(updates, []);
  const provisional = hashKey('volcengine', 'account-slot', 'slot:saved');
  const held = await LIMIT_PROVIDER_FETCHERS.volcengine({ ...options,
    previousLimits: { providers: [{ provider: 'volcengine', accountKey: provisional }] },
    limitRefreshScope: { provider: 'volcengine', accountKey: provisional }
  }, { env: {}, fetch });
  assert.ok(held.every(row => row.status !== 'ok' && !row.windows?.length));
  const h = harness();
  h.fetch = fetch;
  assert.equal((await h.service.add('volcengine', values)).saved, true);
  assert.notEqual(h.settings.volcengineAccountSlots[0].accountKey, agent);
});

test('scoped Volcengine Agent refresh only probes the owning slot', async () => {
  const slots = ['one', 'two'].map(id => ({ id, values: { volcengineAccessKeyId: `AKLT-${id}`, volcengineSecretAccessKey: 'fixture-secret' } }));
  const { accountSlotKeys } = require('../../src/shared/providers/volcengine/limits');
  const [, agent] = accountSlotKeys(slots[1].values);
  let calls = 0;
  const rows = await LIMIT_PROVIDER_FETCHERS.volcengine({ volcengineSourcePreference: 'api', volcengineAccountSlots: slots,
    limitRefreshScope: { provider: 'volcengine', accountKey: agent } }, { env: {}, fetch: async (url, init) => {
    calls++;
    assert.match(init.headers.Authorization, /Credential=AKLT-two\//);
    return response(String(url).includes('GetAFPUsage')
      ? { Result: { PlanType: 'Medium', AFPFiveHour: { Quota: 200, Used: 50 } } }
      : { Result: { QuotaUsage: [{ Level: 'session', Percent: 10 }] } });
  } });
  assert.equal(calls, 2);
  assert.deepEqual(rows.filter(row => row.status === 'ok').map(row => row.accountKey), [agent]);
});

test('scoped Volcengine Agent refresh can use a second matching owner', async () => {
  const slots = ['one', 'two', 'other'].map(id => ({ id, values: {
    volcengineAccessKeyId: `AKLT-${id}`, volcengineSecretAccessKey: 'fixture-secret',
    ...(id === 'other' ? {} : { volcengineAgentAccessKeyId: 'AKLT-shared', volcengineAgentSecretAccessKey: `fixture-${id}` })
  } }));
  const [, agent] = require('../../src/shared/providers/volcengine/limits').accountSlotKeys(slots[0].values);
  let agentCalls = 0, calls = 0;
  const rows = await LIMIT_PROVIDER_FETCHERS.volcengine({ volcengineSourcePreference: 'api', volcengineAccountSlots: slots,
    limitRefreshScope: { provider: 'volcengine', accountKey: agent } }, { env: {}, fetch: async url => {
    calls++;
    if (!String(url).includes('GetAFPUsage')) return response({}, 503);
    return ++agentCalls === 1 ? response({}, 403) : response({ Result: { PlanType: 'Medium', AFPFiveHour: { Quota: 200, Used: 50 } } });
  } });
  assert.equal(calls, 4);
  assert.deepEqual(rows.map(row => [row.accountKey, row.status]), [[agent, 'ok']]);
});

test('scoped Volcengine Ark fallback refresh finds a signed slot without a remembered key', async () => {
  const values = { volcengineAccessKeyId: 'AKLT-fixture', volcengineSecretAccessKey: 'fixture-secret', volcengineApiKey: 'fixture-ark' };
  const ark = hashKey('volcengine', values.volcengineApiKey, 'cn-beijing');
  const calls = [];
  const rows = await LIMIT_PROVIDER_FETCHERS.volcengine({ volcengineSourcePreference: 'api', volcengineAccountSlots: [{ id: 'fixture', values }],
    limitRefreshScope: { provider: 'volcengine', accountKey: ark } }, { env: {}, fetch: async url => {
    calls.push(String(url));
    if (String(url).includes('chat/completions')) return { ...response({}), headers: new Headers({
      'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '7'
    }) };
    return response({}, String(url).includes('GetAFPUsage') ? 404 : 503);
  } });
  assert.ok(calls.some(url => url.includes('chat/completions')));
  assert.deepEqual(rows.map(row => [row.accountKey, row.status]), [[ark, 'ok']]);
});

test('removing the last Volcengine slot retires both products but keeps environment quota', async () => {
  const env = { VOLCENGINE_ACCESS_KEY_ID: 'AKLT-env', VOLCENGINE_SECRET_ACCESS_KEY: 'env-secret' };
  const h = harness({ env });
  const values = { volcengineAccessKeyId: 'AKLT-saved', volcengineSecretAccessKey: 'saved-secret' };
  h.settings = { ...h.settings, limitProviders: 'volcengine', volcengineSourcePreference: 'api',
    volcengineAccountSlots: [{ id: 'saved', values }] };
  const config = () => ({ ...limitsAccountConfig(h.settings, { env }), limitProviders: 'volcengine' });
  const runtime = createLimitsRuntime(config(), { env, autoStart: false, autoRetry: false,
    providerFetchers: { volcengine: LIMIT_PROVIDER_FETCHERS.volcengine },
    fetch: async url => response(String(url).includes('GetAFPUsage')
      ? { Result: { PlanType: 'Medium', AFPFiveHour: { Quota: 200, Used: 50 } } }
      : { Result: { QuotaUsage: [{ Level: 'session', Percent: 10 }] } }) });
  let refresh;
  h.changed = (provider, change) => {
    runtime.reconfigure(config());
    refresh = invalidateAccountSlotChange({ clearLimits: runtime.clear, refreshLimits: runtime.refresh }, provider, change);
    return refresh;
  };
  try {
    await runtime.refresh({}, 'settings-change');
    assert.equal(runtime.getSnapshot().providers.length, 4);
    const { accountSlotKeys } = require('../../src/shared/providers/volcengine/limits');
    const owned = accountSlotKeys(values);
    await h.service.remove('volcengine', 'saved');
    await refresh;
    const rows = runtime.getSnapshot().providers;
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.status === 'ok' && !owned.includes(row.accountKey)));
  } finally { runtime.stop(); }
});
test('removing a Volcengine slot keeps a shared Agent Plan owned by fixed settings', async () => {
  const h = harness();
  const agent = { volcengineAgentAccessKeyId: 'AKLT-agent', volcengineAgentSecretAccessKey: 'agent-secret' };
  const values = { ...agent, volcengineAccessKeyId: 'AKLT-saved', volcengineSecretAccessKey: 'saved-secret' };
  h.settings = { ...h.settings, ...agent, volcengineAccessKeyId: 'AKLT-fixed', volcengineSecretAccessKey: 'fixed-secret',
    volcengineAccountSlots: [{ id: 'saved', values }] };
  let retired;
  h.changed = (_provider, change) => { retired = change.retiredAccountKeys; };
  const { accountSlotKeys } = require('../../src/shared/providers/volcengine/limits');
  const [coding, sharedAgent] = accountSlotKeys(values);
  await h.service.remove('volcengine', 'saved');
  assert.ok(retired.includes(coding));
  assert.ok(!retired.includes(sharedAgent));
});
test('removing the final Volcengine slot under forced CLI retires the fixed API lane', async () => {
  const h = harness();
  const agent = { volcengineAgentAccessKeyId: 'AKLT-agent', volcengineAgentSecretAccessKey: 'agent-secret' };
  const values = { ...agent, volcengineAccessKeyId: 'AKLT-saved', volcengineSecretAccessKey: 'saved-secret' };
  h.settings = { ...h.settings, ...agent, limitProviders: 'volcengine', volcengineSourcePreference: 'cli',
    volcengineAccessKeyId: 'AKLT-fixed', volcengineSecretAccessKey: 'fixed-secret',
    volcengineAccountSlots: [{ id: 'saved', values }] };
  const config = () => ({ ...limitsAccountConfig(h.settings, { env: {} }), limitProviders: 'volcengine' });
  let apiRequests = 0;
  const runtime = createLimitsRuntime(config(), { env: {}, autoStart: false, autoRetry: false,
    providerFetchers: { volcengine: LIMIT_PROVIDER_FETCHERS.volcengine },
    runArkcli: async args => {
      if (args[0] === 'auth') return { logged_in: true, auth_method: 'sso', active_profile: { name: 'personal' } };
      if (args[0] === 'plans') return { plans: [{ key: 'agent-plan', scope: 'personal', status: 'Running' }] };
      return { viewer: { account_id: 'cli-viewer', region: 'cn-beijing' }, items: [
        { product: 'agent-plan', subscribed: true, tier: 'medium', periods: [{ label: '5h', used: 10, total: 100 }] }
      ] };
    },
    fetch: async url => {
      apiRequests++;
      return response(String(url).includes('GetAFPUsage')
        ? { Result: { PlanType: 'Medium', AFPFiveHour: { Quota: 200, Used: 50 } } }
        : { Result: { QuotaUsage: [{ Level: 'session', Percent: 10 }] } });
    } });
  let refresh;
  h.changed = (provider, change) => {
    runtime.reconfigure(config());
    refresh = invalidateAccountSlotChange({ clearLimits: runtime.clear, refreshLimits: runtime.refresh }, provider, change);
    return refresh;
  };
  try {
    await runtime.refresh({}, 'settings-change');
    const before = runtime.getSnapshot().providers;
    assert.equal(before.filter(row => row.source === 'api' && row.status === 'ok').length, 3);
    const cli = before.find(row => row.source === 'cli');
    assert.equal(cli?.status, 'ok');

    apiRequests = 0;
    await h.service.remove('volcengine', 'saved');
    await refresh;

    assert.equal(apiRequests, 0);
    assert.deepEqual(runtime.getSnapshot().providers.map(row => [row.accountKey, row.source, row.status]),
      [[cli.accountKey, 'cli', 'ok']]);
  } finally { runtime.stop(); }
});
test('Alibaba accounts with a shared UID rename and order their own console plans', async () => {
  const h = harness();
  h.settings = { ...h.settings, alibabaAccountSlots: [
    { id: 'team', label: 'Team', accountKey: 'same-uid', values: { alibabaCookie: 'team-cookie', alibabaVariant: 'cn' } },
    { id: 'personal', label: 'Personal', accountKey: 'same-uid', values: { alibabaCookie: 'personal-cookie', alibabaVariant: 'cn-personal' } }
  ] };
  assert.equal((await h.service.rename('alibaba', 'personal', 'Solo')).ok, true);
  const group = h.settings.limitAccountPresentation.alibaba;
  assert.deepEqual(group.labels, { 'same-uid:cn-personal': 'Solo' });
  const list = h.service.list('alibaba').accounts;
  assert.deepEqual(list.map(slot => [slot.accountKey, slot.label]), [['same-uid', 'Team'], ['same-uid', 'Solo']]);
  const reversed = list.map(slot => slot.presentationKey).reverse();
  await h.service.presentation('alibaba', reversed[0], 'order', reversed);
  assert.deepEqual(h.service.list('alibaba').accounts.map(slot => slot.id), ['personal', 'team']);
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
  h.settings = { ...h.settings, deepseekAccountSlots: Array.from({ length: 21 }, (_, i) => ({ id: `slot${i}`, values: { deepseekApiKey: 'secret' } })) };
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
    await h.service.remove('deepseek', h.service.list('deepseek').accounts.find(slot => slot.id !== 'default').id);
    assert.equal(runtime.getSnapshot().providers.length, 1);
    assert.equal(runtime.getSnapshot().providers[0].windows.length, 1);
    block = false; release?.(); await refresh;
    assert.equal(runtime.getSnapshot().providers.length, 1);
  } finally { block = false; release?.(); runtime.stop(); }
});

test('slot edits offline preserve sibling readings and update local label and order', async () => {
  const h = harness(); h.settings = { ...h.settings, deepseekApiKey: 'default' };
  const a = await add(h), b = await h.service.add('deepseek', { deepseekApiKey: 'SECRET-two' }, 'Second');
  const id = a.accounts.find(slot => slot.id !== 'default').id, second = b.accounts.at(-1).id;
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
    assert.deepEqual(retained().map(row => row.accountKey), ['SECRET-two', 'SECRET-one', 'default'].map(key => hashKey('deepseek', key)));
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

test('slot DTO supplies public matching keys and stable fingerprints before identity resolves', () => {
  const h = harness();
  h.settings = { ...h.settings, deepseekAccountSlots: [{ id: 'pending', enabled: true, values: { deepseekApiKey: 'SECRET-pending' } }] };
  const [slot] = h.service.list('deepseek').accounts;
  assert.match(slot.accountKey, /^sha256:[a-f0-9]{64}$/);
  assert.match(slot.fingerprint, /^[a-f0-9]{12}$/);
  assert.equal(JSON.stringify(slot).includes('SECRET'), false);
  assert.deepEqual(Object.keys(slot).sort(), ['accountKey', 'accountKeyAliases', 'createdAt', 'enabled', 'fingerprint', 'formValues', 'id', 'label', 'updatedAt']);
});


test('redacted China DTO round trip preserves site when replacement probe is indeterminate', async () => {
  const h = harness();
  h.settings = { ...h.settings, qoderAccountSlots: [{ id: 'china', enabled: true, values: { qoderSite: 'cn', qoderCookie: 'token=SECRET-old' } }] };
  h.fetch = async () => { throw new Error('offline'); };
  const slot = h.service.list('qoder').accounts[0];
  assert.deepEqual(slot.formValues, { qoderSite: 'cn' });
  assert.ok(!JSON.stringify(slot).includes('SECRET'));
  const result = await h.service.replace('qoder', slot.id, { ...slot.formValues, qoderCookie: 'token=SECRET-new' });
  assert.equal(result.saved, true);
  assert.equal(h.settings.qoderAccountSlots[0].values.qoderSite, 'cn');
});



test('adding an extra account does not retire an unnamed implicit default before identity resolution', async () => {
  const h = harness(); h.settings = { ...h.settings, deepseekApiKey: 'fixed' };
  const changes = []; h.changed = (_provider, change) => changes.push(change);
  await add(h);
  assert.deepEqual(changes.at(-1).retiredAccountKeys, []);
  assert.ok(!h.settings.deepseekAccountSlots.some(slot => slot.id === 'default'));
});

test('saving an account turns collection on for its provider, as the fixed form did', async () => {
  const h = harness();
  h.settings = { ...h.settings, limitsEnabled: false, limitProviders: 'qoder' };
  assert.equal((await add(h)).saved, true);
  assert.equal(h.settings.limitsEnabled, true);
  assert.deepEqual(h.settings.limitProviders.split(',').sort(), ['deepseek', 'qoder']);
  // Local presentation changes never touch the provider selection.
  h.settings = { ...h.settings, limitProviders: 'qoder' };
  await h.service.rename('deepseek', h.settings.deepseekAccountSlots[0].id, 'Renamed');
  assert.equal(h.settings.limitProviders, 'qoder');
});

test('environment identity is reused only for matching credential and site values', async () => {
  const env = { QODER_COOKIE: 'token=one' };
  const h = harness({ env });
  const values = { qoderCookie: 'token=one', qoderSite: 'global' };
  assert.equal(await h.service.resolved('qoder', 'environment', { accountKey: 'server-one', accountKeyAliases: ['old'] }, values), true);
  assert.equal(h.service.list('qoder').accounts[0].accountKey, 'server-one');
  env.QODER_COOKIE = 'token=two';
  assert.notEqual(h.service.list('qoder').accounts[0].accountKey, 'server-one');
  assert.deepEqual(h.service.list('qoder').accounts[0].accountKeyAliases, []);
  env.QODER_COOKIE = 'token=one';
  h.settings = { ...h.settings, qoderSite: 'cn' };
  assert.notEqual(h.service.list('qoder').accounts[0].accountKey, 'server-one');
  h.settings = { ...h.settings, qoderSite: 'global' };
  assert.equal(h.service.list('qoder').accounts[0].accountKey, 'server-one');
});

test('the same credential cannot be added twice or replaced into another account', async () => {
  const h = harness();
  await add(h);
  const again = await h.service.add('deepseek', { deepseekApiKey: 'SECRET-one' }, 'Copy');
  assert.equal(again.saved, false);
  assert.equal(again.verdict, 'duplicate');
  assert.equal(h.settings.deepseekAccountSlots.length, 1);
  const second = await h.service.add('deepseek', { deepseekApiKey: 'SECRET-two' }, 'Second');
  const replaced = await h.service.replace('deepseek', second.accounts[1].id, { deepseekApiKey: 'SECRET-one' });
  assert.equal(replaced.verdict, 'duplicate');
  assert.equal(h.settings.deepseekAccountSlots[1].values.deepseekApiKey, 'SECRET-two');
  const same = await h.service.replace('deepseek', second.accounts[1].id, { deepseekApiKey: 'SECRET-two' });
  assert.notEqual(same.verdict, 'duplicate', 'replacing an account with its own credential is not a duplicate');
});


for (const operation of ['add', 'replace']) {
  for (const provider of ['deepseek', 'qoder']) {
    test(`${operation} rejects normalized ${provider} environment duplicates without writes or refresh`, async () => {
      const deepseek = provider === 'deepseek';
      const env = deepseek ? { DEEPSEEK_API_KEY: 'SECRET-env' } : { QODER_COOKIE: 'token=env' };
      const h = harness({ env });
      h.fetch = async () => { throw new Error('offline'); };
      const field = deepseek ? 'deepseekApiKey' : 'qoderCookie';
      const values = { [field]: deepseek ? '  SECRET-env  ' : '  token=env  ',
        ...(deepseek ? {} : { qoderSite: ' https://qoder.com.cn ' }) };
      // The environment companion is normalized too, using the form's rules.
      if (!deepseek) h.settings = { ...h.settings, qoderSite: 'china' };
      let id;
      if (operation === 'replace') {
        const added = await h.service.add(provider, { [field]: deepseek ? 'SECRET-other' : 'token=other',
          ...(deepseek ? {} : { qoderSite: 'cn' }) });
        id = added.accounts.find(account => account.id !== 'environment').id;
      }
      const before = structuredClone(h.settings);
      const writes = h.writes.length;
      const changes = [];
      h.changed = (...args) => changes.push(args);
      const result = operation === 'add' ? await h.service.add(provider, values)
        : await h.service.replace(provider, id, values);
      assert.deepEqual(result, { saved: false, verdict: 'duplicate', status: 'duplicate' });
      assert.deepEqual(h.settings, before);
      assert.equal(h.writes.length, writes);
      assert.deepEqual(changes, []);
      assert.equal(h.service.list(provider).accounts.length, operation === 'add' ? 1 : 2);
    });
  }
}

test('environment comparison allows absent or shadowed environment accounts and different credentials', async () => {
  for (const mode of ['absent', 'shadowed', 'different']) {
    const h = harness({ env: mode === 'absent' ? {} : { DEEPSEEK_API_KEY: 'SECRET-env' } });
    if (mode === 'shadowed') h.settings = { ...h.settings, deepseekApiKey: 'SECRET-fixed' };
    const changes = [];
    h.changed = (...args) => changes.push(args);
    const added = await h.service.add('deepseek', { deepseekApiKey: mode === 'different' ? 'SECRET-other' : 'SECRET-env' });
    assert.equal(added.saved, true, mode);
    const id = added.accounts.find(account => account.id !== 'environment').id;
    assert.equal((await h.service.replace('deepseek', id, {})).saved, true, mode);
    assert.equal(h.writes.length, 2);
    assert.equal(changes.length, 2);
  }
});

test('environment comparison includes Qoder site and DeepSeek web-token companions', async () => {
  for (const provider of ['qoder', 'deepseek']) {
    const qoder = provider === 'qoder';
    const h = harness({ env: qoder ? { QODER_COOKIE: 'token=env' } : { DEEPSEEK_API_KEY: 'SECRET-env' } });
    h.fetch = async () => { throw new Error('offline'); };
    const values = qoder ? { qoderCookie: 'token=env', qoderSite: 'china' }
      : { deepseekApiKey: 'SECRET-env', deepseekWebToken: 'web-companion' };
    const added = await h.service.add(provider, values);
    assert.equal(added.saved, true);
    const id = h.settings[`${provider}AccountSlots`][0].id;
    assert.equal((await h.service.replace(provider, id, {})).saved, true);
    assert.equal(h.writes.length, 2);
  }
});

test('a pre-existing environment duplicate can replace itself without migrating or deleting rows', async () => {
  const env = {};
  const h = harness({ env });
  const added = await add(h);
  const id = added.accounts[0].id;
  env.DEEPSEEK_API_KEY = 'SECRET-one';
  assert.equal(h.service.list('deepseek').accounts.length, 1, 'same identity has one displayed owner');
  const replaced = await h.service.replace('deepseek', id, { deepseekApiKey: ' SECRET-one ' });
  assert.equal(replaced.saved, true);
  assert.equal(replaced.accounts.length, 1);
  assert.equal(h.settings.deepseekAccountSlots[0].id, id);
  assert.equal(h.settings.deepseekAccountSlots[0].values.deepseekApiKey, 'SECRET-one');
  assert.equal(h.writes.length, 3, 'initial named add also persists its shared label');
});

test('local slot labels and moves publish user operations without credential material', async () => {
  const operations = [];
  const h = harness({ onPresentation: async batch => operations.push(...batch) });
  await add(h);
  const second = await h.service.add('deepseek', { deepseekApiKey: 'SECRET-two' }, 'Second');
  operations.length = 0;
  const first = second.accounts[0];
  await h.service.rename('deepseek', first.id, 'Shared Work');
  await h.service.move('deepseek', second.accounts[1].id, 'up');
  assert.deepEqual(operations[0], { provider: 'deepseek', type: 'rename', key: first.accountKey, label: 'Shared Work' });
  assert.deepEqual(operations[1], { provider: 'deepseek', type: 'order', order: [second.accounts[1].accountKey, first.accountKey] });
  assert.equal(h.settings.limitAccountPresentation.deepseek.labels[first.accountKey], 'Shared Work');
  assert.doesNotMatch(JSON.stringify(operations), /SECRET|ApiKey|accountEmail/);
});

test('a resolved account key carries its chosen name to the shared document', async () => {
  const operations = [];
  const h = harness({ onPresentation: async batch => operations.push(...batch) });
  await add(h);
  const slot = h.settings.deepseekAccountSlots[0];
  operations.length = 0;
  await h.service.resolved('deepseek', slot.id, { accountKey: 'resolved-account' }, slot.values);
  assert.deepEqual(operations, [{ provider: 'deepseek', type: 'rename', key: 'resolved-account', label: 'First' }]);
  assert.equal(h.settings.limitAccountPresentation.deepseek.labels['resolved-account'], 'First');
});

test('a rename answers without waiting for the shared document', async () => {
  const h = harness({ onPresentation: () => new Promise(() => {}) });
  await add(h);
  const slot = h.settings.deepseekAccountSlots[0];
  const result = await Promise.race([
    h.service.rename('deepseek', slot.id, 'Offline Hub'),
    new Promise(resolve => setTimeout(() => resolve('timed out'), 500))
  ]);
  assert.notEqual(result, 'timed out');
  assert.equal(h.settings.limitAccountPresentation.deepseek.labels[result.accounts[0].accountKey], 'Offline Hub');
});

test('a shared name, including a clear, becomes the slot label without being republished', async () => {
  const operations = [];
  const h = harness({ onPresentation: batch => operations.push(...batch) });
  const result = await add(h);
  const key = result.accounts[0].accountKey;
  operations.length = 0;
  await h.service.adoptSharedLabels({ deepseek: { labels: { [key]: 'From Windows' }, order: [] } });
  assert.equal(h.service.list('deepseek').accounts[0].label, 'From Windows');
  assert.deepEqual(h.service.localLabels('deepseek'), [{ provider: 'deepseek', type: 'rename', key, label: 'First' }]);
  await h.service.adoptSharedLabels({ deepseek: { labels: { [key]: '' }, order: [] } });
  assert.equal(h.service.list('deepseek').accounts[0].label, '');
  assert.deepEqual(operations, []);
});

test('a local presentation rename supersedes the saved name before another Hub seeds', async () => {
  const h = harness();
  const { accountKey: key } = (await add(h)).accounts[0];
  await h.service.adoptSharedLabels({ deepseek: { labels: { [key]: 'From Hub A' }, order: [] } });
  await h.service.presentation('deepseek', key, 'rename', 'New local name');
  assert.equal(h.service.localLabels('deepseek')[0].label, 'New local name');
  assert.equal((await h.service.presentation('deepseek', key, 'rename', '🚀')).ok, false);
  assert.equal(h.service.localLabels('deepseek')[0].label, 'New local name');
  await h.service.presentation('deepseek', key, 'rename', '');
  assert.deepEqual(h.service.localLabels('deepseek'), []);
});

test('a resolved account key takes over its provisional key in the shared order', async () => {
  const operations = [];
  const h = harness({ onPresentation: batch => operations.push(...batch) });
  await add(h);
  const second = await h.service.add('deepseek', { deepseekApiKey: 'SECRET-two' }, '');
  await h.service.move('deepseek', second.accounts[1].id, 'up');
  const slot = h.settings.deepseekAccountSlots.find(item => item.id === second.accounts[1].id);
  const provisional = h.service.list('deepseek').accounts[0].accountKey;
  operations.length = 0;
  await h.service.resolved('deepseek', slot.id, { accountKey: 'resolved-two' }, slot.values);
  const order = h.settings.limitAccountPresentation.deepseek.order;
  assert.ok(order.indexOf('resolved-two') >= 0 && order.indexOf('resolved-two') < order.indexOf(h.service.list('deepseek').accounts[1].accountKey));
  assert.ok(operations.some(operation => operation.type === 'order' && operation.order[0] === 'resolved-two'), `provisional ${provisional}`);
  assert.equal(h.service.list('deepseek').accounts[0].accountKey, 'resolved-two');
});

test('full shared order persists the local subsequence for a restart without presentation cache', async () => {
  const published = [];
  const h = harness({ onPresentation: operations => published.push(...operations) });
  await add(h);
  const { accounts: [a, b] } = await h.service.add('deepseek', { deepseekApiKey: 'SECRET-two' }, 'Second');
  const order = ['remote-a', b.accountKey, 'remote-b', a.accountKey];
  await h.service.presentation('deepseek', b.accountKey, 'order', order);
  assert.deepEqual(published.at(-1).order, order);
  assert.deepEqual(h.settings.deepseekAccountSlots.map(slot => slot.id), [b.id, a.id]);
  h.settings = { ...h.settings, limitAccountPresentation: {} };
  assert.deepEqual(h.service.list('deepseek').accounts.map(slot => slot.id), [b.id, a.id]);
  h.settings = { ...h.settings, limitAccountPresentation: { deepseek: { labels: {}, order: ['remote-a', a.accountKey, b.accountKey] } } };
  await h.service.adoptSharedLabels(h.settings.limitAccountPresentation);
  assert.deepEqual(h.settings.deepseekAccountSlots.map(slot => slot.id), [a.id, b.id]);
});

test('replacing a credential carries its shared name and position to the new key', async () => {
  const h = harness();
  await add(h);
  const second = await h.service.add('deepseek', { deepseekApiKey: 'SECRET-two' }, 'Second');
  const [first, other] = second.accounts;
  await h.service.move('deepseek', other.id, 'up');
  await h.service.rename('deepseek', first.id, 'Work');
  await h.service.replace('deepseek', first.id, { deepseekApiKey: 'SECRET-rotated' });
  const replaced = h.service.list('deepseek').accounts.find(account => account.id === first.id);
  const group = h.settings.limitAccountPresentation.deepseek;
  if (replaced.accountKey !== first.accountKey) {
    assert.equal(group.labels[replaced.accountKey], 'Work');
    assert.ok(group.order.indexOf(replaced.accountKey) > group.order.indexOf(other.accountKey));
  }
  assert.deepEqual(h.service.list('deepseek').accounts.map(account => account.id), [other.id, first.id]);
  assert.notEqual(replaced.accountKey, first.accountKey, 'the fixture exercises a key change');
});

test('an environment account keeps its shared name when its identity resolves', async () => {
  const h = harness({ env: { DEEPSEEK_API_KEY: 'SECRET-env' } });
  const environment = h.service.list('deepseek').accounts.find(account => account.id === 'environment');
  assert.ok(environment, 'fixture lists the environment account');
  await h.service.presentation('deepseek', environment.accountKey, 'rename', 'From env');
  const values = { deepseekApiKey: 'SECRET-env' };
  const { defaultAccountValues } = require('../../src/shared/limits/accountSlots');
  const { limitProviderEntry } = require('../../src/shared/limits/registry');
  await h.service.resolved('deepseek', 'environment', { accountKey: 'server-env', accountKeyAliases: [] }, defaultAccountValues(limitProviderEntry('deepseek'), h.settings, { DEEPSEEK_API_KEY: 'SECRET-env' }) || values);
  assert.equal(h.settings.limitAccountPresentation.deepseek.labels['server-env'], 'From env');
});

test('incoming shared labels follow prior keys without taking another slot canonical label', async () => {
  const h = harness();
  h.settings = { ...h.settings, deepseekAccountSlots: [
    { id: 'a', values: { deepseekApiKey: 'a' }, accountKey: 'current-a', accountKeyAliases: ['prior-a', 'current-b'], label: 'Local A' },
    { id: 'b', values: { deepseekApiKey: 'b' }, accountKey: 'current-b', label: 'Local B' }
  ] };
  await h.service.adoptSharedLabels({ deepseek: { labels: { 'prior-a': 'Remote A', 'current-b': 'Remote B' }, order: [] } });
  assert.deepEqual(h.settings.deepseekAccountSlots.map(s => s.label), ['Remote A', 'Remote B']);
  await h.service.adoptSharedLabels({ deepseek: { labels: { 'prior-a': '', 'current-b': 'Remote B' }, order: [] } });
  assert.equal(h.settings.deepseekAccountSlots[0].label, '');
  await h.service.adoptSharedLabels({ deepseek: { labels: { 'current-a': 'Canonical', 'prior-a': 'Outdated' }, order: [] } });
  assert.equal(h.settings.deepseekAccountSlots[0].label, 'Canonical');
  await h.service.adoptSharedLabels({ deepseek: { labels: { 'current-b': 'Another account' }, order: [] } });
  assert.equal(h.settings.deepseekAccountSlots[0].label, 'Canonical');
});

for (const variant of ['cn', 'intl', 'cn-personal', 'intl-personal']) {
  for (const alias of [false, true]) test(`Alibaba controls retain other plan variants beside ${variant} environment identity (alias=${alias})`, async () => {
    const { defaultAccountValues } = require('../../src/shared/limits/accountSlots');
    const { limitProviderEntry } = require('../../src/shared/limits/registry');
    const env = { ALIBABA_TOKEN_PLAN_COOKIE: 'session=SECRET-env', ALIBABA_TOKEN_PLAN_VARIANT: variant };
    const h = harness({ env });
    h.settings = { alibabaVariant: '', alibabaAccountSlots: ['cn', 'intl', 'cn-personal', 'intl-personal'].map(id => ({
      id, enabled: true, accountKey: 'same-uid', accountKeyAliases: [],
      values: { alibabaCookie: `session=SECRET-${id}`, alibabaVariant: id }
    })) };
    const before = structuredClone(h.settings.alibabaAccountSlots);
    const values = defaultAccountValues(limitProviderEntry('alibaba'), h.settings, env);
    assert.equal(await h.service.resolved('alibaba', 'environment', {
      accountKey: alias ? 'resolved-uid' : 'same-uid', accountKeyAliases: alias ? ['same-uid'] : []
    }, values), true);
    const accounts = h.service.list('alibaba').accounts;
    assert.deepEqual(accounts.map(account => account.id), ['environment', ...before.map(account => account.id).filter(id => id !== variant)]);
    assert.equal(accounts[0].formValues.alibabaVariant, variant);
    assert.deepEqual(h.settings.alibabaAccountSlots, before, 'projection must not rewrite persisted values');
    assert.ok(!JSON.stringify(accounts).includes('SECRET'));
    const saved = accounts.find(account => account.id !== 'environment');
    assert.equal((await h.service.setEnabled('alibaba', saved.id, false)).ok, true);
    assert.equal(h.service.list('alibaba').accounts.find(account => account.id === saved.id).enabled, false);
    assert.equal((await h.service.remove('alibaba', saved.id)).ok, true);
    assert.ok(!h.settings.alibabaAccountSlots.some(account => account.id === saved.id));
  });
}

for (const action of ['add', 'replace']) {
  test(`OpenRouter ${action} rejects a draft despite healthy legacy overflow profiles`, async () => {
    const h = harness();
    const requested = [];
    h.fetch = async (_url, init) => {
      const auth = init.headers.Authorization;
      requested.push(auth);
      return auth === 'Bearer bad-draft'
        ? response({}, 401) : response({ data: { limit: 20, usage: 2, total_credits: 20, total_usage: 2 } });
    };
    const first = await h.service.add('openrouter', { openrouterApiKey: 'saved-key' }, 'Saved');
    assert.equal(first.saved, true);
    h.settings = { ...h.settings, openrouterProfiles: { overflow: { apiKey: 'legacy-key' } } };
    const before = structuredClone(h.settings);
    requested.length = 0;
    const result = action === 'add'
      ? await h.service.add('openrouter', { openrouterApiKey: 'bad-draft' }, 'Draft')
      : await h.service.replace('openrouter', first.accounts[0].id, { openrouterApiKey: 'bad-draft' });
    assert.equal(result.saved, false);
    assert.equal(result.status, 'unauthorized');
    assert.deepEqual(h.settings, before, 'failed validation never changes saved credentials or legacy overflow');
    assert.ok(requested.length > 0);
    assert.equal(requested.every(auth => auth === 'Bearer bad-draft'), true);
  });
}
