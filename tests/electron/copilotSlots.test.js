'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { migrateAccountSlots } = require('../../src/electron/limits/accountSlotMigration');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { createCopilotAccounts } = require('../../src/electron/providers/copilot/accounts');
const { LIMIT_PROVIDER_FETCHERS } = require('../../src/shared/limits/registry');
const { copilotAccountKey } = require('../../src/shared/providers/copilot/limits');
const usage = { quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 75, percent_remaining: 75 } } };
function transport(seen = [], loginForToken = token => `login-${token}`) {
  return async (url, init) => {
    const token = init.headers.Authorization.slice(6);
    assert.equal(init.headers.Host, undefined);
    seen.push([url, token]);
    return { ok: true, json: async () => url.includes('copilot_internal') ? usage : { login: loginForToken(token), id: 1 } };
  };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  store.replaceSettingsCredentials({ copilotProfiles: {
    first: { token: 'alice', enterpriseHost: 'ghe.example', accountKey: copilotAccountKey('alice', 'ghe.example'), accountName: 'alice', enabled: false },
    second: { token: 'bob', accountKey: copilotAccountKey('bob') }
  }, copilotApiToken: 'legacy' });
  return store;
}
test('Copilot migration retains order, exact identities, hosts and pause state without inventing labels; legacy once', t => {
  const store = fixture(t);
  const settings = migrateAccountSlots(store, {});
  const slots = settings.copilotAccountSlots;
  assert.deepEqual(slots.map(s => [s.label, s.enabled, s.values.copilotApiToken]), [['', false, 'alice'], ['', true, 'bob'], ['', true, 'legacy']]);
  assert.equal(slots[0].values.copilotEnterpriseHost, 'ghe.example');
  assert.equal(slots[0].accountKey, copilotAccountKey('alice', 'ghe.example'));
  assert.equal(slots[2].accountKey, copilotAccountKey('legacy'));
  assert.equal(settings.copilotApiToken, undefined);
  assert.equal(settings.copilotProfiles, undefined);
  assert.deepEqual(migrateAccountSlots(store, {}), settings);
});
test('Copilot interrupted migration verifies before stripping and retries with stable IDs', t => {
  const store = fixture(t);
  const read = store.readDocument.bind(store);
  store.readDocument = () => { const doc = read(); if (doc.credentials.providers?.copilot?.accountSlots?.length) throw new Error('interrupted'); return doc; };
  assert.throws(() => migrateAccountSlots(store, {}), /interrupted/);
  store.readDocument = read;
  const before = store.settingsCredentials();
  assert.ok(before.copilotProfiles);
  assert.deepEqual(migrateAccountSlots(store, {}).copilotAccountSlots, before.copilotAccountSlots);
});
function serviceFixture(loginForToken) {
  let settings = {};
  const seen = [];
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: patch => { settings = { ...settings, ...patch }; }, probeDeps: () => ({ fetch: transport(seen, loginForToken) }) });
  const api = createCopilotAccounts({ service, getSettings: () => settings, env: {}, probeDeps: () => ({ fetch: transport(seen, loginForToken) }) });
  return { service, api, seen, get settings() { return settings; } };
}
test('Copilot reports capacity for a new account but accepts the same account at capacity', async () => {
  const { service } = serviceFixture();
  for (let index = 0; index < 21; index++) {
    assert.equal((await service.add('copilot', { copilotApiToken: `fixture-${index}` })).saved, true);
  }
  const atCapacity = service.list('copilot').accounts;
  assert.deepEqual(await service.add('copilot', { copilotApiToken: 'another-fixture' }),
    { ok: false, errorCode: 'slotLimit', limit: 21 });
  assert.deepEqual(service.list('copilot').accounts, atCapacity);
  assert.equal((await service.add('copilot', { copilotApiToken: 'fixture-0' })).saved, true);
  assert.equal(service.list('copilot').accounts.length, 21);
});
test('Copilot real transport isolates two saved accounts and scoped refresh, and rejects replacing a proven identity', async () => {
  const f = serviceFixture();
  assert.equal((await f.service.add('copilot', { copilotApiToken: 'alice', copilotEnterpriseHost: '' })).saved, true);
  assert.equal((await f.service.add('copilot', { copilotApiToken: 'bob', copilotEnterpriseHost: 'ghe.example' })).saved, true);
  f.seen.length = 0;
  const rows = await LIMIT_PROVIDER_FETCHERS.copilot(f.settings, { env: { COPILOT_API_TOKEN: 'ignored' }, fetch: transport(f.seen) });
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(f.seen.map(c => c[1])), new Set(['alice', 'bob']));
  assert.ok(f.seen.filter(c => c[1] === 'bob').every(c => c[0].includes('api.ghe.example')));
  f.seen.length = 0;
  await LIMIT_PROVIDER_FETCHERS.copilot({ ...f.settings, limitRefreshScope: { provider: 'copilot', accountKey: rows[1].accountKey } }, { env: {}, fetch: transport(f.seen) });
  assert.deepEqual(new Set(f.seen.map(c => c[1])), new Set(['bob']));
  const id = f.service.list('copilot').accounts[0].id;
  assert.equal((await f.service.replace('copilot', id, { copilotApiToken: 'charlie' })).verdict, 'differentAccount');
  assert.ok(!JSON.stringify(f.service.list('copilot')).includes('copilotApiToken'));
});
test('Copilot environment precedence and saved-account suppression include paused slots', async () => {
  const seen = [];
  await LIMIT_PROVIDER_FETCHERS.copilot({}, { env: { COPILOT_API_TOKEN: 'alice', GITHUB_COPILOT_TOKEN: 'ignored', COPILOT_ENTERPRISE_HOST: 'one.example', GITHUB_ENTERPRISE_HOST: 'two.example' }, fetch: transport(seen) });
  assert.ok(seen.every(([url, token]) => token === 'alice' && url.includes('api.one.example')));
  const f = serviceFixture();
  await f.api.addAccount('alice');
  await f.api.addAccount('alice');
  assert.equal(f.settings.copilotAccountSlots.length, 1);
  await f.service.setEnabled('copilot', f.settings.copilotAccountSlots[0].id, false);
  seen.length = 0;
  await LIMIT_PROVIDER_FETCHERS.copilot(f.settings, { env: { COPILOT_API_TOKEN: 'ignored' }, fetch: transport(seen) });
  assert.equal(seen.length, 0);
});
test('Copilot browser draft commits through slot lane; cancelled/stale flow cannot commit', async () => {
  const f = serviceFixture();
  assert.equal((await f.api.addAccount('alice')).ok, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.api.addAccount('bob', () => true, controller.signal), /cancelled/);
  await assert.rejects(f.api.addAccount('bob', () => false), /cancelled/);
  let release;
  const block = new Promise(resolve => { release = resolve; });
  let current = true;
  const pending = f.service.loginAction('copilot', async () => {
    await block;
    return { values: { copilotApiToken: 'bob' }, identity: { accountKey: copilotAccountKey('bob') }, isCurrent: () => current };
  });
  current = false;
  release();
  assert.equal((await pending).errorCode, 'cancelled');
  assert.equal(f.settings.copilotAccountSlots.length, 1);
});

