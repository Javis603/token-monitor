'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountSlotFetcher } = require('../../src/shared/limits/accountSlotFetcher');
const { normalizeAccountSlots, accountSlotKey } = require('../../src/shared/limits/accountSlots');
const { LIMIT_PROVIDER_FETCHERS, limitProviderEntry } = require('../../src/shared/limits/registry');
const { providerPhysicalBoundMs } = require('../../src/shared/limits/collector');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { limitsAccountConfig, normalizeAccountPatch, accountFieldProjection, accountStatusProjection, rendererOmittedAccountKeys } = require('../../src/electron/limits/accountSettings');
const { credentialSettingsForRenderer, stripCredentialSettings, CREDENTIAL_SETTING_PATHS } = require('../../src/shared/credentialStore');
const { hashKey } = require('../../src/shared/hashKey');
const slot = (id, values = { deepseekApiKey: id }, extra = {}) => ({ id, values, ...extra });
const config = (...slots) => ({ deepseekAccountSlots: slots });
const reading = (accountKey) => ({ provider: 'deepseek', status: 'ok', accountKey, updatedAt: new Date().toISOString(), windows: [{ label: 'Balance', kind: 'billing', metric: 'credits', remaining: 10, currency: 'USD' }] });
const fake = (fn) => createAccountSlotFetcher({ ...limitProviderEntry('deepseek'), fetchLimits: fn });
const live = (rows) => rows.filter((row) => !row.removed);
const deps = () => ({ env: {}, providerRuntimeState: new Map() });
const response = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const balance = { balance_infos: [{ currency: 'USD', total_balance: '10', topped_up_balance: '10' }] };

