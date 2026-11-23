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
test('Alibaba migration captures the selected console without storing an environment cookie', t => {
  const store = fixture(t, { alibabaCookie: 'fixture-cookie' });
  const env = { ALIBABA_TOKEN_PLAN_VARIANT: 'intl-personal', ALIBABA_TOKEN_PLAN_COOKIE: 'fixture-environment-cookie' };
  const migrated = migrateAccountSlots(store, {}, Date.now, env);
  assert.deepEqual(migrated.alibabaAccountSlots[0].values, { alibabaCookie: 'fixture-cookie', alibabaVariant: 'intl-personal' });
  assert.ok(!migrated.alibabaCookie);
});

test('an interrupted Alibaba import preserves its chosen console across environment changes', t => {
  const store = fixture(t, { alibabaCookie: 'fixture-cookie' });
  const read = store.readDocument.bind(store);
  store.readDocument = () => {
    const document = read();
    if (document.credentials.providers?.alibaba?.accountSlots?.length) throw Error('interrupted');
    return document;
  };
  assert.throws(() => migrateAccountSlots(store, {}, Date.now, { ALIBABA_TOKEN_PLAN_VARIANT: 'intl-personal' }), /interrupted/);
  store.readDocument = read;
  const migrated = migrateAccountSlots(store, {}, Date.now, {});
  assert.deepEqual(migrated.alibabaAccountSlots.map(slot => slot.values.alibabaVariant), ['intl-personal']);
  assert.ok(!migrated.alibabaCookie);
});

test('startup makes a conflicting legacy owner reachable even when saved slots are full', t => {
  const legacy = { id: 'same', organizationId: 'legacy-org', enabled: true };
  const clash = { id: 'same', enabled: true, values: {}, accountKey: 'saved-key',
    owner: { metadata: { ...legacy, organizationId: 'different-org' }, credential: 'fixture-slot' } };
  const others = Array.from({ length: 20 }, (_, i) => ({ ...clash, id: `slot-${i}`,
    owner: { ...clash.owner, metadata: { id: `slot-${i}` } } }));
  const store = fixture(t, { claudeAccountSlots: [clash, ...others] });
  store.writeClaudeWebCredential(legacy.id, 'fixture-source');
  const main = fs.readFileSync(require.resolve('../../src/electron/main.js'), 'utf8');
  const loader = main.slice(main.indexOf('function loadCredentialSettings'), main.indexOf('function readSettings()'));
  const saved = { claudeManagedAccounts: [legacy] };
  const errors = [];
  let written;
  const run = require('node:vm').runInNewContext(`let openrouterSlotsMigrated, copilotSlotsMigrated; ${loader}; loadCredentialSettings`, {
    ensureCredentialStore: () => store, migrateAccountSlots, process: { env: {} }, require,
    reportCredentialStorageError: (_message, error) => errors.push(error.message),
    LIMIT_PROVIDER_REGISTRY: require('../../src/shared/limits/registry').LIMIT_PROVIDER_REGISTRY,
    hasCredentialSettings: () => true, settingsPath: 'settings.json',
    stripCredentialSettings: require('../../src/shared/credentialStore').stripCredentialSettings,
    writePrivateJsonAtomic: (_path, settings) => { written = JSON.parse(JSON.stringify(settings)); }
  });
  const stored = run(saved);
  assert.deepEqual(errors, []);
  assert.equal(store.readClaudeWebCredential(legacy.id), 'fixture-source');
  assert.deepEqual(Array.from(saved.claudeManagedAccounts), [legacy]);
  assert.deepEqual(written.claudeManagedAccounts, [legacy]);
  const settings = { ...saved, ...stored };
  const persistence = require('../../src/electron/limits/ownerSlotPersistence')
    .createOwnerSlotPersistence('claude', () => settings, () => null, id => store.readClaudeWebCredential(id));
  assert.equal(persistence.accounts().find(row => row.id === legacy.id)?.organizationId, legacy.organizationId);
  assert.equal(persistence.read(legacy.id), 'fixture-source');
  const collected = require('../../src/shared/limits/ownerAccountSlots').mergedOwnerAccounts(settings, 'claude', saved.claudeManagedAccounts);
  assert.equal(collected.find(row => row.id === legacy.id)?.organizationId, legacy.organizationId);
  const savedCopy = collected.find(row => row.accountKey === 'saved-key');
  assert.equal(savedCopy.credentials, 'fixture-slot');
  assert.notEqual(savedCopy.id, legacy.id);
});

