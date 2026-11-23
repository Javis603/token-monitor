'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { migrateAccountSlots } = require('../../src/electron/limits/accountSlotMigration');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { createOwnerSlotPersistence } = require('../../src/electron/limits/ownerSlotPersistence');
const { createMinimaxApiKeys } = require('../../src/electron/providers/minimax/apiKeys');
const { createClaudeManagedAccounts } = require('../../src/electron/providers/claude/managedAccounts');
const { createMimoAccountService } = require('../../src/electron/providers/mimo/accountService');
const { createMimoManagedAccount } = require('../../src/shared/providers/mimo/limits');
const { hasAccountCredential, accountValuesFingerprint } = require('../../src/shared/limits/accountSlots');
const { LIMIT_PROVIDER_FETCHERS, limitProviderEntry } = require('../../src/shared/limits/registry');
const response = body => ({ ok: true, status: 200, json: async () => body });
for (const fail of [false, true]) test(`MiMo current metadata and rollback (${fail})`, async () => {
  const old = createMimoManagedAccount('userId=1; api-platform_serviceToken=fixture-old').account;
  delete old.cookieHeader;
  let accounts = [old];
  const credentials = new Map();
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const api = createMimoAccountService({ getMimoManagedAccounts: () => accounts, setMimoManagedAccounts: next => { accounts = next; },
    getCredentialStore: () => ({ readMimoCredential: id => credentials.get(id), writeMimoCredential: (id, value) => { credentials.set(id, value); return true; }, removeMimoCredential: id => { credentials.delete(id); return true; } }),
    credentialProbeDeps: () => ({ env: {}, readMimoDesktopAccount: () => { throw Error('absent'); }, fetch: async url => {
      started.resolve(); await release.promise;
      return response({ code: 0, data: url.endsWith('/balance') ? { balance: '10' } : url.endsWith('/userProfile') ? { email: 'fixture@example.com' } : {} });
    } }), saveSettings: () => { if (fail) throw Error('disk'); }, pushSettingsToRenderer() {}, sendMimoAccountsPush() {}, queueLimitInvalidation() {} });
  const pending = api.addMimoManagedAccount('userId=2; api-platform_serviceToken=fixture-new');
  await started.promise;
  const sibling = { ...old, id: 'sibling', accountKey: 'sibling-key' };
  accounts = [sibling]; release.resolve();
  assert.equal((await pending).ok, !fail);
  assert.ok(accounts.some(a => a.id === 'sibling'));
  assert.ok(!accounts.some(a => a.id === old.id));
  if (fail) { assert.deepEqual(accounts, [sibling]); assert.equal(credentials.size, 0); }
});
for (const pauseDuringProbe of [false, true]) test(`MiMo re-add preserves pause state (during validation=${pauseDuringProbe})`, async () => {
  const original = createMimoManagedAccount('userId=1; api-platform_serviceToken=fixture-old').account;
  delete original.cookieHeader;
  original.enabled = pauseDuringProbe;
  original.accountLabel = 'Saved label';
  let accounts = [original];
  const credentials = new Map([[original.id, 'userId=1; api-platform_serviceToken=fixture-old']]);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const api = createMimoAccountService({ getMimoManagedAccounts: () => accounts, setMimoManagedAccounts: next => { accounts = next; },
    getCredentialStore: () => ({ readMimoCredential: id => credentials.get(id), writeMimoCredential: (id, value) => { credentials.set(id, value); return true; } }),
    credentialProbeDeps: () => ({ env: {}, readMimoDesktopAccount: () => { throw Error('absent'); }, fetch: async url => {
      started.resolve(); await release.promise;
      return response({ code: 0, data: url.endsWith('/balance') ? { balance: '10' } : url.endsWith('/userProfile') ? { email: 'fixture@example.com' } : {} });
    } }), saveSettings() {}, pushSettingsToRenderer() {}, sendMimoAccountsPush() {}, queueLimitInvalidation() {} });
  const pending = api.addMimoManagedAccount('userId=1; api-platform_serviceToken=fixture-new');
  await started.promise;
  if (pauseDuringProbe) assert.equal(api.setMimoManagedAccountEnabled(original.id, false).ok, true);
  release.resolve();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].enabled, false);
  assert.equal(result.accounts.find(account => account.id === original.id).enabled, false);
  assert.equal(accounts[0].id, original.id);
  assert.equal(accounts[0].addedAt, original.addedAt);
  assert.equal(accounts[0].accountLabel, 'Saved label');
  assert.match(credentials.get(original.id), /fixture-new/);
});
for (const failure of ['slotLimit', 'disk']) test(`MiniMax add leaves collection settings intact after ${failure}`, async () => {
  const settings = { limitsEnabled: false, limitProviders: 'codex' };
  if (failure === 'slotLimit') settings.minimaxAccountSlots = Array.from({ length: 21 }, (_, index) => {
    const id = `fixture-${index}`;
    return { id, values: {}, enabled: true, owner: { metadata: { id, billingMode: 'api' }, credential: id } };
  });
  const before = structuredClone(settings);
  const writes = [];
  const getSettings = () => settings;
  const service = createAccountSlotService({ getSettings, env: {}, write: patch => {
    writes.push(patch);
    throw Error('disk');
  } });
  const api = createMinimaxApiKeys({ getSettings, env: {}, slotPersistence: createOwnerSlotPersistence('minimax', getSettings, () => service),
    changed: () => assert.fail('failed save published a change'), probeDeps: () => ({ fetch: async () => response({ available_amount: 8 }) }) });
  await assert.rejects(api.addKey({ apiKey: 'fixture-new', billingMode: 'api' }), new RegExp(failure));
  assert.deepEqual(settings, before);
  assert.equal(writes.length, failure === 'disk' ? 1 : 0);
  if (writes.length) {
    assert.equal(writes[0].limitsEnabled, true);
    assert.equal(writes[0].limitProviders, 'codex,minimax');
    assert.equal(writes[0].minimaxAccountSlots.length, 1);
  }
});
for (const saved of [false, true]) test(`MiniMax removal clears matching legacy key atomically (${saved})`, async () => {
  let settings = { minimaxApiKey: 'fixture-key', minimaxApiProfiles: { default: { apiKey: 'fixture-key', enabled: true } } };
  if (saved) settings = { ...settings, minimaxApiProfiles: {}, minimaxAccountSlots: [{ id: 'default', enabled: true, values: {}, owner: { metadata: { id: 'default', enabled: true }, credential: 'fixture-key' } }] };
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: async patch => { settings = { ...settings, ...patch }; },
    ownerWrite: async (_provider, patch, metadata) => {
      settings = { ...settings, ...patch, ...(metadata === undefined ? {} : { minimaxApiProfiles: metadata }) };
    } });
  const api = createMinimaxApiKeys({ getSettings: () => settings, slotPersistence: createOwnerSlotPersistence('minimax', () => settings, () => service), env: {}, changed() {}, probeDeps: () => ({}) });
  assert.equal((await api.removeKey('default')).ok, true);
  assert.equal(settings.minimaxApiKey, ''); assert.deepEqual(api.getKeys(), []);
});
test('Claude save checks draft epoch inside queued transaction', async () => {
  let settings = { claudeManagedAccounts: [] };
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: async patch => { settings = { ...settings, ...patch }; } });
  const persistence = createOwnerSlotPersistence('claude', () => settings, () => service);
  const blocker = service.ownerTransaction('claude', async current => { await release.promise; return current; });
  const commit = persistence.commit;
  persistence.commit = (...args) => { const pending = commit(...args); started.resolve(); return pending; };
  const api = createClaudeManagedAccounts({ getSettings: () => settings, slotPersistence: persistence, credentialStore: {}, projectSettings: () => ({}),
    probeDeps: () => ({ env: {}, isClaudeCliAuthenticated: async () => false, readMacKeychain: false, readWindowsCredential: false,
      fetch: async url => response(url.endsWith('/api/organizations') ? [{ uuid: 'org-fixture' }] : url.endsWith('/api/account') ? { uuid: 'account-fixture' } : { five_hour: { utilization: 20 } }) }) });
  const saving = api.saveAccount({ claudeWebCookie: 'sk-ant-fixture', claudeWebAccountId: 'new' });
  await started.promise;
  const removal = api.removeAccount('missing'); release.resolve();
  assert.equal((await saving).saved, false); await blocker; await removal;
  assert.equal(settings.claudeAccountSlots?.length || 0, 0);
});
for (const [provider, write, read, credential] of [
  ['claude', 'writeClaudeWebCredential', 'readClaudeWebCredential', 'fixture-cookie'],
  ['antigravity', 'writeAntigravityCredential', 'readAntigravityCredential', { accessToken: 'fixture-token' }],
  ['workbuddy', 'writeWorkbuddyCredential', 'readWorkbuddyCredential', { accessToken: 'fixture-token' }]
]) test(`${provider} waits for the metadata of unimported credentials even after a false completion`, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-partial-restore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  store[write]('present', credential);
  store[write]('missing', credential);
  const present = { id: 'present', accountKey: 'present-key', enabled: false };
  const missing = { id: 'missing', accountKey: 'missing-key', enabled: true };
  const key = `${provider}ManagedAccounts`;
  const slots = `${provider}AccountSlots`;
  const migrate = (metadata) => migrateAccountSlots(store, { [key]: metadata }, () => 1000, {});
  const first = migrate([present]);
  assert.deepEqual(first[slots].map(row => row.id), ['present']);
  assert.equal(store.readDocument().migrations.accountSlots[provider], undefined);
  assert.deepEqual(store[read]('missing'), credential);

  // A previous app build may already have marked the provider complete.
  const document = store.readDocument();
  document.migrations.accountSlots[provider] = 1;
  store.writeDocument(document);
  const restored = migrate([missing]);
  assert.deepEqual(restored[slots].map(row => [row.id, row.enabled]), [['present', false], ['missing', true]]);
  assert.equal(store.readDocument().migrations.accountSlots[provider], 1);
  assert.ok(!store[read]('missing'));
});
for (const provider of ['claude', 'antigravity', 'workbuddy']) test(`${provider} resumes bounded import after credential cleanup`, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  const write = provider === 'claude' ? 'writeClaudeWebCredential' : provider === 'antigravity' ? 'writeAntigravityCredential' : 'writeWorkbuddyCredential';
  const metadata = Array.from({ length: 22 }, (_, i) => ({ id: `owner${i}`, accountKey: `key${i}`, enabled: true }));
  for (const item of metadata) store[write](item.id, provider === 'claude' ? 'fixture-cookie' : { accessToken: 'fixture-token' });
  const settings = { [`${provider}ManagedAccounts`]: metadata };
  assert.equal(migrateAccountSlots(store, settings, () => 1000, {})[`${provider}AccountSlots`].length, 21);
  assert.doesNotThrow(() => migrateAccountSlots(store, settings, () => 2000, {}));
  assert.notEqual(store.settingsCredentials()[`${provider}AccountSlots`][0].owner.credential, null);
  assert.throws(() => migrateAccountSlots(store, { [`${provider}ManagedAccounts`]: metadata.map(item => item.id === 'owner0' ? { ...item, accountKey: 'conflicting-key' } : item) }, () => 2500, {}), /conflict/);
  store[write]('owner0', provider === 'claude' ? 'conflicting-cookie' : { accessToken: 'conflicting-token' });
  const repaired = migrateAccountSlots(store, settings, () => 3000, {})[`${provider}AccountSlots`];
  assert.equal(repaired.length, 21);
  assert.equal(repaired.some(slot => slot.id === 'owner0'), false);
  assert.equal(repaired.some(slot => slot.accountKey === 'key0'), true);
});
test('queued shared label cannot overwrite newer local rename', async () => {
  const key = 'canonical';
  const shared = { deepseek: { labels: { [key]: 'A' }, order: [key] } };
  let settings = { limitAccountPresentation: shared, deepseekAccountSlots: [{ id: 'one', enabled: true, accountKey: key, label: 'old', values: { deepseekApiKey: 'fixture' } }] };
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: async patch => { settings = { ...settings, ...patch }; } });
  const rename = service.rename('deepseek', 'one', 'B');
  const adoption = service.adoptSharedLabels(shared);
  await rename; await adoption;
  assert.equal(settings.deepseekAccountSlots[0].label, 'B');
});
test('StepFun cookie input renews through dispatch and persistence', async () => {
  let settings = { stepfunAccountSlots: [{ id: 'one', enabled: true, values: { stepfunToken: 'Oasis-Token=old...refresh;other=x' } }] };
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: async patch => { settings = { ...settings, ...patch }; } });
  const initialValues = structuredClone(settings.stepfunAccountSlots[0].values);
  assert.equal(hasAccountCredential(limitProviderEntry('stepfun'), initialValues), true);
  const renewed = [];
  const rows = await LIMIT_PROVIDER_FETCHERS.stepfun(settings, { env: {}, onAccountSlotCredentialRenewed: async value => { assert.equal(accountValuesFingerprint(value.values), accountValuesFingerprint(initialValues)); renewed.push(await service.renew(value)); },
    fetch: async (url, init) => url.includes('RefreshToken') ? response({ accessToken: { raw: 'new' } })
      : url.includes('GetStepPlanStatus') ? response({}) : init.headers.Cookie.includes('old...') ? { ok: false, status: 401 }
      : response({ status: 1, five_hour_usage_left_rate: 0.8, weekly_usage_left_rate: 0.5, five_hour_usage_reset_time: 1780000000, weekly_usage_reset_time: 1780500000 }) });
  assert.ok(rows.some(row => row.status === 'ok'));
  assert.deepEqual(renewed, [true]);
  assert.equal(settings.stepfunAccountSlots[0].values.stepfunToken, 'new...refresh');
  assert.equal(await service.renew({ provider: 'stepfun', slotId: 'one', field: 'stepfunToken', previous: 'old...refresh', value: 'stale', values: initialValues }), false);
});