test('1 no slots preserves raw arguments and result identity', async () => {
  const options = {}, dependencies = {}, result = Promise.resolve(reading('a'));
  const fetch = fake((o, d) => { assert.equal(o, options); assert.equal(d, dependencies); return result; });
  assert.equal(fetch(options, dependencies), result);
  for (const id of ['qoder', 'deepseek']) {
    const d = { env: {}, now: () => 1000 };
    assert.deepEqual(await LIMIT_PROVIDER_FETCHERS[id]({}, d), await limitProviderEntry(id).fetchLimits({}, d));
  }
});
test('2 DeepSeek slots return independent keys using the real transport path', async () => {
  const rows = live(await LIMIT_PROVIDER_FETCHERS.deepseek(config(slot('a'), slot('b')), { ...deps(), probe: true, fetch: async () => response(balance) }));
  assert.deepEqual(rows.map((r) => r.accountKey), [hashKey('deepseek', 'a'), hashKey('deepseek', 'b')]);
});
for (const thrown of [false, true]) test(`3 ${thrown ? 'thrown' : 'returned'} failure stays bound to its slot`, async () => {
  const rows = live(await fake((o) => {
    if (o.deepseekApiKey === 'a') { if (thrown) throw new Error('offline'); return { provider: 'deepseek', status: 'unavailable' }; }
    return reading('B');
  })(config(slot('a', undefined, { accountKey: 'A' }), slot('b', undefined, { accountKey: 'B' })), deps()));
  assert.deepEqual(rows.map((r) => [r.accountKey, r.status]), [['A', 'unavailable'], ['B', 'ok']]);
});
test('4 real runtime retains sibling and last good failed-account windows', async () => {
  let fail = false;
  const fetch = fake((o) => fail && o.deepseekApiKey === 'a' ? { provider: 'deepseek', status: 'unavailable' } : reading(o.deepseekApiKey));
  const runtime = createLimitsRuntime({ limitProviders: ['deepseek'], ...config(slot('a'), slot('b')) }, { ...deps(), autoStart: false, autoRetry: false, providerFetchers: { deepseek: fetch } });
  try {
    await runtime.refresh({}, 'credential-edit'); fail = true;
    await runtime.refresh({}, 'credential-edit');
    const rows = runtime.getSnapshot().providers;
    assert.deepEqual(rows.map((r) => [r.accountKey, r.status, r.windows.length]), [['a', 'unavailable', 1], ['b', 'ok', 1]]);
  } finally { runtime.stop(); }
});
test('5 first failure provisional identity retires on resolution with callback and runtime memory', async () => {
  let fail = true;
  const d = deps(), calls = [];
  d.onAccountSlotResolved = (...args) => calls.push(args);
  const fetch = fake(() => fail ? { provider: 'deepseek', status: 'unavailable' } : reading('real'));
  const options = config(slot('x'));
  const provisional = hashKey('deepseek', 'account-slot', 'slot:x');
  assert.equal((await fetch(options, d))[0].accountKey, provisional);
  fail = false;
  // The runtime holds the provisional row, so the pass that resolves it retires it.
  const held = { previousLimits: { providers: [{ provider: 'deepseek', accountKey: provisional, status: 'unavailable' }] } };
  const rows = await fetch({ ...options, ...held }, d);
  assert.ok(rows[0].accountKeyAliases.includes(provisional));
  assert.ok(rows.some((r) => r.removed && r.accountKey === provisional));
  // If that pass is superseded, the next one sees the same leftover and retires it again.
  assert.ok((await fetch({ ...options, ...held }, d)).some((r) => r.removed && r.accountKey === provisional));
  assert.equal(calls.at(-1)[2].accountKey, 'real');
  fail = true;
  assert.equal((await fetch(options, d))[0].accountKey, 'real');
});
test('6 credential replacement aliases and removes the old identity', async () => {
  const d = deps(), fetch = fake((o) => reading(o.deepseekApiKey));
  await fetch(config(slot('x', { deepseekApiKey: 'old' })), d);
  const rows = await fetch({ ...config(slot('x', { deepseekApiKey: 'new' }, { accountKey: 'new', accountKeyAliases: ['old'] })), previousLimits: { providers: [reading('old')] } }, d);
  assert.ok(rows[0].accountKeyAliases.includes('old'));
  assert.ok(rows.some((r) => r.removed && r.accountKey === 'old'));
});
test('7 duplicate resolved accounts keep only the first', async () => {
  const rows = live(await fake(() => reading('same'))(config(slot('a', undefined, { label: 'First' }), slot('b')), deps()));
  assert.equal(rows.length, 1); assert.equal(rows[0].accountName, 'First');
});
test('a duplicate that answers wins over an earlier failed or unconfigured copy of the same account', async () => {
  for (const first of [slot('a', undefined, { accountKey: 'K' }), slot('missing', {}, { accountKey: 'K' })]) {
    const rows = live(await fake((o) => o.deepseekApiKey === 'a' ? { provider: 'deepseek', status: 'unauthorized' } : reading('K'))(
      config(first, slot('b', undefined, { accountKey: 'K' })), deps()));
    assert.deepEqual(rows.map((r) => [r.accountKey, r.status]), [['K', 'ok']]);
  }
});
test('8 environment default and slot credentials stay isolated', async () => {
  const seen = [];
  const rows = live(await LIMIT_PROVIDER_FETCHERS.deepseek(config(slot('slot')), { env: { DEEPSEEK_API_KEY: 'environment' }, probe: true, fetch: async (_url, init) => { seen.push(init.headers.Authorization); return response(balance); } }));
  assert.equal(rows.length, 2); assert.deepEqual(seen, ['Bearer environment', 'Bearer slot']);
});
test('9 disabled and missing required secrets are not fetched', async () => {
  let calls = 0;
  const rows = await fake(() => { calls++; return reading('bad'); })(config(slot('disabled', undefined, { enabled: false }), slot('missing', {})), deps());
  assert.equal(calls, 0); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'notConfigured'); assert.ok(rows[0].accountKey);
});
test('10 Qoder sites and cookies are isolated per slot', async () => {
  const seen = [];
  const rows = await LIMIT_PROVIDER_FETCHERS.qoder({ qoderAccountSlots: [slot('a', { qoderCookie: 'session=a', qoderSite: 'cn' }), slot('b', { qoderCookie: 'session=b', qoderSite: 'global' })] }, { env: {}, fetch: async (url, init) => {
    seen.push([new URL(url).hostname, init.headers.Cookie]);
    return response({ data: { total_quota: { quota_summary: { used_value: 1, limit_value: 10, remaining_value: 9 } } } });
  } });
  assert.equal(live(rows).length, 2);
  assert.ok(seen.some(([host, cookie]) => host === 'qoder.com.cn' && cookie === 'session=a'));
  assert.ok(seen.some(([host, cookie]) => host === 'qoder.com' && cookie === 'session=b'));
  assert.ok(seen.every(([host, cookie]) => (host === 'qoder.com.cn') === (cookie === 'session=a')));
});
test('10 DeepSeek optional console token stays in its own slot', async () => {
  const seen = [];
  await LIMIT_PROVIDER_FETCHERS.deepseek({ deepseekApiKey: 'default', ...config(slot('a', { deepseekApiKey: 'a', deepseekWebToken: 'console-a' }), slot('b')) }, {
    env: {}, readJson: () => ({}), writeJsonAtomic: () => {},
    fetch: async (url, init) => { seen.push([url, init.headers.Authorization]); return response(url.includes('/user/balance') ? balance : {}); }
  });
  assert.deepEqual(seen.filter(([url]) => url.includes('/cost')).map(([, auth]) => auth), ['Bearer console-a']);
});
test('11 account scope matches aliases and defaults only when unclaimed', async () => {
  const seen = [];
  const fetch = fake((o) => { seen.push(o.deepseekApiKey); return reading(o.deepseekApiKey); });
  const options = { deepseekApiKey: 'default', ...config(slot('a', undefined, { accountKey: 'A', accountKeyAliases: ['alias'] }), slot('b')) };
  // An alias reaches its account, but the answer is filed under it only if it reports it.
  const rows = live(await fetch({ ...options, limitRefreshScope: { provider: 'deepseek', accountKey: 'alias' } }, deps()));
  assert.equal(rows.length, 0); assert.deepEqual(seen, ['a']); seen.length = 0;
  const reported = live(await fake(() => ({ ...reading('A'), accountKeyAliases: ['alias'] }))({ ...options, limitRefreshScope: { provider: 'deepseek', accountKey: 'alias' } }, deps()));
  assert.deepEqual(reported.map((r) => r.accountKey), ['alias']);
  await fetch({ ...options, limitRefreshScope: { provider: 'deepseek', accountKey: 'unclaimed' } }, deps());
  assert.deepEqual(seen, ['default']);
  // A default account already known under another key is not what an unmatched scope asked for.
  seen.length = 0;
  const d = deps(); d.providerRuntimeState.set(`account-slot:deepseek:default:${require('../../src/shared/limits/accountSlots').accountValuesFingerprint({ deepseekApiKey: 'default', deepseekWebToken: '' })}`,  { accountKey: 'DEFAULT', accountKeyAliases: [] });
  assert.deepEqual(await fetch({ ...options, limitRefreshScope: { provider: 'deepseek', accountKey: 'unclaimed' } }, d), []);
  assert.deepEqual(seen, []);
});
// Another device's row has a refresh too. No local credential answers for it,
// so a local reading must never be filed under that device's account key.
test('a scope for another device\'s account is never answered with a local reading', async () => {
  const local = { deepseekApiKey: 'local', previousLimits: { providers: [reading('local')] } };
  const remote = { provider: 'deepseek', accountKey: 'REMOTE' };
  // Without slots, through the real fetcher and the real runtime.
  const real = await LIMIT_PROVIDER_FETCHERS.deepseek({ ...local, limitRefreshScope: { provider: 'deepseek', accountKey: hashKey('deepseek', 'remote') } },
    { env: {}, probe: true, fetch: async () => response(balance) });
  assert.deepEqual(real, []);
  const runtime = runtimeFor(fake((o) => reading(o.deepseekApiKey)), { deepseekApiKey: 'local' });
  try {
    await runtime.refresh({}, 'credential-edit');
    await runtime.refresh(remote, 'account-panel');
    assert.deepEqual(snapshot(runtime), [['local', 'ok']]);
  } finally { runtime.stop(); }
  // With slots, an unclaimed default account is still fetched but cannot answer for it.
  const seen = [];
  const withSlots = fake((o) => { seen.push(o.deepseekApiKey); return o.deepseekApiKey === 'local' ? { provider: 'deepseek', status: 'unauthorized' } : reading(o.deepseekApiKey); });
  assert.deepEqual(await withSlots({ ...local, ...config(slot('a')), limitRefreshScope: remote }, deps()), []);
  assert.deepEqual(seen, ['local']);
  // A key this runtime holds is still answered by the unclaimed default account, as after a restart.
  assert.deepEqual(live(await fake((o) => reading(o.deepseekApiKey))({ deepseekApiKey: 'local', ...config(slot('a')),
    previousLimits: { providers: [reading('HELD')] }, limitRefreshScope: { provider: 'deepseek', accountKey: 'HELD' } }, deps()))
    .map((r) => r.accountKey), ['HELD']);
  // The same account signed in on both devices answers as usual.
  assert.deepEqual([await fake((o) => reading(o.deepseekApiKey))({ deepseekApiKey: 'local', limitRefreshScope: { provider: 'deepseek', accountKey: 'local' } }, deps())]
    .flat().map((r) => r.accountKey), ['local']);
});

