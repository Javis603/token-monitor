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
const { ownerSlotAccounts } = require('../../src/shared/limits/ownerAccountSlots');
const { configuredMinimaxAccounts } = require('../../src/shared/providers/minimax/limits');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new CredentialStore(dir);
}
for (const provider of ['claude', 'antigravity', 'workbuddy']) test(`${provider} moves complete credentials with disabled and unreadable metadata; retry IDs stable`, t => {
  const store = fixture(t);
  const credential = provider === 'claude' ? 'private-cookie' : { accessToken: 'private-access', refreshToken: 'private-refresh', clientSecret: 'private-client', projectId: 'project', domain: 'realm', departmentInfo: 'department' };
  const write = provider === 'claude' ? 'writeClaudeWebCredential' : provider === 'antigravity' ? 'writeAntigravityCredential' : 'writeWorkbuddyCredential';
  store[write]('one', credential);
  const settings = { [`${provider}ManagedAccounts`]: [{ id: 'one', enabled: false, accountKey: 'canonical', accountKeyAliases: ['old'], organizationId: 'org', realm: 'cn', domain: 'realm' }, { id: 'missing', enabled: true, accountKey: 'missing-key' }] };
  const migrated = migrateAccountSlots(store, settings, () => 1000, {});
  const slots = migrated[`${provider}AccountSlots`];
  assert.equal(slots.length, 2); assert.equal(slots[0].enabled, false);
  assert.deepEqual(slots[0].owner.credential, credential); assert.equal(slots[1].owner.credential, null);
  assert.deepEqual(slots[0].accountKeyAliases, ['old']);
  assert.equal(store.readDocument().credentials.providers[provider].accounts.one, undefined);
  assert.deepEqual(migrateAccountSlots(store, settings, () => 2000, {})[`${provider}AccountSlots`], slots);
  const service = createAccountSlotService({ getSettings: () => migrated, env: {} });
  assert.doesNotMatch(JSON.stringify(service.list(provider)), /private-|clientSecret|departmentInfo|organizationId/);
});
test('readback failure keeps source; retry adopts the identical owner record', t => {
  const store = fixture(t); store.writeAntigravityCredential('one', { accessToken: 'private' });
  const settings = { antigravityManagedAccounts: [{ id: 'one', accountKey: 'key' }] };
  const read = store.readDocument.bind(store);
  store.readDocument = () => { const doc = read(); if (doc.credentials.providers?.antigravity?.accountSlots?.length) throw Error('crash'); return doc; };
  assert.throws(() => migrateAccountSlots(store, settings, () => 1000, {}), /crash/);
  store.readDocument = read;
  assert.equal(store.readAntigravityCredential('one').accessToken, 'private');
  const slots = migrateAccountSlots(store, settings, () => 2000, {}).antigravityAccountSlots;
  assert.equal(slots.length, 1); assert.equal(slots[0].id, 'one');
});
test('bounded MiniMax import retains readable overflow and disabled entries suppress env', t => {
  const store = fixture(t);
  const profiles = Object.fromEntries(Array.from({ length: 23 }, (_, i) => [`key${i}`, { apiKey: `private-${i}`, enabled: i > 0, billingMode: i % 2 ? 'api' : 'token-plan', apiRegion: 'cn' }]));
  store.replaceSettingsCredentials({ minimaxApiProfiles: profiles });
  const migrated = migrateAccountSlots(store, {}, () => 1000, {});
  assert.equal(migrated.minimaxAccountSlots.length, 21);
  assert.equal(Object.keys(migrated.minimaxApiProfiles).length, 2);
  const accounts = configuredMinimaxAccounts(migrated, { env: { MINIMAX_CODING_API_KEY: 'env-private' } });
  assert.equal(accounts.length, 22); assert(!accounts.some(account => account.apiKey === 'env-private'));
  assert.equal(store.readDocument().migrations.accountSlots.minimax, undefined);
});
test('shared owner transactions preserve complete credentials and reject removed renewal/write failure', async () => {
  let settings = { antigravityAccountSlots: [{ id: 'one', enabled: true, values: {}, accountKey: 'key', owner: { metadata: { id: 'one', enabled: true, accountKey: 'key' }, credential: { accessToken: 'private', project: { id: 'p' } } } }] };
  let failing = false;
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: patch => { if (failing) throw Error('write'); settings = { ...settings, ...patch }; } });
  const persistence = createOwnerSlotPersistence('antigravity', () => settings, () => service);
  const pendingRemove = service.remove('antigravity', 'one');
  const pendingRenew = persistence.commit(persistence.accounts(), [{ id: 'one', credential: { accessToken: 'late' } }]);
  await pendingRemove; await assert.rejects(pendingRenew, /superseded/);
  assert.equal(settings.antigravityAccountSlots.length, 0);
  failing = true;
  await assert.rejects(persistence.commit([{ id: 'new', accountKey: 'new' }], [{ id: 'new', credential: { accessToken: 'new' } }]), /write/);
  assert.equal(settings.antigravityAccountSlots.length, 0);
});
test('presentation adapter admits only trusted non-slot identities and leaves management closed', async () => {
  let settings = {}; const published = [];
  const service = createAccountSlotService({ getSettings: () => settings, write: patch => { settings = { ...settings, ...patch }; }, presentationAccounts: () => ['canonical'], onPresentation: ops => published.push(...ops), env: {} });
  assert.equal((await service.presentation('codex', 'canonical', 'rename', 'Work')).ok, true);
  assert.equal(settings.limitAccountPresentation.codex.labels.canonical, 'Work');
  assert.equal((await service.presentation('codex', '', 'order', ['canonical'])).ok, true);
  assert.equal((await service.presentation('codex', 'untrusted', 'rename', 'Bad')).ok, false);
  assert.equal((await service.presentation('codex', '', 'order', Array(201).fill('canonical'))).ok, false);
  assert.equal((await service.remove('codex', 'canonical')).errorCode, 'unsupportedProvider');
  assert.equal((await service.add('codex', {})).errorCode, 'unsupportedProvider');
  assert.equal(published.length, 2); assert.doesNotMatch(JSON.stringify(settings), /credential|token/i);
});
test('owner collector projection keeps disabled context without exposing it through generic DTO', () => {
  const options = { workbuddyAccountSlots: [{ id: 'a', enabled: false, label: 'Name', accountKey: 'canonical', accountKeyAliases: ['previous'], owner: { metadata: { realm: 'international', domain: 'enterprise', departmentInfo: 'dept' }, credential: { accessToken: 'secret' } } }] };
  assert.deepEqual(ownerSlotAccounts(options, 'workbuddy')[0], { id: 'a', enabled: false, accountLabel: 'Name', accountKey: 'canonical', accountKeyAliases: ['previous'], realm: 'international', domain: 'enterprise', departmentInfo: 'dept', credentials: { accessToken: 'secret' } });
});

 test('Claude login publishes fresh safe metadata from slots and renewed cookie stays main-only', async () => {
  const { createClaudeManagedAccounts } = require('../../src/electron/providers/claude/managedAccounts');
  let settings = { claudeManagedAccounts: [], limitProviders: 'claude' };
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: patch => { settings = { ...settings, ...patch }; } });
  const persistence = createOwnerSlotPersistence('claude', () => settings, () => service);
  let publications = 0;
  const api = createClaudeManagedAccounts({ getSettings: () => settings, setSettings: value => { settings = value; }, saveSettings() {}, slotPersistence: persistence,
    projectSettings: () => ({ claudeManagedAccounts: api.accounts() }), onChanged: () => publications++,
    probeDeps: () => ({ env: {}, readMacKeychain: false, readWindowsCredential: false, stat: async () => { throw Error('absent'); },
      isClaudeCliAuthenticated: async () => false, fetch: async url => ({ ok: true, status: 200, headers: { get: () => '', getSetCookie: () => [] }, json: async () =>
        url.endsWith('/api/organizations') ? [{ uuid: 'org', name: 'Work' }] : url.endsWith('/api/account') ? { uuid: 'acct', email_address: 'person@example.com' } : { five_hour: { utilization: 20 } } }) }) });
  assert.equal((await api.saveAccount({ claudeWebAccountId: 'new', claudeWebCookie: 'sk-ant-private' })).saved, true);
  const account = api.accounts()[0];
  assert.equal(account.organizationId, 'org'); assert(publications > 0);
  assert.equal(persistence.read(account.id), 'sessionKey=sk-ant-private');
  assert.doesNotMatch(JSON.stringify(api.accounts()), /sk-ant|cookie|credential/i);
  assert.equal(await api.renew({ accountId: account.id, previousCookie: 'sk-ant-private', cookie: 'sk-ant-renewed' }), true);
  await service.setEnabled('claude', account.id, false);
  assert.equal(await api.renew({ accountId: account.id, previousCookie: 'sk-ant-renewed', cookie: 'sk-ant-late' }), false);
  assert.match(require('node:fs').readFileSync(require.resolve('../../src/electron/main'), 'utf8'), /claudeManagedAccounts: claudeAccountService\(\)\.accounts\(\)/);
});
test('overflow renewal and removal stay on the owner transaction lane without promoting or dropping records', async () => {
  const slot = { id: 'saved', enabled: true, values: {}, accountKey: 'saved-key', owner: { metadata: { id: 'saved' }, credential: 'saved-cookie' } };
  let settings = { claudeAccountSlots: [slot], claudeManagedAccounts: [{ id: 'overflow', enabled: true, accountKey: 'overflow-key' }] };
  const credentials = { overflow: 'old-cookie' };
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: patch => { settings = { ...settings, ...patch }; },
    ownerWrite: (_provider, patch, metadata, writes) => {
      settings = { ...settings, ...patch, claudeManagedAccounts: metadata };
      for (const { id, credential } of writes) { if (credential === null) delete credentials[id]; else credentials[id] = credential; }
    } });
  const persistence = createOwnerSlotPersistence('claude', () => settings, () => service, id => credentials[id]);
  await persistence.commit(persistence.accounts(), [{ id: 'overflow', credential: 'renewed' }]);
  assert.equal(credentials.overflow, 'renewed'); assert.equal(settings.claudeAccountSlots.length, 1);
  await persistence.commit(persistence.accounts().filter(account => account.id !== 'overflow'), [{ id: 'overflow', credential: null }]);
  assert.equal(credentials.overflow, undefined); assert.equal(settings.claudeManagedAccounts.length, 0);
  assert.equal(settings.claudeAccountSlots[0].owner.credential, 'saved-cookie');
});

