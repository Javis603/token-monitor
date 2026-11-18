'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { limitProviderEntry } = require('../../src/shared/limits/registry');
const { createAccountSlotFetcher } = require('../../src/shared/limits/accountSlotFetcher');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { migrateAccountSlots } = require('../../src/electron/limits/accountSlotMigration');
const { defaultAccountValues, accountValuesFingerprint } = require('../../src/shared/limits/accountSlots');
const { accountName } = require('../../src/electron/renderer/limits/accountSlotsPanel');

for (const id of ['factory', 'cline', 'hark', 'manus', 'zai']) {
  test(`${id}: discovered controls survive restart without saving credentials, sign-out removes only its row`, async t => {
    const entry = limitProviderEntry(id);
    assert.equal(entry.accountSlots, true);
    const field = entry.status.credential;
    let signedIn = true;
    const original = entry.limits.discoverAccountSlots;
    const record = { values: { [field]: 'ambient-secret', ...(id === 'zai' ? { zaiApiRegion: 'global' } : {}) }, accountKey: 'ambient-key', accountEmail: 'ambient@example.com', sourceName: 'Desktop sign-in' };
    entry.limits.discoverAccountSlots = () => signedIn ? [record] : [];
    t.after(() => { entry.limits.discoverAccountSlots = original; });
    let settings = { [`${id}AccountSlots`]: [{ id: 'saved', values: { ...record.values, [field]: 'saved-secret' }, accountKey: 'saved-key' }] };
    const make = () => createAccountSlotService({ getSettings: () => settings, env: {}, probeDeps: () => ({}), write: async patch => { settings = { ...settings, ...patch }; } });
    let service = make();
    let accounts = service.list(id).accounts;
    assert.equal(accounts.length, 2);
    const ambient = accounts[0];
    assert.equal(ambient.source, 'discovered');
    assert.equal(accountName(ambient, null, key => key), 'ambient@example.com');
    assert.doesNotMatch(JSON.stringify(accounts), /ambient-secret|saved-secret|storePath|fetchDeps|resolver/);
    assert.equal((await service.remove(id, ambient.id)).ok, false);
    assert.equal((await service.replace(id, ambient.id, {})).ok, false);
    await service.rename(id, ambient.id, 'Personal');
    await service.move(id, ambient.id, 'down');
    await service.setEnabled(id, ambient.id, false);
    service = make();
    const paused = service.list(id).accounts.find(item => item.source);
    assert.equal(paused.enabled, false);
    assert.equal(paused.label, 'Personal');
    assert.equal(service.list(id).accounts.at(-1).id, ambient.id);
    assert.doesNotMatch(JSON.stringify(settings[`${id}AmbientAccounts`]), /ambient-secret/);
    const calls = [];
    const fetcher = createAccountSlotFetcher({ ...entry, fetchLimits: (options) => {
      calls.push(options[field]);
      return { provider: id, status: 'ok', accountKey: options[field] === 'ambient-secret' ? 'ambient-key' : 'saved-key', accountEmail: `${options[field]}@example.com`, windows: [] };
    } });
    await fetcher(settings, { env: {} });
    assert.deepEqual(calls, ['saved-secret']);
    await service.setEnabled(id, ambient.id, true);
    calls.length = 0;
    const rows = await fetcher(settings, { env: {} });
    assert.equal(rows.filter(row => !row.removed).length, 2);
    assert.deepEqual(calls, ['ambient-secret', 'saved-secret']);
    settings[`${id}AccountSlots`][0] = { id: 'same', values: record.values, accountKey: 'ambient-key' };
    calls.length = 0;
    assert.equal((await fetcher(settings, { env: {} })).length, 1);
    assert.equal(calls.length, 1);
    const listed = service.list(id).accounts;
    assert.equal(listed.length, 2);
    assert.ok(listed.some(account => account.source === 'discovered'));
    assert.ok(listed.some(account => account.id === 'same'));
    assert.equal(listed[1].credentialFor, listed[0].id);
    signedIn = false;
    assert.equal(service.list(id).accounts.length, 1);
    assert.equal(service.list(id).accounts[0].source, undefined);
    settings[`${id}AccountSlots`] = [];
    const removed = await fetcher({ ...settings, previousLimits: { providers: rows } }, { env: {} });
    assert.deepEqual(removed.map(row => row.accountKey).sort(), rows.map(row => row.accountKey).sort());
    assert.ok(removed.every(row => row.removed));
    assert.equal(service.list(id).accounts.length, 0);
  });
  test(`${id}: fixed credential migration preserves its existing accountKey`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovered-migration-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const entry = limitProviderEntry(id), store = new CredentialStore(dir);
    const values = defaultAccountValues(entry, { [entry.status.credential]: 'saved-secret' }, {});
    store.replaceSettingsCredentials({ [entry.status.credential]: 'saved-secret', [`${id}DefaultAccountIdentity`]: { fingerprint: accountValuesFingerprint(values), accountKey: 'existing-key' } });
    const result = migrateAccountSlots(store, {}, Date.now, {});
    assert.equal(result[`${id}AccountSlots`][0].accountKey, 'existing-key');
    assert.equal(result[entry.status.credential], undefined);
  });
}