test('12 broad raw removals cannot retire sibling identities', async () => {
  const previousLimits = [reading('A'), reading('B')];
  const rows = await fake((o) => {
    assert.equal(o.previousLimits.providers.length, 1);
    return [reading(o.deepseekApiKey.toUpperCase()), ...previousLimits.map((r) => ({ provider: 'deepseek', accountKey: r.accountKey, removed: true }))];
  })({ ...config(slot('a', undefined, { accountKey: 'A' }), slot('b', undefined, { accountKey: 'B' })), previousLimits: { providers: previousLimits } }, deps());
  assert.equal(rows.filter((r) => r.removed).length, 0);
});
test('13 keyless success keeps a permanent provisional identity', async () => {
  const d = deps(), fetch = fake(() => reading(undefined));
  const rows = await fetch(config(slot('a')), d);
  assert.equal(rows[0].accountKey, hashKey('deepseek', 'account-slot', 'slot:a'));
  // A second pass keeps the same identity and retires nothing.
  const again = await fetch(config(slot('a')), d);
  assert.deepEqual(again.map((r) => [r.accountKey, r.removed === true]), [[rows[0].accountKey, false]]);
  assert.equal(Object.hasOwn(again[0], 'accountKeyAliases'), false);
});
test('14 renderer projections blank the slot list and carry no secret; generic patch strips slots', () => {
  const settings = { deepseekAccountSlots: [slot('a', { deepseekApiKey: 'slot-secret' })] };
  const projection = { ...settings };
  for (const key of rendererOmittedAccountKeys()) delete projection[key];
  Object.assign(projection, credentialSettingsForRenderer(settings), accountFieldProjection(settings, {}), accountStatusProjection(settings, {}));
  assert.equal(projection.deepseekAccountSlots, ''); assert.ok(!JSON.stringify(projection).includes('slot-secret'));
  assert.deepEqual(stripCredentialSettings(settings), {});
  const patch = { ...settings }; normalizeAccountPatch(settings, patch); assert.deepEqual(patch, {});
  assert.equal(limitsAccountConfig(settings, { env: {} }).deepseekAccountSlots[0].values.deepseekApiKey, 'slot-secret');
  assert.deepEqual(CREDENTIAL_SETTING_PATHS.deepseekAccountSlots, ['providers', 'deepseek', 'accountSlots']);
});
test('15 provider deadline scales by active accounts and scoped dispatch', () => {
  const options = { deepseekApiKey: 'default', ...config(slot('a'), slot('b'), slot('off', undefined, { enabled: false })) };
  const d = { env: {}, providerPhysicalBounds: { deepseek: 100 } };
  assert.equal(providerPhysicalBoundMs('deepseek', options, d), 300);
  assert.equal(providerPhysicalBoundMs('deepseek', { ...options, limitRefreshScope: { provider: 'deepseek', accountKey: 'unknown' } }, d), 100);
});
test('normalizer bounds records and aliases, sanitizes labels and drops unknown values', () => {
  const entry = limitProviderEntry('deepseek');
  const normalized = normalizeAccountSlots(entry, [slot('a', { deepseekApiKey: 'secret', qoderCookie: 'bad' }, { label: '  My / Account  ', accountKeyAliases: Array.from({ length: 30 }, (_, i) => String(i)) }), slot('a'), {}, ...Array.from({ length: 30 }, (_, i) => slot(String(i)))]);
  assert.equal(normalized.length, 20); assert.equal(normalized[0].label, 'My Account'); assert.equal(normalized[0].accountKeyAliases.length, 8);
  assert.deepEqual(normalized[0].values, { deepseekApiKey: 'secret' }); assert.equal(accountSlotKey(entry), 'deepseekAccountSlots');
});
test('abort stops between sequential accounts', async () => {
  const controller = new AbortController(); let calls = 0;
  const rows = await fake(() => { calls++; controller.abort(); return reading('first'); })(config(slot('a'), slot('b')), { ...deps(), signal: controller.signal });
  assert.equal(calls, 1); assert.equal(live(rows).length, 1);
});