test('MiniMax legacy IPC saves only slots with billing/region and leaves Code independent', async () => {
  const { createMinimaxApiKeys } = require('../../src/electron/providers/minimax/apiKeys');
  let settings = {}; const changes = [];
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: patch => { settings = { ...settings, ...patch }; } });
  const persistence = createOwnerSlotPersistence('minimax', () => settings, () => service);
  const api = createMinimaxApiKeys({ getSettings: () => settings, saveSettings() {}, slotPersistence: persistence, env: {}, changed: (...args) => changes.push(args),
    probeDeps: () => ({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ available_amount: 8, base_resp: { status_code: 0 } }) }) }) });
  assert.equal((await api.addKey({ apiKey: 'private-api', billingMode: 'api', apiRegion: 'cn' })).ok, true);
  assert.equal(settings.minimaxApiProfiles, undefined); assert.equal(settings.minimaxApiKey, undefined);
  assert.equal(settings.minimaxAccountSlots[0].owner.credential, 'private-api');
  assert.equal(api.getKeys()[0].billingMode, 'api'); assert.equal(api.getKeys()[0].apiRegion, 'cn');
  assert(changes.length > 0); assert.doesNotMatch(JSON.stringify(api.getKeys()), /private-api/);
  assert.equal((await api.removeKey(api.getKeys()[0].id)).ok, true);
  assert.equal(settings.minimaxAccountSlots.length, 0);
});