test('real Cline discovery and saved API key deduplicate through the profile account alias', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'settings'));
  fs.writeFileSync(path.join(dir, 'settings/providers.json'), JSON.stringify({ providers: { cline: { settings: { auth: { accessToken: 'workos:ambient', accountId: 'user-1', metadata: { userInfo: { email: 'personal@example.com' } } } } } } }));
  const entry = limitProviderEntry('cline');
  const ambient = entry.discoveredAccounts({ CLINE_DATA_DIR: dir }, entry.limits, { env: { CLINE_DATA_DIR: dir } });
  assert.equal(ambient[0].accountEmail, 'personal@example.com');
  const fetch = async url => ({ ok: true, status: 200, json: async () => String(url).endsWith('/me') ? { data: { id: 'user-1', email: 'personal@example.com' } } : String(url).includes('usage-limits') ? { data: { limits: [{ type: 'weekly', percentUsed: 10 }] } } : {} });
  const { LIMIT_PROVIDER_FETCHERS } = require('../../src/shared/limits/registry');
  let settings = { clineAccountSlots: [{ id: 'saved', values: { clineApiKey: 'manual' }, accountKey: require('../../src/shared/hashKey').hashKey('cline', 'manual') }] };
  const service = createAccountSlotService({ getSettings: () => settings, env: { CLINE_DATA_DIR: dir }, probeDeps: () => ({}), write: async patch => { settings = { ...settings, ...patch }; } });
  const resolutions = [];
  const rows = await LIMIT_PROVIDER_FETCHERS.cline(settings, { env: { CLINE_DATA_DIR: dir }, fetch, onAccountSlotResolved: (...args) => resolutions.push(service.resolved(...args)) });
  await Promise.all(resolutions);
  const listed = service.list('cline').accounts;
  assert.equal(listed.length, 2);
  assert.equal(listed.find(row => row.id === 'saved').credentialFor, listed.find(row => row.source === 'discovered').id);
  assert.equal(rows.filter(row => !row.removed).length, 1);
  fs.writeFileSync(path.join(dir, 'settings/providers.json'), JSON.stringify({ providers: {} }));
  assert.deepEqual(entry.discoveredAccounts({}, entry.limits, { env: { CLINE_DATA_DIR: dir } }), []);
});

test('Factory discovers the file key independently of its environment credential', t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-discovery-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(homeDir, '.factory'));
  fs.writeFileSync(path.join(homeDir, '.factory/.env'), 'FACTORY_API_KEY=file-secret\n');
  const entry = limitProviderEntry('factory');
  const records = entry.discoveredAccounts({}, entry.limits, { homeDir, env: { FACTORY_API_KEY: 'environment-secret' } });
  assert.equal(records[0].values.factoryApiKey, 'file-secret');
  assert.equal(entry.fields.find(field => field.key === 'factoryApiKey').resolve({ FACTORY_API_KEY: 'environment-secret' }), 'environment-secret');
});

for (const id of ['hark', 'manus']) test(`${id}: the real descriptor uses the desktop reader and drops a signed-out session`, () => {
  const entry = limitProviderEntry(id);
  const name = id === 'hark' ? 'readHarkDesktopSession' : 'readManusDesktopSession';
  const session = id === 'hark' ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb+/=' : { token: 'fixture-session', userId: 'user-1', email: 'personal@example.com' };
  const records = entry.discoveredAccounts({}, entry.limits, { [name]: () => session });
  assert.equal(records.length, 1);
  assert.ok(records[0].accountKey);
  if (id === 'manus') assert.equal(records[0].accountEmail, 'personal@example.com');
  assert.deepEqual(entry.discoveredAccounts({}, entry.limits, { [name]: () => { throw Object.assign(new Error('signed out'), { status: 'notConfigured' }); } }), []);
});

test('an unreadable Hark store retains its public identity as unavailable, without a credential', async () => {
  const entry = limitProviderEntry('hark');
  const { ambientAccounts } = require('../../src/shared/limits/ambientAccounts');
  const values = { harkCookie: 'fixture-session' }, fingerprint = accountValuesFingerprint(values);
  const options = { harkAmbientAccounts: { [fingerprint]: { accountKey: 'known', enabled: true, accountEmail: 'person@example.com', sourceName: 'Hark Desktop sign-in', secret: 'must-not-survive' } } };
  const deps = { env: {}, readHarkDesktopSession: () => { throw Object.assign(new Error('unreadable'), { status: 'unavailable' }); } };
  const accounts = ambientAccounts(entry, options, deps);
  assert.equal(accounts[0].accountKey, 'known');
  assert.deepEqual(accounts[0].values, {});
  assert.doesNotMatch(JSON.stringify(accounts), /must-not-survive/);
  const fetcher = createAccountSlotFetcher({ ...entry, fetchLimits: () => { throw new Error('must not query without a credential'); } });
  const rows = await fetcher(options, deps);
  assert.equal(rows[0].status, 'unavailable');
  assert.equal(rows[0].accountKey, 'known');
});

function stubDiscovery(t, id, records) {
  const entry = limitProviderEntry(id);
  const original = entry.limits.discoverAccountSlots;
  entry.limits.discoverAccountSlots = () => records();
  t.after(() => { entry.limits.discoverAccountSlots = original; });
  return entry;
}