test('a slot named default and the default account keep separate provisional identities', async () => {
  const fetch = fake(() => ({ provider: 'deepseek', status: 'unavailable' }));
  const rows = await fetch({ deepseekApiKey: 'default-key', ...config(slot('default')) }, deps());
  assert.equal(rows.length, 2); assert.notEqual(rows[0].accountKey, rows[1].accountKey);
});
test('an optional sibling credential alone is not a default account', async () => {
  let calls = 0;
  const fetch = fake((options) => { calls++; return reading(options.deepseekApiKey); });
  const rows = await fetch({ deepseekWebToken: 'console-only', ...config(slot('a')) }, deps());
  assert.equal(calls, 1); assert.deepEqual(live(rows).map((r) => r.accountKey), ['a']);
});
test('slot ids outside the opaque id charset are dropped', () => {
  const entry = limitProviderEntry('deepseek');
  assert.deepEqual(normalizeAccountSlots(entry, [slot('ok-1'), slot('bad id'), slot(''), slot('x'.repeat(65))]).map((s) => s.id), ['ok-1']);
});

const runtimeFor = (fetch, options, extra = {}) => createLimitsRuntime({ limitProviders: ['deepseek'], ...options },
  { ...deps(), autoStart: false, autoRetry: false, providerFetchers: { deepseek: fetch }, ...extra });
const snapshot = (runtime) => runtime.getSnapshot().providers.map((r) => [r.accountKey, r.status]);

test('a scoped recovery stays on the scope identity until a provider-wide dispatch moves it', async () => {
  let fail = true;
  const provisional = hashKey('deepseek', 'account-slot', 'slot:x');
  const runtime = runtimeFor(fake(() => fail ? { provider: 'deepseek', status: 'unavailable' } : reading('real')), config(slot('x')));
  try {
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(snapshot(runtime), [[provisional, 'unavailable']]);
    fail = false;
    await runtime.refresh({ provider: 'deepseek', accountKey: provisional }, 'credential-edit');
    assert.deepEqual(snapshot(runtime), [[provisional, 'ok']]);
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(snapshot(runtime), [['real', 'ok']]);
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(snapshot(runtime), [['real', 'ok']]);
  } finally { runtime.stop(); }
});

test('an account that becomes a duplicate has its former identity retired', async () => {
  let same = false;
  const runtime = runtimeFor(fake((o) => reading(same ? 'A' : o.deepseekApiKey.toUpperCase())), config(slot('a'), slot('b')));
  try {
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(snapshot(runtime), [['A', 'ok'], ['B', 'ok']]);
    same = true;
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(snapshot(runtime), [['A', 'ok']]);
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(snapshot(runtime), [['A', 'ok']]);
  } finally { runtime.stop(); }
});

test('accounts that swap identities keep both rows and neither becomes an alias of the other', async () => {
  let swapped = false;
  const d = deps();
  const fetch = fake((o) => reading(swapped === (o.deepseekApiKey === 'a') ? 'B' : 'A'));
  await fetch(config(slot('a'), slot('b')), d);
  swapped = true;
  const rows = await fetch({ ...config(slot('a'), slot('b')), previousLimits: { providers: [reading('A'), reading('B')] } }, d);
  assert.equal(rows.some((r) => r.removed), false);
  assert.deepEqual(rows.map((r) => r.accountKey).sort(), ['A', 'B']);
  assert.equal(rows.some((r) => Object.hasOwn(r, 'accountKeyAliases')), false);
  // A scoped refresh of A now belongs to the slot that reports A, not the slot that used to.
  const seen = [];
  const scoped = fake((o) => { seen.push(o.deepseekApiKey); return reading(o.deepseekApiKey === 'a' ? 'B' : 'A'); });
  const answer = await scoped({ ...config(slot('a'), slot('b')), limitRefreshScope: { provider: 'deepseek', accountKey: 'A' } }, d);
  assert.deepEqual(seen, ['b']); assert.deepEqual(answer.map((r) => r.accountKey), ['A']);
});