test('owner persistence does not grant generic account-scoped dispatch to Antigravity or WorkBuddy', () => {
  const { limitAccountRefreshScope } = require('../../src/shared/limits/accounts');
  for (const provider of ['antigravity', 'workbuddy']) assert.deepEqual(limitAccountRefreshScope(provider, { accountKey: 'known', accountEmail: 'person@example.com', sourceDetail: 'oauth' }), { provider });
  assert.equal(limitAccountRefreshScope('claude', { accountKey: 'known' }).accountKey, 'known');
  assert.equal(limitAccountRefreshScope('minimax', { accountKey: 'known' }).accountKey, 'known');
});

function ownerHarness(provider, initial) {
  let settings = { [`${provider}AccountSlots`]: initial };
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: patch => { settings = { ...settings, ...patch }; } });
  const persistence = createOwnerSlotPersistence(provider, () => settings, () => service);
  return { service, persistence, settings: () => settings };
}
function ownerRecord(id, metadata, credential = null) {
  return { id, label: '', enabled: metadata.enabled !== false, values: {}, accountKey: metadata.accountKey || '', accountKeyAliases: [], serverIdentity: Boolean(metadata.accountKey),
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', owner: { metadata: { id, ...metadata }, credential } };
}
test('Antigravity renewal, state, login and removal preserve metadata-only repair slots', async () => {
  const { createAntigravityAccountService } = require('../../src/electron/providers/antigravity/accountService');
  const repair = ownerRecord('repair', { enabled: false, accountKey: 'repair-key', recoveryContext: 'keep' });
  const original = { accessToken: 'old', refreshToken: 'refresh' };
  const h = ownerHarness('antigravity', [ownerRecord('ok', { enabled: true, accountEmail: 'ok@example.com', accountKey: 'ok-key' }, original), repair]);
  const api = createAntigravityAccountService({ slotPersistence: h.persistence, electronLimitsFetch: () => {}, openExternal() {}, pushSettingsToRenderer() {}, sendAntigravityAccountsPush() {}, queueLimitInvalidation() {},
    oauthLogin: async () => ({ credential: { accessToken: 'login' }, identity: { email: 'new@example.com', name: 'New' } }) });
  assert.equal(await api.persistAntigravityCredentialsRenewal({ account: { id: 'ok' }, previous: original, credentials: { ...original, accessToken: 'new' } }), true);
  assert.deepEqual(h.settings().antigravityAccountSlots.find(slot => slot.id === 'repair'), repair);
  assert.equal((await api.setAntigravityManagedAccountEnabled('ok', false)).ok, true);
  assert.deepEqual(h.settings().antigravityAccountSlots.find(slot => slot.id === 'repair'), repair);
  assert.equal((await api.addAntigravityManagedAccount()).ok, true);
  assert.deepEqual(h.settings().antigravityAccountSlots.find(slot => slot.id === 'repair'), repair);
  assert.equal((await api.removeAntigravityManagedAccount('ok')).ok, true);
  assert(!h.settings().antigravityAccountSlots.some(slot => slot.id === 'ok'));
  assert.deepEqual(h.settings().antigravityAccountSlots.find(slot => slot.id === 'repair'), repair);
});
for (const provider of ['claude', 'workbuddy']) test(`${provider} projected owner updates preserve raw siblings and explicit removal stays removed`, async () => {
  const normalize = provider === 'claude' ? require('../../src/shared/providers/claude/webAccounts').normalizeClaudeManagedAccounts : require('../../src/shared/providers/workbuddy/oauth').normalizeManagedAccounts;
  const metadata = provider === 'claude' ? { organizationId: 'org' } : { realm: 'cn', domain: 'www.codebuddy.cn', userId: 'user' };
  const sibling = ownerRecord('sibling', { ...metadata, ...(provider === 'workbuddy' ? { userId: 'sibling-user' } : {}), enabled: false, accountKey: 'sibling-key', recoveryContext: 'keep' });
  const repair = ownerRecord('repair', { enabled: false, recoveryContext: 'keep' });
  const h = ownerHarness(provider, [ownerRecord('ok', { ...metadata, enabled: true, accountKey: 'ok-key' }, 'old'), sibling, repair]);
  const projected = normalize(h.persistence.accounts());
  assert(projected.some(account => account.id === 'ok'));
  await h.persistence.commit(projected, [{ id: 'ok', credential: 'new' }]);
  assert.deepEqual(h.settings()[`${provider}AccountSlots`].find(slot => slot.id === 'sibling'), sibling);
  assert.deepEqual(h.settings()[`${provider}AccountSlots`].find(slot => slot.id === 'repair'), repair);
  await h.persistence.commit(normalize(h.persistence.accounts()).filter(account => account.id !== 'ok'), [{ id: 'ok', credential: provider === 'claude' ? '' : null }]);
  assert(!h.settings()[`${provider}AccountSlots`].some(slot => slot.id === 'ok'));
  await h.persistence.commit(normalize(h.persistence.accounts()), []);
  assert(!h.settings()[`${provider}AccountSlots`].some(slot => slot.id === 'ok'));
});
test('MiniMax bounded import retries only remaining legacy profiles after pause and removal', async t => {
  const store = fixture(t);
  store.replaceSettingsCredentials({ minimaxApiProfiles: Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`k${i}`, { apiKey: `private-${i}`, enabled: true }])) });
  let settings = migrateAccountSlots(store, {}, () => 1000, {});
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: patch => { store.replaceSettingsCredentials({ ...store.settingsCredentials(), ...patch }); settings = { ...settings, ...patch }; } });
  await service.setEnabled('minimax', 'k0', false);
  await service.remove('minimax', 'k1');
  const paused = structuredClone(settings.minimaxAccountSlots.find(slot => slot.id === 'k0'));
  const migrated = migrateAccountSlots(store, settings, () => 2000, {});
  assert.equal(migrated.minimaxAccountSlots.length, 21);
  assert.deepEqual(migrated.minimaxAccountSlots.find(slot => slot.id === 'k0'), paused);
  assert(!migrated.minimaxAccountSlots.some(slot => slot.id === 'k1'));
  assert(migrated.minimaxAccountSlots.some(slot => slot.id === 'k21'));
  assert.equal(Object.keys(migrated.minimaxApiProfiles || {}).length, 0);
  assert.equal(store.readDocument().migrations.accountSlots.minimax, 1);
});
test('MiniMax interrupted import still rejects conflicting owner and preserves its legacy source', t => {
  const store = fixture(t);
  store.replaceSettingsCredentials({ minimaxApiProfiles: { k0: { apiKey: 'private', enabled: true } } });
  const read = store.readDocument.bind(store);
  store.readDocument = () => { const doc = read(); if (doc.credentials.providers?.minimax?.accountSlots?.length) throw Error('interrupted'); return doc; };
  assert.throws(() => migrateAccountSlots(store, {}, () => 1000, {}), /interrupted/);
  store.readDocument = read;
  const saved = store.settingsCredentials();
  assert.equal(saved.minimaxApiProfiles.k0.apiKey, 'private');
  saved.minimaxAccountSlots[0].owner.credential = 'conflict';
  store.replaceSettingsCredentials(saved);
  assert.throws(() => migrateAccountSlots(store, {}, () => 2000, {}), /import conflict/);
  assert.equal(store.settingsCredentials().minimaxApiProfiles.k0.apiKey, 'private');
});