test('factory: a working discovered key alongside FACTORY_API_KEY collects both accounts', async t => {
  const entry = stubDiscovery(t, 'factory', () => [{ values: { factoryApiKey: 'droid-secret' }, sourceName: 'Droid' }]);
  const fetcher = createAccountSlotFetcher({ ...entry, fetchLimits: (options, deps) => ({ provider: 'factory', status: 'ok', accountKey: `${options.factoryApiKey || deps.env.FACTORY_API_KEY}-account`, windows: [] }) });
  const rows = await fetcher({}, { env: { FACTORY_API_KEY: 'env-secret' } });
  assert.deepEqual(rows.filter(row => !row.removed).map(row => row.accountKey).sort(), ['droid-secret-account', 'env-secret-account']);
});

test('cline: a discovered account leaves its saved duplicate directly manageable', async t => {
  stubDiscovery(t, 'cline', () => [{ values: { clineApiKey: 'app-secret' }, accountKey: 'same-account', sourceName: 'Cline' }]);
  let settings = { clineAccountSlots: [{ id: 'saved', values: { clineApiKey: 'saved-secret' }, accountKey: 'same-account' }] };
  const service = createAccountSlotService({ getSettings: () => settings, env: {},
    probeDeps: () => ({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) }),
    write: async patch => { settings = { ...settings, ...patch }; } });
  const [detected, saved] = service.list('cline').accounts;
  assert.equal(saved.credentialFor, detected.id);
  assert.equal((await service.replace('cline', saved.id, { clineApiKey: 'replaced-secret' })).saved, true);
  assert.equal(settings.clineAccountSlots[0].values.clineApiKey, 'replaced-secret');
  assert.equal((await service.remove('cline', saved.id)).ok, true);
  const [remaining] = service.list('cline').accounts;
  assert.equal(remaining.id, detected.id);
  assert.equal(remaining.enabled, true);
  assert.deepEqual(settings.clineAccountSlots, []);
});

test('manus: after a token rotation, controls apply to the current record and the older one is dropped', async t => {
  let token = 'token-one';
  stubDiscovery(t, 'manus', () => [{ values: { manusSessionToken: token }, accountKey: 'user-1', sourceName: 'Manus' }]);
  let settings = {};
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, probeDeps: () => ({}), write: async patch => { settings = { ...settings, ...patch }; } });
  await service.rename('manus', service.list('manus').accounts[0].id, 'Work');
  token = 'token-two';
  const rotated = service.list('manus').accounts[0];
  assert.equal(rotated.label, 'Work', 'the rotated token keeps the name');
  await service.setEnabled('manus', rotated.id, false);
  assert.equal(service.list('manus').accounts[0].enabled, false, 'the pause takes effect after rotation');
  assert.equal(Object.keys(settings.manusAmbientAccounts).length, 1);
});

test('factory: an unreadable Droid file is not a sign-out; a missing one is', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-discovery-'));
  t.after(() => { fs.chmodSync(path.join(home, '.factory', '.env'), 0o600); fs.rmSync(home, { recursive: true, force: true }); });
  const { discoverAccountSlots } = limitProviderEntry('factory').limits;
  fs.mkdirSync(path.join(home, '.factory'));
  assert.deepEqual(discoverAccountSlots({ homeDir: home }), []);
  fs.writeFileSync(path.join(home, '.factory', '.env'), 'FACTORY_API_KEY=droid-secret\n');
  assert.equal(discoverAccountSlots({ homeDir: home })[0].values.factoryApiKey, 'droid-secret');
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  fs.chmodSync(path.join(home, '.factory', '.env'), 0o000);
  assert.throws(() => discoverAccountSlots({ homeDir: home }));
});

test('cline: a saved reading suppressed by the discovered alias is retired and its key handed to the survivor', async t => {
  const entry = stubDiscovery(t, 'cline', () => [{ values: { clineApiKey: 'app-secret' }, accountKey: 'server-key', sourceName: 'Cline' }]);
  const options = {
    clineAccountSlots: [{ id: 'saved', values: { clineApiKey: 'saved-secret' }, accountKey: 'saved-key' }],
    previousLimits: { providers: [{ provider: 'cline', accountKey: 'saved-key', status: 'ok', windows: [] }] }
  };
  const fetcher = createAccountSlotFetcher({ ...entry, fetchLimits: o => o.clineApiKey === 'app-secret'
    ? { provider: 'cline', status: 'ok', accountKey: 'server-key', windows: [] }
    : { provider: 'cline', status: 'ok', accountKey: 'saved-key', accountKeyAliases: ['server-key'], windows: [] } });
  const rows = await fetcher(options, { env: {} });
  const live = rows.filter(row => !row.removed);
  assert.equal(live.length, 1);
  assert.ok(live[0].accountKeyAliases?.includes('saved-key') || live[0].accountKey === 'saved-key');
  if (live[0].accountKey !== 'saved-key') assert.ok(rows.some(row => row.removed && row.accountKey === 'saved-key'));
});