test('owner imports never turn a provider-reported label into a rename', t => {
  const store = fixture(t);
  store.writeClaudeWebCredential('claude-web', 'fixture-cookie');
  store.writeAntigravityCredential('antigravity-login', { accessToken: 'fixture-token' });
  const settings = migrateAccountSlots(store, {
    claudeManagedAccounts: [{ id: 'claude-web', organizationId: 'org', accountKey: 'claude-key', accountLabel: 'Max 20x', enabled: true }],
    antigravityManagedAccounts: [{ id: 'antigravity-login', accountEmail: 'person@example.com', accountKey: 'ag-key', accountLabel: 'Profile Name', enabled: true }]
  }, Date.now, {});
  assert.equal(settings.claudeAccountSlots[0].label, '');
  assert.equal(settings.claudeAccountSlots[0].owner.metadata.accountLabel, 'Max 20x');
  assert.equal(settings.antigravityAccountSlots[0].label, '');
});

test('successive Claude restores preserve each credential when the legacy ID is reused', t => {
  const id = 'same';
  const saved = { id, organizationId: 'saved-org', enabled: true };
  const store = fixture(t, { claudeAccountSlots: [{ id, enabled: true, values: {}, accountKey: 'saved-key',
    owner: { metadata: saved, credential: 'fixture-saved' } }] });
  for (const version of ['first', 'second']) {
    store.writeClaudeWebCredential(id, `fixture-${version}`);
    const metadata = { id, organizationId: `${version}-org`, enabled: true, accountKey: `${version}-key` };
    const settings = migrateAccountSlots(store, { claudeManagedAccounts: [metadata] }, Date.now, {});
    assert.equal(settings.claudeAccountSlots.find(slot => slot.id === id)?.owner.credential, `fixture-${version}`);
    assert.equal(store.readClaudeWebCredential(id), '');
  }
  const slots = store.settingsCredentials().claudeAccountSlots;
  assert.equal(new Set(slots.map(slot => slot.id)).size, 3);
  assert.deepEqual(slots.map(slot => [slot.accountKey, slot.owner.credential]), [
    ['saved-key', 'fixture-saved'], ['first-key', 'fixture-first'], ['second-key', 'fixture-second']
  ]);
});

test('legacy Claude Settings save uses the fixed credential IPC path', async () => {
  const main = fs.readFileSync(require.resolve('../../src/electron/main.js'), 'utf8');
  const line = main.split('\n').find(line => line.includes("ipcMain.handle('limits:saveCredential'"));
  let handler;
  const fixed = [];
  Function('ipcMain', 'ACCOUNT_SLOT_PROVIDER_IDS', 'credentialCommands', 'accountSlotService', line)(
    { handle: (_channel, fn) => { handler = fn; } }, new Set(['claude', 'qoder']),
    { hasRetainedCredential: () => false, saveCredential: (...args) => fixed.push(args) },
    { add: () => ({ errorCode: 'providerEditorRequired' }) });
  const values = { claudeWebCookie: 'fixture-cookie', claudeWebOrganizationId: 'fixture-org' };
  await handler(null, 'claude', values);
  assert.deepEqual(fixed, [['claude', values]]);
});

