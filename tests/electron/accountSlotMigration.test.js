'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { migrateAccountSlots } = require('../../src/electron/limits/accountSlotMigration');
const { accountValuesFingerprint } = require('../../src/shared/limits/accountSlots');
const { hashKey } = require('../../src/shared/hashKey');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { createAccountSlotFetcher } = require('../../src/shared/limits/accountSlotFetcher');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { limitProviderEntry } = require('../../src/shared/limits/registry');
const { accountStatusProjection } = require('../../src/electron/limits/accountSettings');
function fixture(t, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  store.replaceSettingsCredentials(settings);
  return store;
}
const values = { deepseekApiKey: 'fixture-key', deepseekWebToken: 'fixture-console' };
for (const known of [false, true]) test(`migration preserves ${known ? 'known identity, aliases and proof' : 'provisional identity'} through failed fetch and renderer`, async t => {
  const identity = { fingerprint: accountValuesFingerprint(values), accountKey: 'known-key', accountKeyAliases: ['old-key'], serverIdentity: true };
  const store = fixture(t, { ...values, ...(known ? { deepseekDefaultAccountIdentity: identity } : {}) });
  const settings = migrateAccountSlots(store, {});
  const slot = settings.deepseekAccountSlots[0];
  assert.deepEqual(slot.values, values);
  assert.equal(settings.deepseekApiKey, undefined); assert.equal(settings.deepseekWebToken, undefined);
  assert.equal(settings.deepseekDefaultAccountIdentity, undefined);
  const key = known ? identity.accountKey : hashKey('deepseek', 'account-slot', 'default');
  assert.equal(slot.accountKey, key);
  assert.deepEqual(slot.accountKeyAliases, known ? ['old-key'] : []);
  assert.equal(slot.serverIdentity, known);
  assert.deepEqual(migrateAccountSlots(store, {}), settings);
  const fetcher = createAccountSlotFetcher({ ...limitProviderEntry('deepseek'), fetchLimits: () => ({ provider: 'deepseek', status: 'unavailable', windows: [] }) });
  const runtime = createLimitsRuntime({ limitProviders: 'deepseek', ...settings }, { env: {}, autoStart: false, autoRetry: false, providerFetchers: { deepseek: fetcher } });
  t.after(() => runtime.stop());
  await runtime.refresh({}, 'settings-change');
  assert.equal(runtime.getSnapshot().providers[0].accountKey, key);
  const service = createAccountSlotService({ getSettings: () => settings, env: {} });
  assert.equal(service.list('deepseek').accounts[0].accountKey, key);
  assert.equal(accountStatusProjection(settings, {}).deepseekApiKeyConfigured, true);
});
test('Qoder environment site is copied, cookie moved; migrated account is first', t => {
  const extra = { id: 'extra', values: { qoderCookie: 'other', qoderSite: 'global' } };
  const store = fixture(t, { qoderCookie: 'cookie', qoderAccountSlots: [extra] });
  const migrated = migrateAccountSlots(store, { qoderSite: 'cn' });
  assert.equal(migrated.qoderAccountSlots[0].values.qoderSite, 'cn');
  assert.equal(migrated.qoderAccountSlots[0].values.qoderCookie, 'cookie');
  assert.equal(migrated.qoderAccountSlots[1].id, 'extra');
  assert.equal(migrated.qoderCookie, undefined);
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  assert.match(main, /migrateAccountSlots\(store, saved, Date.now, process\.env\)/);

});
test('destination verification precedes stripping; crash retry never duplicates', t => {
  const store = fixture(t, values);
  const read = store.readDocument.bind(store);
  let reads = 0;
  store.readDocument = () => { if (++reads === 3) throw new Error('crash after destination write'); return read(); };
  assert.throws(() => migrateAccountSlots(store, {}), /crash/);
  store.readDocument = read;
  assert.equal(store.settingsCredentials().deepseekApiKey, values.deepseekApiKey);
  assert.equal(store.settingsCredentials().deepseekAccountSlots.length, 1);
  const migrated = migrateAccountSlots(store, {});
  assert.equal(migrated.deepseekAccountSlots.length, 1);
  assert.equal(migrated.deepseekApiKey, undefined);
});
test('a failed read-back leaves the fixed credential intact', t => {
  const store = fixture(t, values);
  const read = store.readDocument.bind(store);
  let reads = 0;
  store.readDocument = () => { const doc = read(); if (++reads === 3) delete doc.credentials.providers.deepseek.accountSlots; return doc; };
  assert.throws(() => migrateAccountSlots(store, {}), /verification/);
  store.readDocument = read;
  assert.equal(store.settingsCredentials().deepseekApiKey, values.deepseekApiKey);
});
for (const bad of ['corrupt', 'unsupported', 'symlink']) test(`migration refuses ${bad} store without replacement`, t => {
  const store = fixture(t, values);
  const file = store.filePath;
  if (bad === 'symlink') { fs.renameSync(file, file + '.original'); fs.symlinkSync(file + '.original', file); }
  else fs.writeFileSync(file, bad === 'corrupt' ? '{' : '{"version":999}');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => migrateAccountSlots(store, {}));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('environment account is ephemeral, first, and rejects every mutation', async () => {
  const settings = { deepseekAccountSlots: [{ id: 'local', values, enabled: true }] };
  let writes = 0;
  const service = createAccountSlotService({ getSettings: () => settings, env: { DEEPSEEK_API_KEY: 'environment-key' }, write: () => writes++ });
  const accounts = service.list('deepseek').accounts;
  assert.equal(accounts[0].source, 'environment'); assert.equal(accounts[0].accountKey, hashKey('deepseek', 'environment-key')); assert.equal(accounts[1].id, 'local');
  for (const result of [await service.rename('deepseek', 'environment', 'name'), await service.setEnabled('deepseek', 'environment', false), await service.move('deepseek', 'environment', 'down'), await service.remove('deepseek', 'environment'), await service.replace('deepseek', 'environment', values)]) assert.equal(result.errorCode, 'environmentCredential');
  assert.equal(writes, 0);
});

test('fixed-form IPC routes slot providers to add; settings saves do not re-run the migration', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  assert.match(main, /ACCOUNT_SLOT_PROVIDER_IDS.has\(providerId\) \? accountSlotService.add\(providerId, values\)/);
  assert.doesNotMatch(main.slice(main.indexOf('function saveSettings('), main.indexOf('function seedInitialLimitProviders(')), /migrateAccountSlots/);
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  assert.doesNotMatch(app, /defaultParking|openDefault|defaultPanel/);
});
test('slot header counts current slots including paused accounts and environment rather than fixed key', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = source.indexOf('function renderExternalProviderStatus(');
  const end = source.indexOf('  const source = state.settings?', start);
  let text;
  const context = { externalLimitAccountConfig: {}, limitAccountForm: () => ({ accountSlots: true, status: {}, emptyKey: 'empty' }),
    document: { getElementById: () => ({}) }, accountSlotLists: { deepseek: [{ enabled: true, accountKey: 'a' }, { enabled: false, accountKey: 'b' }, { enabled: true, accountKey: 'env', source: 'environment' }] },
    localProviderStatuses: () => [{ accountKey: 'a', status: 'ok' }, { accountKey: 'b', status: 'ok' }, { accountKey: 'env', status: 'ok' }],
    limitProviderEnabled: () => true, setCursorStatusText: (_el, value) => { text = value; }, t: (_key, value) => value };
  vm.runInNewContext(source.slice(start, end) + '}\nrenderExternalProviderStatus("deepseek");', context);
  assert.equal(text.linked, 2); assert.equal(text.total, 3);
});
test('Qoder migration retains proven server identity and its aliases', t => {
  const vals = { qoderCookie: 'token=cookie', qoderSite: 'cn' };
  const store = fixture(t, { qoderCookie: vals.qoderCookie, qoderDefaultAccountIdentity: { fingerprint: accountValuesFingerprint(vals), accountKey: 'server-key', accountKeyAliases: [hashKey('qoder', vals.qoderCookie)] } });
  const migrated = migrateAccountSlots(store, { qoderSite: 'cn' });
  assert.equal(migrated.qoderAccountSlots[0].serverIdentity, true);
  assert.equal(migrated.qoderAccountSlots[0].accountKey, 'server-key');
});