test('rotated discovered identity inherits controls through a remembered alias', t => {
  const entry = stubDiscovery(t, 'cline', () => [{ values: { clineApiKey: 'new' }, accountKey: 'alias' }]);
  const { ambientAccounts } = require('../../src/shared/limits/ambientAccounts');
  const old = accountValuesFingerprint({ clineApiKey: 'old' });
  const current = accountValuesFingerprint({ clineApiKey: 'new' });
  const options = { clineAmbientAccounts: { [old]: { accountKey: 'canonical', accountKeyAliases: ['alias'], label: 'Work', enabled: false, order: 2 } } };
  assert.equal(ambientAccounts(entry, options, { env: {} })[0].enabled, false);
  assert.equal(ambientAccounts(entry, options, { env: {} })[0].order, 2);
  options.clineAmbientAccounts[current] = { label: 'Current', enabled: true };
  assert.equal(ambientAccounts(entry, options, { env: {} })[0].label, 'Current');
});

test('Factory identical environment and Droid credentials show one row before fetching', t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-duplicate-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(homeDir, '.factory'));
  fs.writeFileSync(path.join(homeDir, '.factory/.env'), 'FACTORY_API_KEY=same\n');
  const service = createAccountSlotService({ getSettings: () => ({}), env: { FACTORY_API_KEY: 'same' }, probeDeps: () => ({ homeDir }) });
  assert.equal(service.list('factory').accounts.length, 1);
});

test('discovered and environment accounts each receive a physical job budget without saved slots', t => {
  const entry = stubDiscovery(t, 'factory', () => [{ values: { factoryApiKey: 'droid' } }]);
  const { accountSlotJobs } = require('../../src/shared/limits/accountSlotFetcher');
  assert.equal(accountSlotJobs(entry, {}, { env: { FACTORY_API_KEY: 'env' } }), 2);
});

test('billing-only ZCode discovery is configured consistently with its collected row', () => {
  const declaration = require('../../src/shared/providers/zai/account');
  const discovery = { kind: 'coding-quota', entitled: false, reason: 'coding_plan_key_missing', billing: { credential: { token: 'billing' } } };
  const found = declaration.discover({}, { discoverZcodeConnection: () => discovery });
  assert.equal(found, discovery);
  assert.equal(declaration.accountStatus({ settings: {}, env: {}, discovered: found, limits: { zaiToken: () => '' } }).zaiApiKeyConfigured, true);
});

test('unavailable discovered DTOs retain their distinct credential fingerprints', () => {
  const a = accountValuesFingerprint({ harkCookie: 'a' }), b = accountValuesFingerprint({ harkCookie: 'b' });
  const service = createAccountSlotService({ getSettings: () => ({ harkAmbientAccounts: { [a]: { accountKey: 'a' }, [b]: { accountKey: 'b' } } }), env: {}, probeDeps: () => ({ readHarkDesktopSession: () => { throw new Error('unreadable'); } }) });
  assert.deepEqual(service.list('hark').accounts.map(row => row.fingerprint), [a, b].map(key => key.slice(7, 19)));
});

test('omitted ambient metadata stays omitted after credential and field projection', () => {
  const { credentialSettingsForRenderer } = require('../../src/shared/credentialStore');
  const { accountFieldProjection } = require('../../src/electron/limits/accountSettings');
  const settings = { harkAmbientAccounts: { private: 'metadata' } };
  const projection = { ...credentialSettingsForRenderer(settings), ...accountFieldProjection(settings, {}) };
  assert.equal(Object.hasOwn(projection, 'harkAmbientAccounts'), false);
});

test('saved and discovered moves swap the visible neighbour and survive restart, including environment', async t => {
  stubDiscovery(t, 'factory', () => [{ values: { factoryApiKey: 'droid' }, accountKey: 'droid-key' }]);
  let settings = { factoryAccountSlots: [{ id: 'saved', values: { factoryApiKey: 'saved' }, accountKey: 'saved-key' }] };
  const make = () => createAccountSlotService({ getSettings: () => settings, env: { FACTORY_API_KEY: 'env' }, probeDeps: () => ({}), write: async patch => { settings = { ...settings, ...patch }; } });
  let service = make();
  const discovered = service.list('factory').accounts.find(row => row.source === 'discovered').id;
  const ids = () => service.list('factory').accounts.map(row => row.id);
  await service.move('factory', 'saved', 'up');
  assert.deepEqual(ids(), [discovered, 'saved', 'environment']);
  await service.move('factory', 'saved', 'up');
  service = make();
  assert.deepEqual(ids(), ['saved', discovered, 'environment']);
  await service.move('factory', discovered, 'up');
  service = make();
  assert.deepEqual(ids(), [discovered, 'saved', 'environment']);
});

test('runtime interleaves discovered metadata positions with saved rows', async t => {
  stubDiscovery(t, 'factory', () => []);
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const fingerprint = accountValuesFingerprint({ factoryApiKey: 'droid' });
  const config = { limitsEnabled: true, limitProviders: 'factory', factoryAccountSlots: [{ id: 'saved', values: { factoryApiKey: 'saved' }, accountKey: 'saved-key' }], factoryAmbientAccounts: { [fingerprint]: { accountKey: 'droid-key', accountKeyAliases: [], order: 1 } } };
  const runtime = createLimitsRuntime(config, { env: {}, autoStart: false, autoRetry: false, providerFetchers: { factory: () => ['droid-key', 'saved-key'].map(accountKey => ({ provider: 'factory', accountKey, status: 'ok', windows: [] })) } });
  t.after(() => runtime.stop());
  await runtime.refresh({}, 'settings-change');
  assert.deepEqual(runtime.getSnapshot().providers.map(row => row.accountKey), ['saved-key', 'droid-key']);
});