test('refreshing a key a slot moved away from does not file the slot\'s new reading under it', async () => {
  // Another device can still report the old key; its row has a refresh too.
  const runtime = runtimeFor(fake((o) => reading(o.deepseekApiKey.toUpperCase())), config(slot('x', { deepseekApiKey: 'old' })));
  try {
    await runtime.refresh({}, 'credential-edit');
    runtime.reconfigure({ limitProviders: ['deepseek'], ...config(slot('x', { deepseekApiKey: 'new' })) });
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(snapshot(runtime), [['NEW', 'ok']]);
    await runtime.refresh({ provider: 'deepseek', accountKey: 'OLD' }, 'account-panel');
    assert.deepEqual(snapshot(runtime), [['NEW', 'ok']]);
  } finally { runtime.stop(); }
});

test('a stale remembered key does not take the reading of a replaced credential', async () => {
  // Stored on the slot record, with no local row and the real fetcher.
  const stored = await LIMIT_PROVIDER_FETCHERS.deepseek({ ...config(slot('x', { deepseekApiKey: 'new' }, { accountKey: 'OLD' })),
    limitRefreshScope: { provider: 'deepseek', accountKey: 'OLD' } }, { ...deps(), probe: true, fetch: async () => response(balance) });
  assert.deepEqual(stored, []);
  // Remembered by the runtime, refreshed before any provider-wide pass sees the new credential.
  const remaining = (key) => ({ ...reading(key.toUpperCase()), windows: [{ ...reading(key).windows[0], remaining: key === 'old' ? 1 : 2 }] });
  const runtime = runtimeFor(fake((o) => remaining(o.deepseekApiKey)), config(slot('x', { deepseekApiKey: 'old' })));
  try {
    await runtime.refresh({}, 'credential-edit');
    runtime.reconfigure({ limitProviders: ['deepseek'], ...config(slot('x', { deepseekApiKey: 'new' })) });
    await runtime.refresh({ provider: 'deepseek', accountKey: 'OLD' }, 'account-panel');
    const old = runtime.getSnapshot().providers.find((r) => r.accountKey === 'OLD');
    assert.equal(old?.windows[0].remaining ?? 1, 1);
  } finally { runtime.stop(); }
  // An answer for the remembered key itself, or a keyless failure of a held key, is still filed under it.
  const held = { previousLimits: { providers: [reading('OLD')] }, limitRefreshScope: { provider: 'deepseek', accountKey: 'OLD' } };
  assert.deepEqual(live(await fake(() => reading('OLD'))({ ...config(slot('x', undefined, { accountKey: 'OLD' })), ...held }, deps())).map((r) => r.accountKey), ['OLD']);
  assert.deepEqual(live(await fake(() => ({ provider: 'deepseek', status: 'unavailable' }))({ ...config(slot('x', undefined, { accountKey: 'OLD' })), ...held }, deps()))
    .map((r) => [r.accountKey, r.status]), [['OLD', 'unavailable']]);
});

test('a provisional key no local row holds is another device\'s account', async () => {
  const provisional = hashKey('deepseek', 'account-slot', 'default');
  const rows = await fake((o) => reading(o.deepseekApiKey))({ deepseekApiKey: 'local', ...config(slot('a')),
    limitRefreshScope: { provider: 'deepseek', accountKey: provisional } }, deps());
  assert.deepEqual(rows, []);
});

test('a scoped refresh under an old key leaves nothing behind after the next provider-wide pass', async () => {
  const runtime = runtimeFor(fake((o) => reading(o.deepseekApiKey === 'first' ? 'old' : 'real')), config(slot('x', { deepseekApiKey: 'first' })));
  try {
    await runtime.refresh({}, 'credential-edit');
    runtime.reconfigure({ limitProviders: ['deepseek'], ...config(slot('x', { deepseekApiKey: 'second' })) });
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(snapshot(runtime), [['real', 'ok']]);
    await runtime.refresh({ provider: 'deepseek', accountKey: 'old' }, 'credential-edit');
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(snapshot(runtime), [['real', 'ok']]);
  } finally { runtime.stop(); }
});

test('the default account does not claim a previous row an unresolved slot may own', async () => {
  const fetch = fake((o) => o.deepseekApiKey === 'default' ? { provider: 'deepseek', status: 'unauthorized' } : reading('SLOT'));
  const rows = live(await fetch({ deepseekApiKey: 'default', ...config(slot('a')), previousLimits: { providers: [reading('SLOT')] } }, deps()));
  assert.deepEqual(rows.map((r) => [r.accountKey, r.status]),
    [[hashKey('deepseek', 'account-slot', 'default'), 'unauthorized'], ['SLOT', 'ok']]);
});