test('real Copilot device-flow IPC fences cancelled flow and stale cancel, and returns no token', async () => {
  const vm = require('node:vm');
  const f = serviceFixture();
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const handlers = new Map(), pending = [], events = [];
  const context = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, AbortController,
    copilotLoginController: null, copilotLoginFlowId: '', settings: {}, process: { env: {} },
    runCopilotDeviceFlowLogin: options => new Promise(resolve => { pending.push({ resolve, options }); }),
    copilotAccounts: f.api, copilotLoginErrorMessage: () => 'Sign-in cancelled',
    shell: { openExternal() {} }, clipboard: { writeText() {} }, fetch() {} };
  vm.runInNewContext(main.slice(main.indexOf("  ipcMain.handle('copilot:signIn'"), main.indexOf("  ipcMain.on('window:minimize'")), context);
  const event = { sender: { isDestroyed: () => false, send: (name, payload) => events.push([name, payload]) } };
  const first = handlers.get('copilot:signIn')(event, { flowId: 'first' });
  handlers.get('copilot:cancelSignIn')(event, { flowId: 'unrelated' });
  assert.equal(pending[0].options.signal.aborted, false);
  pending[0].options.onStatus({ phase: 'authorize', userCode: 'CODE' });
  assert.equal(events[0][1].flowId, 'first');
  handlers.get('copilot:cancelSignIn')(event, { flowId: 'first' });
  const second = handlers.get('copilot:signIn')(event, { flowId: 'second', label: 'Work' });
  pending[0].resolve({ accessToken: 'stale-token' });
  assert.equal((await first).ok, false);
  pending[1].resolve({ accessToken: 'alice' });
  const result = await second;
  assert.equal(result.ok, true);
  assert.equal(result.flowId, 'second');
  assert.equal(f.settings.copilotAccountSlots.length, 1);
  assert.equal(f.settings.copilotAccountSlots[0].values.copilotApiToken, 'alice');
  assert.equal(f.settings.copilotAccountSlots[0].label, 'Work');
  assert.ok(!JSON.stringify([result, events]).includes('alice'));
});

test('Copilot renderer settings and form DTOs omit tokens and credential declarations', async () => {
  const { accountFieldProjection, limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
  const f = serviceFixture(() => 'public-login');
  await f.api.addAccount('unique-private-token');
  const projected = accountFieldProjection(f.settings);
  const forms = limitAccountFormsForRenderer().find(form => form.id === 'copilot');
  const data = JSON.stringify([projected, forms, f.service.list('copilot')]);
  assert.equal(f.service.list('copilot').accounts[0].accountName, 'public-login');
  assert.ok(!data.includes('unique-private-token'));
  assert.ok(!JSON.stringify(forms).includes('storePath'));
});