test('multi-account advertisement ignores discovered credentials duplicated by a saved or environment account', t => {
  const entry = stubDiscovery(t, 'factory', () => [{ values: { factoryApiKey: 'same' }, accountKey: 'same-key' }]);
  const { configuredMultiAccountProviders } = require('../../src/shared/limits/accountSlots');
  assert.deepEqual(configuredMultiAccountProviders([entry], {}, { FACTORY_API_KEY: 'same' }), []);
  assert.deepEqual(configuredMultiAccountProviders([entry], { factoryAccountSlots: [{ id: 'saved', values: { factoryApiKey: 'same' }, accountKey: 'same-key' }] }, {}), []);
  assert.deepEqual(configuredMultiAccountProviders([entry], { factoryAccountSlots: [{ id: 'saved', values: { factoryApiKey: 'different' }, accountKey: 'same-key' }] }, {}), []);
  assert.deepEqual(configuredMultiAccountProviders([entry], {}, { FACTORY_API_KEY: 'other' }), ['factory']);
});

test('provider guidance describes independent collection followed by account identity collapse', () => {
  for (const id of ['hark', 'manus']) assert.match(fs.readFileSync(path.join(__dirname, `../../docs/providers/${id}.md`), 'utf8'), /collected independently; rows identifying the same account by key or aliases collapse into one/);
});
test('ZCode guidance distinguishes coding-plan and Start-plan ownership', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '../../docs/providers/zai.md'), 'utf8'), /coding quota plus Start\/Weekend billing for a coding-plan selection, or only Start\/Weekend billing for a Start-plan selection/);
});
test('account cap guidance distinguishes saved slots from additional ambient rows', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '../../docs/architecture.md'), 'utf8'), /21 saved slots, with discovered and environment rows additional/);
});

test('runtime order follows persisted environment and multiple discovered positions after moves', async t => {
  const entry = stubDiscovery(t, 'factory', () => ['a', 'b'].map(key => ({ values: { factoryApiKey: key }, accountKey: key })));
  let settings = { limitsEnabled: true, limitProviders: 'factory', factoryAccountSlots: [{ id: 'saved', values: { factoryApiKey: 'saved' }, accountKey: 'saved' }] };
  const env = { FACTORY_API_KEY: 'env' };
  const make = () => createAccountSlotService({ getSettings: () => settings, env, probeDeps: () => ({}), write: async patch => { settings = { ...settings, ...patch }; } });
  let service = make();
  await service.move('factory', 'saved', 'up');
  await service.move('factory', 'saved', 'up');
  service = make();
  assert.deepEqual(service.list('factory').accounts.slice(0, 3).map(row => row.accountKey), ['a', 'saved', 'b']);
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const fetcher = createAccountSlotFetcher({ ...entry, fetchLimits: (options, deps) => ({ provider: 'factory', accountKey: options.factoryApiKey || deps.env.FACTORY_API_KEY, status: 'ok', windows: [] }) });
  const runtime = createLimitsRuntime(settings, { env, autoStart: false, autoRetry: false, providerFetchers: { factory: fetcher } });
  t.after(() => runtime.stop());
  await runtime.refresh({}, 'settings-change');
  assert.deepEqual(runtime.getSnapshot().providers.map(row => row.accountKey), ['a', 'saved', 'b', 'env']);
});

test('factory: a scoped refresh reaches a discovered account by the identity this runtime resolved', async t => {
  const values = { factoryApiKey: 'droid-secret' };
  const entry = stubDiscovery(t, 'factory', () => [{ values, sourceName: 'Droid' }]);
  const fingerprint = accountValuesFingerprint(values);
  const state = new Map([[`account-slot:factory:slot:discovered-${fingerprint}:${fingerprint}`, { accountKey: 'server-key', accountKeyAliases: [] }]]);
  const calls = [];
  const fetcher = createAccountSlotFetcher({ ...entry, fetchLimits: options => { calls.push(options.factoryApiKey); return { provider: 'factory', status: 'ok', accountKey: 'server-key', windows: [] }; } });
  await fetcher({ limitRefreshScope: { provider: 'factory', accountKey: 'server-key' } }, { env: {}, providerRuntimeState: state });
  assert.deepEqual(calls, ['droid-secret']);
});

test('zai: a signed-in ZCode account whose credential is unreadable stays listed as unavailable', () => {
  const { discoverAccountSlots } = limitProviderEntry('zai').limits;
  for (const reason of ['billing_jwt_unavailable', 'coding_plan_key_missing']) {
    assert.throws(() => discoverAccountSlots({ discoverZcodeConnection: () => ({ kind: 'start-billing', entitled: false, reason }) }), error => error.status === 'unavailable');
  }
  assert.deepEqual(discoverAccountSlots({ discoverZcodeConnection: () => ({ kind: 'coding-quota', entitled: false, reason: 'coding_plan_not_authenticated' }) }), []);
});