for (const enabled of [true, false]) test(`MiniMax removes ${enabled ? 'enabled' : 'disabled'} legacy overflow durably before retry`, async t => {
  const { createMinimaxApiKeys } = require('../../src/electron/providers/minimax/apiKeys');
  const store = fixture(t);
  store.replaceSettingsCredentials({ minimaxApiProfiles: Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`k${i}`, { apiKey: `private-${i}`, enabled: i === 21 ? enabled : true }])) });
  let settings = migrateAccountSlots(store, {}, () => 1000, {});
  const persist = patch => { store.replaceSettingsCredentials({ ...store.settingsCredentials(), ...patch }); settings = { ...settings, ...patch }; };
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: persist,
    ownerWrite: (_provider, patch, metadata) => persist({ ...patch, minimaxApiProfiles: metadata }) });
  const persistence = createOwnerSlotPersistence('minimax', () => settings, () => service);
  const api = createMinimaxApiKeys({ getSettings: () => settings, saveSettings() {}, slotPersistence: persistence, env: {}, changed() {}, probeDeps: () => ({}) });
  assert(api.getKeys().some(account => account.id === 'k21'));
  assert.equal((await api.removeKey('k21')).ok, true);
  assert(!api.getKeys().some(account => account.id === 'k21'));
  assert.equal(store.settingsCredentials().minimaxApiProfiles?.k21, undefined);
  assert.equal((await api.removeKey('k1')).ok, true);
  const retried = migrateAccountSlots(store, settings, () => 2000, {});
  assert(!retried.minimaxAccountSlots.some(slot => slot.id === 'k21'));
  assert(!retried.minimaxAccountSlots.some(slot => slot.id === 'k1'));
  assert.equal(retried.minimaxAccountSlots.length, 20);
});