test('migration preserves all twenty existing extra accounts', t => {
  const extras = Array.from({ length: 20 }, (_, i) => ({ id: `extra${i}`, values: { deepseekApiKey: `key${i}` } }));
  const store = fixture(t, { ...values, deepseekAccountSlots: extras });
  const migrated = migrateAccountSlots(store, {});
  assert.equal(migrated.deepseekAccountSlots.length, 21);
  assert.equal(migrated.deepseekApiKey, undefined);
  assert.deepEqual(migrated.deepseekAccountSlots.slice(1).map(slot => slot.id), extras.map(slot => slot.id));
});

test('a failed slot migration at startup keeps every other stored credential loaded', () => {
  const main = require('node:fs').readFileSync(require.resolve('../../src/electron/main.js'), 'utf8');
  const body = main.slice(main.indexOf('function loadCredentialSettings'), main.indexOf('function migrateLegacyMimoCredentialFiles'));
  assert.match(body, /try \{\s*stored = migrateAccountSlots\(store, saved, Date.now, process\.env\);\s*\} catch \(error\) \{[^}]*stored = store\.settingsCredentials\(\);/);
});

test('migration runs once per provider and is recorded like the store\'s other migrations', t => {
  const store = fixture(t, values);
  migrateAccountSlots(store, {});
  assert.deepEqual(store.readDocument().migrations.accountSlots, { qoder: 1, deepseek: 1 });
  // A fixed value written after the marker is not turned into another account.
  store.replaceSettingsCredentials({ ...store.settingsCredentials(), deepseekApiKey: 'later' });
  const again = migrateAccountSlots(store, {});
  assert.equal(again.deepseekAccountSlots.length, 1);
  assert.equal(again.deepseekApiKey, 'later');
});