test('cline: a missing store is no sign-in, a half-written one is unavailable', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-discovery-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { discoverAccountSlots } = limitProviderEntry('cline').limits;
  assert.deepEqual(discoverAccountSlots({ env: { CLINE_DATA_DIR: dataDir } }), []);
  fs.mkdirSync(path.join(dataDir, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings', 'providers.json'), '{ not json');
  assert.throws(() => discoverAccountSlots({ env: { CLINE_DATA_DIR: dataDir } }), error => error.status === 'unavailable');
});

test('factory: a headless collector keeps an app reading while discovery fails', async t => {
  const entry = stubDiscovery(t, 'factory', () => { throw Object.assign(new Error('store unreadable'), { status: 'unavailable' }); });
  const fetcher = createAccountSlotFetcher({ ...entry, fetchLimits: () => { throw new Error('no account should be fetched'); } });
  const rows = await fetcher({ previousLimits: { providers: [{ provider: 'factory', accountKey: 'app-key', sourceDetail: 'app', status: 'ok', windows: [] }] } }, { env: {} });
  assert.equal(rows.some(row => row.removed && row.accountKey === 'app-key'), false);
});

test('factory: a discovered credential keeps the server identity it resolved to', t => {
  const values = { factoryApiKey: 'droid-secret' };
  stubDiscovery(t, 'factory', () => [{ values, accountKey: 'credential-key', sourceName: 'Droid' }]);
  const { ambientAccounts } = require('../../src/shared/limits/ambientAccounts');
  const fingerprint = accountValuesFingerprint(values);
  const [account] = ambientAccounts(limitProviderEntry('factory'), { factoryAmbientAccounts: { [fingerprint]: { accountKey: 'server-user', accountKeyAliases: [], enabled: true } } }, { env: {} });
  assert.equal(account.accountKey, 'server-user');
  assert.ok(account.accountKeyAliases.includes('credential-key'));
});

test('hark: an account retired on sign-out is not revived by a later store failure', t => {
  stubDiscovery(t, 'hark', () => { throw Object.assign(new Error('unreadable'), { status: 'unavailable' }); });
  const { ambientAccounts } = require('../../src/shared/limits/ambientAccounts');
  const fp = id => `sha256:${id.repeat(64)}`;
  const options = {
    harkAmbientAccounts: { [fp('a')]: { accountKey: 'old-login', enabled: true }, [fp('b')]: { accountKey: 'current-login', enabled: true } },
    previousLimits: { providers: [{ provider: 'hark', accountKey: 'current-login', sourceDetail: 'app' }] }
  };
  assert.deepEqual(ambientAccounts(limitProviderEntry('hark'), options, { env: {} }).map(account => account.accountKey), ['current-login']);
});

test('cline: pausing a discovered duplicate does not retire the key a saved account still owns', async t => {
  stubDiscovery(t, 'cline', () => [{ values: { clineApiKey: 'app-secret' }, accountKey: 'same-account', sourceName: 'Cline' }]);
  let settings = { clineAccountSlots: [{ id: 'saved', values: { clineApiKey: 'saved-secret' }, accountKey: 'same-account' }] };
  const changes = [];
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, probeDeps: () => ({}),
    onChanged: (_provider, change) => changes.push(change), write: async patch => { settings = { ...settings, ...patch }; } });
  const discovered = service.list('cline').accounts.find(account => account.id.startsWith('discovered-'));
  await service.setEnabled('cline', discovered.id, false);
  assert.deepEqual(changes.at(-1).retiredAccountKeys, []);
});

test('discovered edits publish, adopt shared controls, and carry presentation through identity resolution', async t => {
  stubDiscovery(t, 'factory', () => [{ values: { factoryApiKey: 'droid' }, accountKey: 'droid-key' }]);
  let settings = { factoryAccountSlots: [{ id: 'saved', values: { factoryApiKey: 'saved' }, accountKey: 'saved-key' }] };
  const operations = [], changes = [];
  const make = () => createAccountSlotService({ getSettings: () => settings, env: { FACTORY_API_KEY: 'env' }, probeDeps: () => ({}),
    write: async patch => { settings = { ...settings, ...patch }; }, onPresentation: batch => operations.push(...batch), onChanged: (provider, change) => changes.push({ provider, ...change }) });
  let service = make();
  const found = service.list('factory').accounts.find(row => row.source === 'discovered');
  await service.rename('factory', found.id, 'Work');
  assert.deepEqual(operations.at(-1), { provider: 'factory', type: 'rename', key: 'droid-key', label: 'Work' });
  await service.move('factory', found.id, 'down');
  assert.equal(operations.at(-1).type, 'order');
  const order = ['saved-key', 'remote-key', 'droid-key', service.list('factory').accounts.find(row => row.source === 'environment').accountKey];
  const shared = { factory: { labels: { 'droid-key': 'Shared' }, order } };
  settings.limitAccountPresentation = shared;
  const beforeAdoption = changes.length;
  await service.adoptSharedLabels(shared);
  assert.deepEqual(changes.slice(beforeAdoption), [{ provider: 'factory', retiredAccountKeys: [], refresh: false }]);
  assert.equal(service.list('factory').accounts.find(row => row.id === found.id).label, 'Shared');
  service = make();
  assert.deepEqual(service.list('factory').accounts.map(row => row.accountKey), order.filter(key => key !== 'remote-key'));
  await service.resolved('factory', found.id, { accountKey: 'resolved-droid', accountKeyAliases: ['droid-key'] }, { factoryApiKey: 'droid' });
  assert.equal(settings.limitAccountPresentation.factory.labels['resolved-droid'], 'Shared');
  assert.deepEqual(settings.limitAccountPresentation.factory.order.slice(0, order.length), order.map(key => key === 'droid-key' ? 'resolved-droid' : key));
  assert.doesNotMatch(JSON.stringify(operations), /factoryApiKey|"droid"/);
  delete settings.limitAccountPresentation;
  service = make();
  assert.equal(service.list('factory').accounts[0].id, 'saved');
  assert.equal(service.list('factory').accounts.find(row => row.id === found.id).label, 'Shared');
});

