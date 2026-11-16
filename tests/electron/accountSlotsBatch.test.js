'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixtures, transport } = require('../fixtures/accountSlotsBatch');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { migrateAccountSlots } = require('../../src/electron/limits/accountSlotMigration');
const { accountValuesFingerprint } = require('../../src/shared/limits/accountSlots');
const { LIMIT_PROVIDER_FETCHERS, limitProviderEntry, LIMIT_PROVIDER_REGISTRY } = require('../../src/shared/limits/registry');
const { createAccountSlotFetcher } = require('../../src/shared/limits/accountSlotFetcher');
const { limitAccountRefreshScope } = require('../../src/shared/limits/accounts');
const { hashKey } = require('../../src/shared/hashKey');

for (const [id, fixture] of Object.entries(fixtures)) {
  for (const known of [false, true]) test(`${id}: fixed migration preserves ${known ? 'resolved' : 'provisional'} key and companion fields`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slots-batch-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const entry = limitProviderEntry(id), values = fixture.values('a');
    const key = known ? fixture.key('a') : hashKey(id, 'account-slot', 'default');
    const store = new CredentialStore(dir);
    const fixed = Object.fromEntries(entry.fields.filter(f => f.kind === 'credential').map(f => [f.key, values[f.key]]));
    store.replaceSettingsCredentials({ ...fixed, ...(known ? { [`${id}DefaultAccountIdentity`]: { fingerprint: accountValuesFingerprint(values), accountKey: key, accountKeyAliases: ['old-key'] } } : {}) });
    const settings = Object.fromEntries(entry.fields.filter(f => f.kind === 'setting' && values[f.key]).map(f => [f.key, values[f.key]]));
    const migrated = migrateAccountSlots(store, settings);
    const slot = migrated[`${id}AccountSlots`][0];
    assert.deepEqual(slot.values, values);
    assert.equal(slot.accountKey, key);
    assert.deepEqual(slot.accountKeyAliases, known ? ['old-key'] : []);
    for (const field of entry.fields.filter(f => f.kind === 'credential')) assert.equal(migrated[field.key], undefined);
    assert.deepEqual(migrateAccountSlots(store, settings), migrated);
    const rows = await LIMIT_PROVIDER_FETCHERS[id]({ ...settings, ...migrated }, { env: {}, fetch: transport(id) });
    assert.equal(rows[0].accountKey, fixture.key('a'));
    assert.ok(rows[0].accountKey === key || rows[0].accountKeyAliases.includes(key));
    // Companion settings (Notion workspace) are copied without modifying settings.json.
    assert.deepEqual(settings, Object.fromEntries(entry.fields.filter(f => f.kind === 'setting' && values[f.key]).map(f => [f.key, values[f.key]])));
  });
  test(`${id}: two real fetches isolate all values and account refresh retains its sibling`, async () => {
    const entry = limitProviderEntry(id), seen = [], calls = [];
    const slots = ['a', 'b'].map(n => ({ id: n, enabled: true, values: fixture.values(n), accountKey: fixture.key(n) }));
    const fetcher = createAccountSlotFetcher({ ...entry, fetchLimits: (options, deps) => {
      const n = calls.length ? 'b' : 'a';
      for (const [field, value] of Object.entries(fixture.values(n))) assert.equal(options[field], value);
      assert.equal(options[`${id}AccountSlots`], undefined);
      assert.equal(deps.env.UNRELATED_SECRET, undefined);
      calls.push(n);
      return entry.fetchLimits(options, deps);
    } });
    const options = { ...fixture.values('b'), [entry.status.credential]: '', [`${id}AccountSlots`]: slots };
    const deps = { env: { UNRELATED_SECRET: 'default-secret' }, fetch: transport(id, seen), providerRuntimeState: new Map() };
    const rows = await fetcher(options, deps);
    assert.deepEqual(calls, ['a', 'b']);
    assert.deepEqual(rows.map(r => [r.accountKey, r.status]), ['a', 'b'].map(n => [fixture.key(n), 'ok']));
    assert.ok(seen.some(c => c.n === 'a') && seen.some(c => c.n === 'b'));
    seen.length = 0;
    const scoped = await LIMIT_PROVIDER_FETCHERS[id]({ ...options, previousLimits: { providers: rows }, limitRefreshScope: limitAccountRefreshScope(id, rows[1]) }, deps);
    assert.deepEqual(scoped.map(r => r.accountKey), [fixture.key('b')]);
    assert.ok(seen.length && seen.every(c => c.n === 'b'));
    const unknown = await LIMIT_PROVIDER_FETCHERS[id]({ ...options, previousLimits: { providers: rows }, limitRefreshScope: { provider: id, accountKey: 'remote-account' } }, deps);
    assert.deepEqual(unknown, []);
  });
}
test('batch eligibility keeps incompatible providers out of slots', () => {
  for (const id of ['devin', 'factory', 'cline', 'trae', 'alibaba', 'kimi']) assert.ok(!limitProviderEntry(id).accountSlots, id);
  assert.deepEqual(LIMIT_PROVIDER_REGISTRY.filter(e => e.accountSlots).map(e => e.id).sort(), ['qoder', 'deepseek', ...Object.keys(fixtures)].sort());
});
