'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixtures, transport } = require('../fixtures/accountSlotsBatch');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { migrateAccountSlots } = require('../../src/electron/limits/accountSlotMigration');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { createLimitsHistoryStore } = require('../../src/electron/limits/historyStore');
const { LIMIT_PROVIDER_FETCHERS, limitProviderEntry } = require('../../src/shared/limits/registry');
const fixture = fixtures.zaiteam;
const entry = limitProviderEntry('zaiteam');
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slots-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('mixed-source migration keeps stored companions for the environment account', async t => {
  const store = new CredentialStore(directory(t));
  const { zaiTeamApiKey, ...companions } = fixture.values('a');
  const env = { ZAI_TEAM_API_KEY: zaiTeamApiKey };
  store.replaceSettingsCredentials(companions);
  assert.equal((await entry.fetchLimits(companions, { env, fetch: transport('zaiteam') })).status, 'ok');
  const migrated = migrateAccountSlots(store, {}, Date.now, env);
  const rows = await LIMIT_PROVIDER_FETCHERS.zaiteam(migrated, { env, fetch: transport('zaiteam') });
  assert.equal((Array.isArray(rows) ? rows.find(row => !row.removed) : rows).status, 'ok');
  const withSlot = await LIMIT_PROVIDER_FETCHERS.zaiteam({ ...migrated, zaiteamAccountSlots: [{ id: 'other', values: fixture.values('b') }] }, { env, fetch: transport('zaiteam') });
  assert.deepEqual(withSlot.filter(row => !row.removed).map(row => [row.accountKey, row.status]), ['a', 'b'].map(n => [fixture.key(n), 'ok']));
  assert.ok(!migrated.zaiteamAccountSlots?.length);
  for (const [key, value] of Object.entries(companions)) assert.equal(migrated[key], value);
  assert.equal(store.readDocument().migrations.accountSlots.zaiteam, 1);
  assert.deepEqual(migrateAccountSlots(store, {}, Date.now, env), migrated);
  const service = createAccountSlotService({ getSettings: () => migrated, env });
  const accounts = service.list('zaiteam').accounts;
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].source, 'environment');
  assert.deepEqual(accounts[0].formValues, companions);
  assert.ok(!JSON.stringify(store.readDocument()).includes(zaiTeamApiKey));
  assert.ok(!JSON.stringify(accounts).includes(zaiTeamApiKey));
});
for (const [from, to] of [['a', 'b'], ['b', 'a']]) {
  test(`GLM Team replacement ${from} to ${to} rejects a different quota pool and preserves key rotation`, async () => {
    let settings = {};
    const fetch = async () => ({ ok: true, status: 200, json: async () => fixture.body() });
    const service = createAccountSlotService({ getSettings: () => settings, env: {},
      write: async patch => { settings = { ...settings, ...patch }; }, probeDeps: () => ({ fetch }) });
    assert.equal((await service.add('zaiteam', fixture.values(from))).saved, true);
    const old = structuredClone(settings.zaiteamAccountSlots[0]);
    const result = await service.replace('zaiteam', old.id, fixture.values(to));
    assert.equal(result.verdict, 'differentAccount');
    assert.equal(result.saved, false);
    assert.deepEqual(settings.zaiteamAccountSlots[0], old);
    const rotated = await service.replace('zaiteam', old.id, { zaiTeamApiKey: 'rotated-key' });
    assert.equal(rotated.saved, true);
    assert.equal(settings.zaiteamAccountSlots[0].accountKey, old.accountKey);
    assert.deepEqual(settings.zaiteamAccountSlots[0].accountKeyAliases, old.accountKeyAliases);
  });
  test(`GLM Team fetch ${from} to ${to} separates quota history while same-pool rotation keeps it`, async t => {
    const now = new Date(2026, 10, 17, 12).getTime();
    const old = await entry.fetchLimits(fixture.values(from), { env: {}, fetch: transport('zaiteam'), now: () => now - 300000 });
    // Close before removing: Windows cannot delete a directory holding an open database.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slots-regression-'));
    const history = createLimitsHistoryStore(path.join(dir, 'history.sqlite'), { now: () => now });
    t.after(async () => { await history.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    await history.record('local', { providers: [old] });
    const fetch = async () => ({ ok: true, status: 200, json: async () => fixture.body() });
    // Persisted proof survives an offline edit of the slot's pair.
    const slot = { id: 'one', values: fixture.values(to), accountKey: old.accountKey, accountKeyAliases: ['older'], serverIdentity: true };
    const rows = await LIMIT_PROVIDER_FETCHERS.zaiteam({ zaiteamAccountSlots: [slot] }, { env: {}, fetch, now: () => now });
    const row = rows.find(r => !r.removed);
    assert.equal(row.accountKey, fixture.key(to));
    const separated = await history.query('local', row);
    assert.ok(separated.windows.length);
    assert.ok(separated.windows.every(w => w.points.length === 0), 'different pool must not adopt history');
    assert.ok(!(row.accountKeyAliases || []).includes(old.accountKey));
    assert.ok(!(row.accountKeyAliases || []).includes('older'));
    const same = await LIMIT_PROVIDER_FETCHERS.zaiteam({ zaiteamAccountSlots: [{ ...slot,
      values: { ...fixture.values(from), zaiTeamApiKey: 'rotated-key' } }] }, { env: {}, fetch, now: () => now });
    assert.equal(same[0].accountKey, old.accountKey);
    assert.ok(same[0].accountKeyAliases.includes('older'));
    const retained = await history.query('local', same[0]);
    assert.ok(retained.windows.some(w => w.points.length > 0), 'same pool keeps history');
  });
}