for (const replacing of [false, true]) test(`factory: ${replacing ? 'replacing' : 'adding'} a saved credential sharing a detected identity publishes its name`, async t => {
  const { hashKey } = require('../../src/shared/hashKey');
  const key = hashKey('factory', 'fixture-user');
  stubDiscovery(t, 'factory', () => [{ values: { factoryApiKey: 'droid-secret' }, accountKey: key, sourceName: 'Droid' }]);
  let settings = replacing ? {
    factoryAccountSlots: [{ id: 'saved', values: { factoryApiKey: 'old-secret' }, accountKey: 'old-key', label: 'Work' }],
    limitAccountPresentation: { factory: { labels: { 'old-key': 'Work' }, order: [] } }
  } : {};
  const writes = [], published = [];
  const service = createAccountSlotService({ getSettings: () => settings, env: {},
    write: async patch => { writes.push(patch); settings = { ...settings, ...patch }; },
    onPresentation: operations => published.push(...operations),
    probeDeps: () => ({ fetch: async url => ({ ok: true, status: 200, json: async () => String(url).endsWith('/auth/me')
      ? { userProfile: { id: 'fixture-user' } }
      : { usesTokenRateLimitsBilling: true, limits: { standard: { fiveHour: { usedPercent: 10 } } } } }) }) });
  const result = replacing
    ? await service.replace('factory', 'saved', { factoryApiKey: 'droid-secret' })
    : await service.add('factory', { factoryApiKey: 'droid-secret' }, '  Work  ');
  assert.equal(result.saved, true, JSON.stringify(result));
  assert.equal(settings.factoryAccountSlots.length, 1);
  assert.equal(writes.filter(patch => patch.factoryAccountSlots).length, 1, 'commit the credential only once');
  assert.equal(settings.factoryAccountSlots[0].label, 'Work');
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts[0].source, 'discovered', 'keep the existing visible owner');
  assert.equal(result.accounts[1].credentialFor, result.accounts[0].id);
  assert.equal(settings.limitAccountPresentation.factory.labels[key], 'Work');
  assert.ok(published.some(op => op.type === 'rename' && op.key === key && op.label === 'Work'));
  assert.equal(accountName(result.accounts[0], null, value => value, settings.limitAccountPresentation.factory), 'Work');
  assert.doesNotMatch(JSON.stringify(published), /droid-secret|old-secret/);
});

for (const operation of ['rename', 'setEnabled']) test(`discovered ${operation} retains public identity when its store becomes unreadable`, async t => {
  let unreadable = false;
  stubDiscovery(t, 'factory', () => {
    if (unreadable) throw new Error('store unavailable');
    return [{ values: { factoryApiKey: 'fixture-key' }, accountKey: 'known', accountName: 'Team', accountEmail: 'member@example.com', sourceName: 'Droid' }];
  });
  let settings = {};
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, probeDeps: () => ({}), write: async patch => { settings = { ...settings, ...patch }; } });
  const id = service.list('factory').accounts[0].id;
  await service[operation]('factory', id, operation === 'rename' ? 'Work' : false);
  unreadable = true;
  const row = service.list('factory').accounts[0];
  assert.deepEqual([row.accountName, row.accountEmail, row.sourceName], ['Team', 'member@example.com', 'Droid']);
  assert.doesNotMatch(JSON.stringify(settings.factoryAmbientAccounts), /fixture-key/);
});

test('discovered resolution retires old fingerprint controls through canonical aliases', async t => {
  const values = { clineApiKey: 'new-session' };
  const old = accountValuesFingerprint({ clineApiKey: 'old-session' });
  const fingerprint = accountValuesFingerprint(values);
  stubDiscovery(t, 'cline', () => [{ values, accountKey: 'new-key', sourceName: 'Cline' }]);
  let settings = { clineAmbientAccounts: {
    [old]: { accountKey: 'old-key', accountKeyAliases: [], label: 'Work', enabled: false, order: 2 },
    unrelated: { accountKey: 'unrelated', accountKeyAliases: [], label: 'Other', enabled: true }
  } };
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, probeDeps: () => ({}), write: async patch => { settings = { ...settings, ...patch }; } });
  await service.resolved('cline', `discovered-${fingerprint}`, { accountKey: 'new-key', accountKeyAliases: ['old-key'] }, values);
  assert.equal(settings.clineAmbientAccounts[old], undefined);
  assert.equal(settings.clineAmbientAccounts[fingerprint].label, 'Work');
  assert.equal(settings.clineAmbientAccounts[fingerprint].enabled, false);
  assert.equal(settings.clineAmbientAccounts[fingerprint].order, 2);
  assert.ok(settings.clineAmbientAccounts.unrelated);
});

