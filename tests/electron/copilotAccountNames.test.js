'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { createCopilotAccounts } = require('../../src/electron/providers/copilot/accounts');
const { migrateAccountSlots } = require('../../src/electron/limits/accountSlotMigration');
const { copilotAccountKey } = require('../../src/shared/providers/copilot/limits');
const { createAccountSlotFetcher } = require('../../src/shared/limits/accountSlotFetcher');
const { limitProviderEntry } = require('../../src/shared/limits/registry');
const usage = { quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 75, percent_remaining: 75 } } };
function fixture(t, source = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-account-names-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  store.replaceSettingsCredentials(source);
  let writes = 0;
  let fetch = async url => ({ ok: true, json: async () => url.includes('copilot_internal') ? usage : { login: 'alice', id: 1 } });
  const restart = () => {
    const settings = store.settingsCredentials();
    const probeDeps = () => ({ fetch: (...args) => fetch(...args) });
    const service = createAccountSlotService({ getSettings: () => settings, env: {}, probeDeps,
      write: patch => { writes += 1; Object.assign(settings, patch); store.replaceSettingsCredentials(settings); } });
    const api = createCopilotAccounts({ service, getSettings: () => settings, env: {}, probeDeps });
    return { service, api, settings };
  };
  return { store, restart, get writes() { return writes; }, set fetch(value) { fetch = value; } };
}
for (const method of ['manual', 'login']) {
  test(`Copilot ${method} save retains public login across rename, pause and disk restart`, async t => {
    const f = fixture(t);
    const { service, api } = f.restart();
    const result = method === 'manual'
      ? await service.add('copilot', { copilotApiToken: 'private-token' }, 'Work')
      : await api.addAccount('private-token', undefined, undefined, undefined, 'Work');
    assert.equal(result.saved ?? result.ok, true);
    const account = api.getAccounts()[0];
    assert.equal(account.accountName, 'alice');
    assert.equal(account.label, 'Work');
    await service.rename('copilot', account.id, 'Renamed');
    await service.setEnabled('copilot', account.id, false);
    const restarted = f.restart().api.getAccounts()[0];
    assert.equal(restarted.accountName, 'alice');
    assert.equal(restarted.label, 'Renamed');
    assert.equal(restarted.enabled, false);
    assert.ok(!JSON.stringify(restarted).includes('private-token'));
  });
}
test('Copilot login retains its verified identity when quota is temporarily unavailable', async t => {
  const f = fixture(t);
  f.fetch = async url => url.includes('copilot_internal') ? { ok: false, status: 429 }
    : { ok: true, json: async () => ({ login: 'alice', id: 1 }) };
  const { api } = f.restart();
  assert.equal((await api.addAccount('private-token')).ok, true);
  assert.equal(f.restart().api.getAccounts()[0].accountName, 'alice');
});
test('Copilot indeterminate manual probe and numeric-only login do not invent a public name', async t => {
  const f = fixture(t);
  f.fetch = async url => url.includes('copilot_internal') ? { ok: false, status: 429 }
    : { ok: true, json: async () => ({ id: 1 }) };
  const manual = f.restart();
  const result = await manual.service.add('copilot', { copilotApiToken: 'private-token' });
  assert.equal(result.saved, true);
  assert.equal(result.verdict, 'indeterminate');
  assert.equal(Object.hasOwn(f.restart().api.getAccounts()[0], 'accountName'), false);
  assert.equal((await manual.api.addAccount('other-token')).ok, true);
  assert.ok(f.restart().api.getAccounts().every(account => !Object.hasOwn(account, 'accountName')));
});
test('Copilot legacy profile migration preserves login separately from the custom label after restart', t => {
  const f = fixture(t, { copilotProfiles: {
    old: { token: 'private-token', accountKey: copilotAccountKey('alice'), accountName: '  alice  ', enabled: false },
    unnamed: { token: 'other-token', accountKey: copilotAccountKey('other') }
  } });
  migrateAccountSlots(f.store, {}, Date.now, {});
  const [account, unnamed] = f.restart().api.getAccounts();
  assert.equal(account.accountName, 'alice');
  assert.equal(account.label, '');
  assert.equal(account.enabled, false);
  assert.equal(account.accountKey, copilotAccountKey('alice'));
  assert.equal(Object.hasOwn(unnamed, 'accountName'), false);
  assert.equal(Object.hasOwn(f.store.settingsCredentials().copilotAccountSlots[1], 'accountName'), false);
});
test('Copilot resolved names survive missing names for the same identity and clear when identity changes', async t => {
  const f = fixture(t);
  const { service, settings } = f.restart();
  await service.add('copilot', { copilotApiToken: 'private-token' });
  const slot = settings.copilotAccountSlots[0];
  await service.resolved('copilot', slot.id, { accountKey: slot.accountKey, accountKeyAliases: [], accountName: '' }, slot.values);
  assert.equal(f.restart().api.getAccounts()[0].accountName, 'alice');
  await service.resolved('copilot', slot.id, { accountKey: copilotAccountKey('bob'), accountKeyAliases: [], accountName: 'bob' }, slot.values);
  assert.equal(f.restart().api.getAccounts()[0].accountName, 'bob');
  await service.resolved('copilot', slot.id, { accountKey: copilotAccountKey('charlie'), accountKeyAliases: [], accountName: '' }, slot.values);
  assert.equal(Object.hasOwn(f.restart().api.getAccounts()[0], 'accountName'), false);
});
test('successful same-key refresh backfills and updates stored names without repeated writes or clearing missing names', async t => {
  const accountKey = copilotAccountKey('alice');
  const f = fixture(t, { copilotAccountSlots: [{ id: 'saved', values: { copilotApiToken: 'private-token' }, accountKey }] });
  let accountName = 'alice';
  const fetch = createAccountSlotFetcher({ ...limitProviderEntry('copilot'), fetchLimits: async () => ({
    provider: 'copilot', status: 'ok', accountKey, accountName, windows: []
  }) });
  for (const [name, expected, writes] of [['alice', 'alice', 1], ['alice', 'alice', 1], ['', 'alice', 1], ['Alice', 'Alice', 2]]) {
    accountName = name;
    const current = f.restart();
    const pending = [];
    await fetch(current.settings, { env: {}, onAccountSlotResolved: (...args) => pending.push(current.service.resolved(...args)) });
    await Promise.all(pending);
    assert.equal(f.restart().api.getAccounts()[0].accountName, expected);
    assert.equal(f.writes, writes);
  }
});
