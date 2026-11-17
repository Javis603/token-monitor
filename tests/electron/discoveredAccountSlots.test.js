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
    assert.equal(service.list(id).accounts.length, 1);
    signedIn = false;
    assert.equal(service.list(id).accounts.length, 1);
    assert.equal(service.list(id).accounts[0].source, undefined);
    settings[`${id}AccountSlots`] = [];
    const removed = await fetcher({ ...settings, previousLimits: { providers: rows } }, { env: {} });
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
  assert.equal(service.list('cline').accounts.length, 1);
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

test('cline: a paused discovered account leaves its saved duplicate listed and manageable', async t => {
  stubDiscovery(t, 'cline', () => [{ values: { clineApiKey: 'app-secret' }, accountKey: 'same-account', sourceName: 'Cline' }]);
  let settings = { clineAccountSlots: [{ id: 'saved', values: { clineApiKey: 'saved-secret' }, accountKey: 'same-account' }] };
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, probeDeps: () => ({}), write: async patch => { settings = { ...settings, ...patch }; } });
  assert.equal(service.list('cline').accounts.length, 1, 'two enabled owners of one account show once');
  await service.setEnabled('cline', service.list('cline').accounts[0].id, false);
  const accounts = service.list('cline').accounts;
  assert.deepEqual(accounts.map(account => [account.id.startsWith('discovered-') ? 'discovered' : account.id, account.enabled]), [['discovered', false], ['saved', true]]);
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