test('multi-account signal keeps remembered discovered canonical identity', t => {
  const values = { factoryApiKey: 'rotated' };
  const entry = stubDiscovery(t, 'factory', () => [{ values, accountKey: 'credential-key' }]);
  const { configuredMultiAccountProviders } = require('../../src/shared/limits/accountSlots');
  const options = { factoryAccountSlots: [{ id: 'saved', values: { factoryApiKey: 'saved' }, accountKey: 'server-key' }],
    factoryAmbientAccounts: { [accountValuesFingerprint(values)]: { accountKey: 'server-key', accountKeyAliases: ['previous-key'], enabled: true } } };
  assert.deepEqual(configuredMultiAccountProviders([entry], options, {}), []);
  options.factoryAccountSlots[0].accountKey = 'credential-key';
  assert.deepEqual(configuredMultiAccountProviders([entry], options, {}), [], 'new discovery key is retained as an alias');
  options.factoryAccountSlots[0].accountKey = 'different-server';
  assert.deepEqual(configuredMultiAccountProviders([entry], options, {}), ['factory']);
});


test('discovered shared labels use retired aliases without taking another account name', async t => {
  const values = { clineApiKey: 'discovered-B' };
  const fingerprint = accountValuesFingerprint(values);
  stubDiscovery(t, 'cline', () => [{ values, accountKey: 'canonical-b', sourceName: 'Cline' }]);
  let settings = {
    clineAccountSlots: [{ id: 'saved-a', values: { clineApiKey: 'saved-A' }, accountKey: 'canonical-a', label: 'A' }],
    clineAmbientAccounts: { [fingerprint]: { accountKey: 'canonical-b', accountKeyAliases: ['canonical-a', 'retired-b'], label: 'B', enabled: false } }
  };
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, probeDeps: () => ({}), write: async patch => { settings = { ...settings, ...patch }; } });
  const adopt = labels => service.adoptSharedLabels({ cline: { labels, order: [] } });
  await adopt({ 'canonical-a': 'Remote A' });
  assert.equal(settings.clineAccountSlots[0].label, 'Remote A');
  assert.equal(settings.clineAmbientAccounts[fingerprint].label, 'B');
  await adopt({ 'canonical-a': 'Remote A', 'retired-b': 'Remote B' });
  assert.equal(settings.clineAmbientAccounts[fingerprint].label, 'Remote B');
  await adopt({ 'retired-b': '' });
  assert.equal(settings.clineAmbientAccounts[fingerprint].label, '');
  await adopt({ 'canonical-b': 'Current B', 'retired-b': 'Old B' });
  assert.equal(settings.clineAmbientAccounts[fingerprint].label, 'Current B');
});


test('renaming a saved slot after matching discovery succeeds and publishes the name', async t => {
  let discovered = false;
  stubDiscovery(t, 'factory', () => discovered ? [{ values: { factoryApiKey: 'same' }, accountKey: 'known', sourceName: 'Droid' }] : []);
  let settings = { factoryAccountSlots: [{ id: 'saved', values: { factoryApiKey: 'same' }, accountKey: 'known', label: 'Before' }] };
  const published = [];
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, probeDeps: () => ({}),
    write: async patch => { settings = { ...settings, ...patch }; }, onPresentation: operations => published.push(...operations) });
  assert.equal(service.list('factory').accounts[0].id, 'saved');
  discovered = true;
  const result = await service.rename('factory', 'saved', 'After');
  assert.equal(result.ok, true);
  assert.equal(settings.factoryAccountSlots[0].label, 'After');
  assert.equal(settings.limitAccountPresentation.factory.labels.known, 'After');
  assert.ok(published.some(op => op.type === 'rename' && op.key === 'known' && op.label === 'After'));
});

test('source positions persist the local subsequence when shared order includes remote-only rows', async t => {
  stubDiscovery(t, 'factory', () => [{ values: { factoryApiKey: 'discovered' }, accountKey: 'discovered-key', sourceName: 'Droid' }]);
  let settings = { factoryAccountSlots: [{ id: 'saved', values: { factoryApiKey: 'saved' }, accountKey: 'saved-key', accountKeyAliases: ['old-saved'] }] };
  const make = () => createAccountSlotService({ getSettings: () => settings, env: { FACTORY_API_KEY: 'environment' }, probeDeps: () => ({}), write: async patch => { settings = { ...settings, ...patch }; } });
  let service = make();
  const envKey = service.list('factory').accounts.find(row => row.source === 'environment').accountKey;
  const order = ['remote-a', 'old-saved', envKey, 'remote-b', 'saved-key', 'discovered-key'];
  const group = { labels: {}, order };
  settings.limitAccountPresentation = { factory: group };
  await service.adoptSharedLabels(settings.limitAccountPresentation);
  delete settings.limitAccountPresentation;
  service = make();
  assert.deepEqual(service.list('factory').accounts.map(row => row.accountKey), [envKey, 'saved-key', 'discovered-key']);
});