test('a provider with nothing to migrate is marked without creating an account', t => {
  const store = fixture(t, {});
  const migrated = migrateAccountSlots(store, {});
  assert.equal(migrated.deepseekAccountSlots, undefined);
  assert.equal(store.readDocument().migrations.accountSlots.deepseek, 1);
});

test('a paused duplicate of the collected credential is resumed rather than silently stopping it', t => {
  const paused = { id: 'dup', label: 'Copy', enabled: false, values };
  const store = fixture(t, { ...values, deepseekAccountSlots: [paused] });
  const migrated = migrateAccountSlots(store, {});
  assert.equal(migrated.deepseekAccountSlots.length, 1);
  assert.equal(migrated.deepseekAccountSlots[0].id, 'dup');
  assert.equal(migrated.deepseekAccountSlots[0].enabled, true);
  assert.equal(migrated.deepseekApiKey, undefined);
});

test('activating a provider from an account save takes the settings path and reaches the renderer', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const wiring = main.slice(main.indexOf('accountSlotService = createAccountSlotService({'), main.indexOf('probeDeps: credentialProbeDeps,', main.indexOf('accountSlotService = createAccountSlotService({')));
  assert.match(wiring, /applySettingsPatch\(\{ limitProviders, limitsEnabled \}\);\s*pushSettingsToRenderer\(\);/);
  // A failed activation after the durable slot write must not surface as a failed save (a retry would add a duplicate).
  assert.match(wiring, /try \{\s*applySettingsPatch\(\{ limitProviders, limitsEnabled \}\);\s*pushSettingsToRenderer\(\);\s*\} catch \(error\) \{/);
});

test('a stored fixed credential left by a failed migration is reported as configured, matching collection', () => {
  assert.equal(accountStatusProjection({ deepseekApiKey: 'stranded' }, {}).deepseekApiKeyConfigured, true);
  assert.equal(accountStatusProjection({}, {}).deepseekApiKeyConfigured, false);
});

test('a stored console token beside an environment API key stays with the environment account', t => {
  const store = fixture(t, { deepseekWebToken: 'stored-console-token' });
  const env = { DEEPSEEK_API_KEY: 'env-key' };
  const migrated = migrateAccountSlots(store, {}, Date.now, env);
  // No slot is created from a companion alone, and the companion is not stripped.
  assert.equal(migrated.deepseekAccountSlots, undefined);
  assert.equal(migrated.deepseekWebToken, 'stored-console-token');
  assert.equal(migrated.deepseekApiKey, undefined, 'the environment secret is never persisted');
  assert.equal(store.readDocument().migrations.accountSlots.deepseek, 1);
});