for (const provider of ['grok', 'kiro']) test(`${provider} automatic accounts can only edit presentation for main-proven identities`, async () => {
  let settings = {}; const writes = [];
  const service = createAccountSlotService({ getSettings: () => settings,
    write: patch => { writes.push(patch); settings = { ...settings, ...patch }; },
    presentationAccounts: id => id === provider ? ['detected-key'] : [], env: {} });
  assert.equal((await service.presentation(provider, 'arbitrary', 'rename', 'Bad')).ok, false);
  assert.equal((await service.presentation(provider, '', 'order', ['arbitrary'])).ok, false);
  assert.equal(writes.length, 0);
  assert.equal((await service.presentation(provider, 'detected-key', 'rename', 'Work')).ok, true);
  assert.equal((await service.presentation(provider, '', 'order', ['detected-key'])).ok, true);
  assert.equal(settings.limitAccountPresentation[provider].labels['detected-key'], 'Work');
  assert.ok(writes.every(patch => Object.keys(patch).every(key => key === 'limitAccountPresentation')));
  assert.equal((await service.add(provider, {})).errorCode, 'unsupportedProvider');
  assert.equal((await service.remove(provider, 'detected-key')).errorCode, 'unsupportedProvider');
  assert.equal((await service.setEnabled(provider, 'detected-key', false)).errorCode, 'unsupportedProvider');
});