test('a leftover previous row is never taken as the default account, and is retired', async () => {
  const fetch = fake((o) => o.deepseekApiKey === 'default' ? { provider: 'deepseek', status: 'unavailable' } : reading('B'));
  const options = { deepseekApiKey: 'default', ...config(slot('b', undefined, { accountKey: 'B' })),
    previousLimits: { providers: [reading('REMOVED'), reading('B')] } };
  const rows = await fetch(options, deps());
  assert.deepEqual(live(rows).map((r) => [r.accountKey, r.status]),
    [[hashKey('deepseek', 'account-slot', 'default'), 'unavailable'], ['B', 'ok']]);
  assert.deepEqual(rows.filter((r) => r.removed).map((r) => r.accountKey), ['REMOVED']);
});

test('an aborted pass and a scoped pass retire nothing', async () => {
  const previousLimits = { providers: [reading('A'), reading('B'), reading('GONE')] };
  const controller = new AbortController();
  const aborting = fake((o) => { controller.abort(); return reading(o.deepseekApiKey.toUpperCase()); });
  const partial = await aborting({ ...config(slot('a'), slot('b')), previousLimits }, { ...deps(), signal: controller.signal });
  assert.deepEqual(partial.map((r) => [r.accountKey, r.removed === true]), [['A', false]]);
  // Aborting during the last account's fetch is not a complete pass either.
  const last = new AbortController();
  const lastRows = await fake((o) => { if (o.deepseekApiKey === 'b') last.abort(); return reading(o.deepseekApiKey.toUpperCase()); })(
    { ...config(slot('a'), slot('b')), previousLimits }, { ...deps(), signal: last.signal });
  assert.equal(lastRows.some((r) => r.removed), false);
  // Nor does it advance what is remembered: the next pass still treats the account as new.
  const state = deps(), stop = new AbortController(), resolved = [];
  await fake((o) => { stop.abort(); return reading(o.deepseekApiKey.toUpperCase()); })(config(slot('a')),
    { ...state, signal: stop.signal, onAccountSlotResolved: (...args) => resolved.push(args) });
  assert.equal(state.providerRuntimeState.size, 0); assert.deepEqual(resolved, []);
  const scoped = await fake((o) => reading(o.deepseekApiKey.toUpperCase()))(
    { ...config(slot('a', undefined, { accountKey: 'A' }), slot('b')), previousLimits, limitRefreshScope: { provider: 'deepseek', accountKey: 'A' } }, deps());
  assert.deepEqual(scoped.map((r) => [r.accountKey, r.removed === true]), [['A', false]]);
});

test('a first successful answer adds no alias and retires nothing', async () => {
  const rows = await fake((o) => reading(o.deepseekApiKey))({ deepseekApiKey: 'default', ...config(slot('a')) }, deps());
  assert.deepEqual(rows.map((r) => [r.accountKey, r.removed === true, Object.hasOwn(r, 'accountKeyAliases')]),
    [['default', false, false], ['a', false, false]]);
});

test('aliases a fetch reports are dropped when they are another account\'s identity', async () => {
  const fetch = fake((o) => o.deepseekApiKey === 'a' ? { ...reading('A'), accountKeyAliases: ['B'] } : reading('B'));
  const rows = await fetch(config(slot('a'), slot('b')), deps());
  assert.deepEqual(rows.map((r) => [r.accountKey, Object.hasOwn(r, 'accountKeyAliases')]), [['A', false], ['B', false]]);
});

test('a slot keeps the shared data location but no credential from the environment', async () => {
  const seen = [];
  const fetch = fake((o, d) => { seen.push(d.env); return reading(o.deepseekApiKey); });
  await fetch(config(slot('a')), { ...deps(), env: { TOKEN_MONITOR_SHARED_DIR: '/data', DEEPSEEK_API_KEY: 'environment', OTHER: 'x' } });
  // The environment key makes a default account, which keeps the whole environment.
  assert.equal(seen[0].DEEPSEEK_API_KEY, 'environment');
  assert.deepEqual(seen[1], { TOKEN_MONITOR_SHARED_DIR: '/data' });
});

test('zero slots with identity observer preserve raw results and last-good keyless failures', async () => {
  const calls = [], d = { ...deps(), onAccountSlotResolved: (...args) => calls.push(args) };
  for (const raw of [reading('REAL'), { provider: 'deepseek', status: 'notConfigured', windows: [] },
    [{ ...reading('REAL'), accountKeyAliases: ['alias'] }, { provider: 'deepseek', accountKey: 'GONE', removed: true }]]) {
    assert.equal(await fake(() => raw)({ deepseekApiKey: 'default', previousLimits: { providers: [reading('HELD')] } }, d), raw);
  }
  assert.equal(calls.length, 2); assert.equal(calls[0][1], null);
  assert.equal(calls[0][3].deepseekApiKey, 'default');
  let fail = false;
  const runtime = createLimitsRuntime({ limitProviders: 'deepseek', deepseekApiKey: 'default' }, { ...d, autoStart: false, autoRetry: false, providerFetchers: { deepseek: fake(() => fail ? { provider: 'deepseek', status: 'unavailable' } : reading('REAL')) } });
  try {
    await runtime.refresh({}, 'settings-change'); fail = true;
    await runtime.refresh({}, 'settings-change');
    assert.equal(runtime.getSnapshot().providers[0].windows.length, 1);
    assert.equal(runtime.getSnapshot().providers[0].accountKey, 'REAL');
  } finally { runtime.stop(); }
});