test('Volcengine migration leaves a stored access key paired with its environment secret', t => {
  const store = fixture(t, { volcengineAccessKeyId: 'AKLT-test-key' });
  const env = { VOLCENGINE_SECRET_ACCESS_KEY: 'test-environment-secret' };
  const settings = migrateAccountSlots(store, {}, Date.now, env);
  assert.equal(settings.volcengineAccessKeyId, 'AKLT-test-key');
  assert.equal(settings.volcengineSecretAccessKey, undefined);
  assert.equal(settings.volcengineAccountSlots, undefined);
  assert.equal(limitProviderEntry('volcengine').limits.volcengineCredentials(env, settings)?.mode, 'signed');
});
test('Volcengine retains controls to replace and clear a fixed key backed by an environment secret', async t => {
  const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');
  const store = fixture(t, { volcengineAccessKeyId: 'AKLT-before-fixture' });
  const env = { VOLCENGINE_SECRET_ACCESS_KEY: 'environment-fixture-secret' };
  let settings = { ...migrateAccountSlots(store, {}, Date.now, env),
    volcengineRegion: 'cn-shanghai', volcengineAgentRegion: 'cn-guangzhou' };
  const service = createAccountSlotService({ getSettings: () => settings, env });
  assert.deepEqual(service.list('volcengine').accounts, []);
  assert.equal(accountStatusProjection(settings, env).volcengineFixedCredentialsStored, true);
  const signed = [];
  const commands = createCredentialCommands({
    allowRetainedFixedCredentials: true,
    getSettings: () => settings, env,
    applySettingsPatch(patch) {
      store.replaceSettingsCredentials({ ...settings, ...patch });
      settings = { ...settings, ...patch };
      return accountStatusProjection(settings, env);
    },
    probeDeps: () => ({ fetch: async (url, options) => {
      signed.push(options.headers.Authorization ?? options.headers.authorization);
      if (String(url).includes('GetAFPUsage')) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ Result: { QuotaUsage: [{ Level: 'session', Percent: 10 }] } }) };
    } })
  });
  const vm = require('node:vm');
  const { createDocument } = require('./accountOwnerDom.fixture.cjs');
  const limitAccountPanelsApi = require('../../src/electron/renderer/limits/accountPanels');
  const { limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
  const document = createDocument();
  document.root.id = 'accountsSettingsDetails';
  document.querySelectorAll = () => [...document.root.walk()]
    .filter(node => node.dataset.credentialForm === 'volcengine' && node.dataset.byField);
  const app = fs.readFileSync(require.resolve('../../src/electron/renderer/app.js'), 'utf8');
  const form = limitAccountFormsForRenderer().find(({ id }) => id === 'volcengine');
  const state = { settings: { ...accountStatusProjection(settings, env), limitAccountForms: [form],
    volcengineRegion: settings.volcengineRegion, volcengineAgentRegion: settings.volcengineAgentRegion }, accountPanelMessages: {} };
  const context = {
    document, state, limitAccountPanelsApi, limitAccountForm: () => form,
    LIMIT_PROVIDERS: [{ id: 'volcengine', label: 'Volcengine' }],
    window: { TokenMonitorAccountSlotsPanel: { createPanel: () => ({
      element: document.createElement('div'), summary: () => ({ total: 0, linked: 0 })
    }) }, tokenMonitor: { limits: {} } },
    accountSlotPanels: new Map(), preserveSettingsPanelScroll: callback => callback(),
    limitProviderAccountGroup: () => null, setExternalAccountExpanded() {}, initSettingsAnimationWrappers() {},
    externalProviderForAccount: () => null, externalProviderAccountLinked: () => false,
    externalProviderCheckSettled: new Set(), limitProviderEnabled: () => true,
    t: key => key, setCursorStatusText() {}, apiKeyAccountStatusText: () => '', renderSettingsSummaries() {},
    legacyAccountOwners: { claude: { editor: {} } },
    saveAccountCredential(id, values) { return commands.saveCredential(id, values); },
    async clearAccountCredential(id) {
      const result = await commands.clearCredential(id);
      state.settings = { ...state.settings, ...result.settings };
      context.renderExternalProviderStatus(id);
      return result;
    }
  };
  const setup = app.slice(app.indexOf('function setupLimitAccountPanels('), app.indexOf('function limitProviderAccountGroup('));
  const status = app.slice(app.indexOf('function renderExternalProviderStatus('), app.indexOf('function renderOpenCodeProfiles('));
  vm.runInNewContext(setup + status + '\nsetupLimitAccountPanels();', context);
  const retained = document.getElementById('volcengineFixedCredentialForm');
  assert.equal(retained.classList.contains('hidden'), false);
  const input = document.getElementById('volcengineAccessKeyIdInput');
  assert.equal(input.value, '');
  assert.ok(retained.contains(input));
  assert.ok(retained.contains(document.getElementById('volcengineLogoutButton')));
  input.value = 'AKLT-after-fixture';
  let saved;
  context.saveAccountCredential = async (id, values) => { saved = await commands.saveCredential(id, values); return saved; };
  await document.getElementById('volcengineCredentialSubmit').click();
  assert.equal(saved.verdict, 'valid');
  assert.ok(signed.some(header => /Credential=AKLT-after-fixture\/[^/]+\/cn-shanghai\//.test(header)));
  assert.equal(settings.volcengineRegion, 'cn-shanghai');
  assert.equal(settings.volcengineAgentRegion, 'cn-guangzhou');
  assert.equal(store.settingsCredentials().volcengineAccessKeyId, 'AKLT-after-fixture');
  assert.equal(store.settingsCredentials().volcengineSecretAccessKey, undefined);
  document.getElementById('volcengineAgentRegionInput').value = '';
  context.renderExternalProviderStatus('volcengine');
  await document.getElementById('volcengineCredentialSubmit').click();
  assert.equal(settings.volcengineAgentRegion, '');
  assert.equal((await document.getElementById('volcengineLogoutButton').click()).cleared, true);
  assert.equal(retained.classList.contains('hidden'), true);
  assert.equal(accountStatusProjection(settings, env).volcengineFixedCredentialsStored, false);
  assert.equal(env.VOLCENGINE_SECRET_ACCESS_KEY, 'environment-fixture-secret');
  assert.equal(store.settingsCredentials().volcengineAccessKeyId, undefined);
});

test('Volcengine rejects a retained Coding key even when the edited Agent key has no quota', async () => {
  const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');
  const settings = { volcengineAccessKeyId: 'AKLT-before-fixture' };
  const commands = createCredentialCommands({
    allowRetainedFixedCredentials: true,
    getSettings: () => settings,
    env: { VOLCENGINE_SECRET_ACCESS_KEY: 'environment-coding-fixture', VOLCENGINE_AGENT_SECRET_ACCESS_KEY: 'environment-agent-fixture' },
    applySettingsPatch: () => assert.fail('a rejected key must not replace the saved credential'),
    probeDeps: () => ({ fetch: async (_url, options) => {
      const authorization = options.headers.Authorization ?? options.headers.authorization;
      const ok = authorization.includes('Credential=AKLT-agent-fixture/');
      return { ok, status: ok ? 200 : 403, json: async () => ({ Result: {} }) };
    } })
  });
  const result = await commands.saveCredential('volcengine', {
    volcengineAccessKeyId: 'AKLT-rejected-fixture', volcengineAgentAccessKeyId: 'AKLT-agent-fixture'
  });
  assert.equal(result.saved, false);
  assert.equal(result.status, 'unauthorized');
});

test('Volcengine migration retains a complete Coding pair with a split Agent pair', async t => {
  const stored = { volcengineAccessKeyId: 'AKLT-coding', volcengineSecretAccessKey: 'coding-secret',
    volcengineAgentAccessKeyId: 'AKLT-agent' };
  const env = { VOLCENGINE_AGENT_SECRET_ACCESS_KEY: 'agent-environment-secret' };
  const store = fixture(t, stored);
  const fetcher = createAccountSlotFetcher(limitProviderEntry('volcengine'));
  const deps = { env, fetch: async url => ({ ok: true, status: 200, json: async () => String(url).includes('GetAFPUsage')
    ? { Result: { PlanType: 'Medium', AFPFiveHour: { Quota: 200, Used: 50 } } }
    : { Result: { QuotaUsage: [{ Level: 'session', Percent: 10 }] } } }) };
  const before = await fetcher(stored, deps);
  const migrated = migrateAccountSlots(store, {}, Date.now, env);
  const after = await fetcher(migrated, deps);
  assert.equal(migrated.volcengineAccountSlots, undefined);
  assert.equal(migrated.volcengineAgentSecretAccessKey, undefined);
  assert.equal(before.length, 2);
  assert.deepEqual(after.map(row => [row.accountKey, row.status]), before.map(row => [row.accountKey, 'ok']));
});
test('MiniMax imports the remaining fixed key after freeing a slot without overwriting the named default', t => {
  const fixed = 'fixture-fixed';
  const minimaxApiProfiles = { default: { apiKey: 'fixture-named' } };
  for (let index = 1; index <= 20; index++) minimaxApiProfiles['profile-' + index] = { apiKey: 'fixture-' + index };
  const store = fixture(t, { minimaxApiKey: fixed, minimaxApiProfiles });
  const first = migrateAccountSlots(store, {}, Date.now, {});
  assert.equal(first.minimaxAccountSlots.length, 21);
  assert.equal(first.minimaxApiKey, fixed);

  const retained = first.minimaxAccountSlots.filter(slot => slot.id !== 'profile-1');
  store.replaceSettingsCredentials({ ...first, minimaxAccountSlots: retained });
  const second = migrateAccountSlots(store, {}, Date.now, {});
  assert.equal(second.minimaxApiKey, undefined);
  assert.deepEqual(second.minimaxAccountSlots.slice(0, 20), retained);
  const imported = second.minimaxAccountSlots.at(-1);
  assert.equal(imported.id, 'default-2');
  assert.equal(imported.owner.credential, fixed);
  assert.deepEqual(migrateAccountSlots(store, {}, Date.now, {}), second);
});

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
  store.readDocument = () => { const doc = read(); if (doc.credentials.providers?.deepseek?.accountSlots?.length) throw new Error('crash after destination write'); return doc; };
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
  store.readDocument = () => { const doc = read(); if (doc.credentials.providers?.deepseek?.accountSlots?.length) delete doc.credentials.providers.deepseek.accountSlots; return doc; };
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
test('environment credential is ephemeral and read-only, with movable presentation', async () => {
  const settings = { deepseekAccountSlots: [{ id: 'local', values, enabled: true }] };
  let writes = 0;
  const service = createAccountSlotService({ getSettings: () => settings, env: { DEEPSEEK_API_KEY: 'environment-key' }, write: () => writes++ });
  const accounts = service.list('deepseek').accounts;
  assert.equal(accounts[0].source, 'environment'); assert.equal(accounts[0].accountKey, hashKey('deepseek', 'environment-key')); assert.equal(accounts[1].id, 'local');
  for (const result of [await service.rename('deepseek', 'environment', 'name'), await service.setEnabled('deepseek', 'environment', false), await service.remove('deepseek', 'environment'), await service.replace('deepseek', 'environment', values)]) assert.equal(result.errorCode, 'environmentCredential');
  assert.equal(writes, 0);
  assert.equal((await service.move('deepseek', 'environment', 'down')).ok, true);
  assert.equal(writes, 1);
});

test('fixed-form IPC adds ordinary slots and edits retained credentials in place', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const vm = require('node:vm');
  const start = main.indexOf("ipcMain.handle('limits:saveCredential'");
  let save;
  vm.runInNewContext(main.slice(start, main.indexOf('\n', start)), {
    ipcMain: { handle: (_channel, handler) => { save = handler; } },
    ACCOUNT_SLOT_PROVIDER_IDS: new Set(['volcengine', 'qoder']),
    credentialCommands: { hasRetainedCredential: id => id === 'volcengine', saveCredential: () => 'fixed' },
    accountSlotService: { add: () => 'slot' }
  });
  assert.equal(save(null, 'volcengine', {}), 'fixed');
  assert.equal(save(null, 'qoder', {}), 'slot');
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
    document: { getElementById: () => ({}) }, accountSlotPanels: new Map([['deepseek', { summary: () => ({ linked: 2, total: 3 }) }]]),
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
  const body = main.slice(main.indexOf('function loadCredentialSettings'), main.indexOf('function readSettings()', main.indexOf('function loadCredentialSettings')));
  assert.match(body, /try \{\s*stored = migrateAccountSlots\(store, saved, Date.now, process\.env\);\s*\} catch \(error\) \{[^}]*stored = store\.settingsCredentials\(\);/);
});

test('migration runs once per provider and is recorded like the store\'s other migrations', t => {
  const store = fixture(t, values);
  migrateAccountSlots(store, {});
  assert.deepEqual(store.readDocument().migrations.accountSlots, Object.fromEntries(require('../../src/shared/limits/registry').LIMIT_PROVIDER_REGISTRY.filter(entry => entry.accountSlots).map(entry => [entry.id, 1])));
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