test('a slot name never replaces the provider label that carries the plan', async () => {
  const fetch = fake((o) => ({ ...reading(o.deepseekApiKey.toUpperCase()), accountLabel: 'Pro' }));
  const rows = live(await fetch(config(slot('a', undefined, { label: 'Work' }), slot('b')), deps()));
  assert.deepEqual(rows.map((r) => [r.accountKey, r.accountLabel, r.accountName || '']), [['A', 'Pro', 'Work'], ['B', 'Pro', '']]);
  const runtime = runtimeFor(fetch, config(slot('a', undefined, { label: 'Work', accountKey: 'A' }), slot('b', undefined, { accountKey: 'B' })));
  try {
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(runtime.getSnapshot().providers.map((r) => [r.accountKey, r.accountLabel, r.accountName || '']), [['A', 'Pro', 'Work'], ['B', 'Pro', '']]);
  } finally { runtime.stop(); }
});

test('emptying a slot name removes it from retained readings too', async () => {
  let offline = false;
  const fetch = fake((o) => offline ? { provider: 'deepseek', status: 'unavailable' } : { ...reading(o.deepseekApiKey.toUpperCase()), accountLabel: 'Pro' });
  const runtime = runtimeFor(fetch, config(slot('a', undefined, { label: 'Work', accountKey: 'A' })));
  try {
    await runtime.refresh({}, 'credential-edit');
    assert.equal(runtime.getSnapshot().providers[0].accountName, 'Work');
    offline = true;
    runtime.reconfigure({ limitProviders: ['deepseek'], ...config(slot('a', undefined, { label: '', accountKey: 'A' })) });
    await runtime.refresh({}, 'settings-change');
    const [row] = runtime.getSnapshot().providers;
    assert.ok(!row.accountName);
    assert.equal(row.accountLabel, 'Pro');
    assert.equal(row.windows.length, 1);
  } finally { runtime.stop(); }
});

test('every declared serverAccountKey names a predicate its limits module exports', () => {
  const { LIMIT_PROVIDER_REGISTRY } = require('../../src/shared/limits/registry');
  const declared = LIMIT_PROVIDER_REGISTRY.filter((entry) => entry.serverAccountKey);
  assert.ok(declared.some((entry) => entry.id === 'qoder'));
  for (const entry of declared) assert.equal(typeof entry.limits[entry.serverAccountKey], 'function', entry.id);
});

test('a key a slot moved away from stays with the default account that answers under it', async () => {
  const fetch = fake((o) => reading(o.deepseekApiKey === 'a' ? 'A' : 'B'));
  const { accountValuesFingerprint } = require('../../src/shared/limits/accountSlots');
  const fingerprint = accountValuesFingerprint({ deepseekApiKey: 'a', deepseekWebToken: '' });
  const runtime = runtimeFor(fetch, { deepseekApiKey: 'a', deepseekDefaultAccountIdentity: { accountKey: 'A', accountKeyAliases: [], fingerprint },
    ...config(slot('x', { deepseekApiKey: 'b' }, { label: 'Work', accountKey: 'B', accountKeyAliases: ['A'] })) });
  try {
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(runtime.getSnapshot().providers.map((r) => [r.accountKey, r.accountName || '']), [['A', ''], ['B', 'Work']]);
  } finally { runtime.stop(); }
});

test('a default identity left by an older default credential does not take a slot alias', async () => {
  // Slot y answers under the key it moved away from, which the stale default identity also names.
  const fetch = fake((o) => reading({ x: 'X', y: 'A' }[o.deepseekApiKey] || 'NEWDEFAULT'));
  const runtime = runtimeFor(fetch, { deepseekApiKey: 'changed', deepseekDefaultAccountIdentity: { accountKey: 'A', accountKeyAliases: [], fingerprint: 'stale' },
    ...config(slot('x', { deepseekApiKey: 'x' }, { accountKey: 'X' }), slot('y', { deepseekApiKey: 'y' }, { accountKey: 'B', accountKeyAliases: ['A'] })) });
  try {
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(runtime.getSnapshot().providers.map((r) => r.accountKey), ['NEWDEFAULT', 'X', 'A']);
  } finally { runtime.stop(); }
});

test('a slot that turns out to be a different proven Qoder account takes nothing of the old one', async () => {
  const { qoderCookie } = require('../../src/shared/providers/qoder/limits');
  const values = { qoderCookie: 'token=two', qoderSite: 'global' };
  const cookieHash = hashKey('qoder', qoderCookie({}, values));
  const qoder = (fetchLimits) => createAccountSlotFetcher({ ...limitProviderEntry('qoder'), fetchLimits });
  const answer = () => ({ provider: 'qoder', status: 'ok', accountKey: 'B', accountKeyAliases: [cookieHash], updatedAt: new Date().toISOString(), windows: [] });
  for (const serverIdentity of [true, false]) {
    const resolved = [];
    const rows = await qoder(answer)({ qoderAccountSlots: [{ id: 'x', values, accountKey: 'A', accountKeyAliases: ['OLDER'], serverIdentity }],
      previousLimits: { providers: [{ provider: 'qoder', accountKey: 'A', status: 'ok', windows: [] }] } },
    { ...deps(), onAccountSlotResolved: (...args) => resolved.push(args) });
    const row = rows.find((r) => r.accountKey === 'B');
    const inherited = (row.accountKeyAliases || []).includes('A');
    // A proven different account is separate; an unproven one keeps the old key as before.
    assert.equal(inherited, !serverIdentity);
    assert.equal((row.accountKeyAliases || []).includes('OLDER'), !serverIdentity);
    assert.equal(resolved[0][2].accountKeyAliases.includes('A'), !serverIdentity);
    assert.ok(rows.some((r) => r.removed && r.accountKey === 'A'));
  }
});

test('a default identity this runtime just resolved is not claimed by a slot alias', async () => {
  const fetch = fake((o) => reading(o.deepseekApiKey === 'b' ? 'B' : 'A'));
  // No stored default identity yet: the runtime has only just resolved it.
  const runtime = runtimeFor(fetch, { deepseekApiKey: 'a', ...config(slot('y', { deepseekApiKey: 'b' }, { label: 'Work', accountKey: 'B', accountKeyAliases: ['A'] })) });
  try {
    await runtime.refresh({}, 'credential-edit');
    await runtime.refresh({}, 'credential-edit');
    assert.deepEqual(runtime.getSnapshot().providers.map((r) => [r.accountKey, r.accountName || '']), [['A', ''], ['B', 'Work']]);
  } finally { runtime.stop(); }
});

test('a proven Qoder slot that answered once without a user id still separates a different proven account', async () => {
  const { qoderCookie } = require('../../src/shared/providers/qoder/limits');
  const values = { qoderCookie: 'token=three', qoderSite: 'global' };
  const cookieHash = hashKey('qoder', qoderCookie({}, values));
  const fetch = createAccountSlotFetcher({ ...limitProviderEntry('qoder'),
    fetchLimits: () => ({ provider: 'qoder', status: 'ok', accountKey: 'B', accountKeyAliases: [cookieHash], updatedAt: new Date().toISOString(), windows: [] }) });
  // Proven A, then an unproven cookie-hash answer C aliased A; the proof is kept.
  const rows = await fetch({ qoderAccountSlots: [{ id: 'x', values, accountKey: 'C', accountKeyAliases: ['A'], serverIdentity: true }],
    previousLimits: { providers: [{ provider: 'qoder', accountKey: 'C', status: 'ok', windows: [] }] } }, deps());
  const row = rows.find((r) => r.accountKey === 'B');
  assert.equal((row.accountKeyAliases || []).some((alias) => alias === 'A' || alias === 'C'), false);
  assert.ok(rows.some((r) => r.removed && r.accountKey === 'C'));
});

test('a proven Qoder slot answering under a key it has been before stays the same account', async () => {
  const { qoderCookie } = require('../../src/shared/providers/qoder/limits');
  const values = { qoderCookie: 'token=one', qoderSite: 'global' };
  const cookieHash = hashKey('qoder', qoderCookie({}, values));
  const fetch = createAccountSlotFetcher({ ...limitProviderEntry('qoder'),
    fetchLimits: () => ({ provider: 'qoder', status: 'ok', accountKey: 'A', accountKeyAliases: [cookieHash], updatedAt: new Date().toISOString(), windows: [] }) });
  const rows = await fetch({ qoderAccountSlots: [{ id: 'x', values, accountKey: 'C', accountKeyAliases: ['A'], serverIdentity: true }] }, deps());
  assert.ok(rows.find((r) => r.accountKey === 'A').accountKeyAliases.includes('C'));
});

test('a rename shows on the next reconfigure without another fetch', async () => {
  let calls = 0;
  const runtime = runtimeFor(fake((o) => { calls += 1; return reading(o.deepseekApiKey.toUpperCase()); }), config(slot('a', undefined, { label: 'Old', accountKey: 'A' })));
  try {
    await runtime.refresh({}, 'credential-edit');
    const before = calls;
    runtime.reconfigure({ limitProviders: ['deepseek'], ...config(slot('a', undefined, { label: 'New', accountKey: 'A' })) });
    assert.equal(runtime.getSnapshot().providers[0].accountName, 'New');
    assert.equal(calls, before);
  } finally { runtime.stop(); }
});

test('a separated Qoder account cannot take the old identity back through a reported alias', async () => {
  const { qoderCookie } = require('../../src/shared/providers/qoder/limits');
  const values = { qoderCookie: 'token=four', qoderSite: 'global' };
  const cookieHash = hashKey('qoder', qoderCookie({}, values));
  const fetch = createAccountSlotFetcher({ ...limitProviderEntry('qoder'),
    fetchLimits: () => ({ provider: 'qoder', status: 'ok', accountKey: 'B', accountKeyAliases: [cookieHash], updatedAt: new Date().toISOString(), windows: [] }) });
  // Proven A, then an unproven answer moved the slot to its cookie hash, which now carries A's history.
  const rows = await fetch({ qoderAccountSlots: [{ id: 'x', values, accountKey: cookieHash, accountKeyAliases: ['A'], serverIdentity: true }],
    previousLimits: { providers: [{ provider: 'qoder', accountKey: cookieHash, status: 'ok', windows: [] }] } }, deps());
  const row = rows.find((r) => r.accountKey === 'B');
  assert.equal((row.accountKeyAliases || []).some((alias) => alias === cookieHash || alias === 'A'), false);
  assert.ok(rows.some((r) => r.removed && r.accountKey === cookieHash));
});
