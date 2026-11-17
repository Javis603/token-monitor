'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { migrateAccountSlots } = require('../../src/electron/limits/accountSlotMigration');
const { limitsAccountConfig } = require('../../src/electron/limits/accountSettings');
const { LIMIT_PROVIDER_FETCHERS } = require('../../src/shared/limits/registry');
const { copilotAccountKey } = require('../../src/shared/providers/copilot/limits');
function fixture(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  store.replaceSettingsCredentials(source);
  return store;
}
const profiles = count => Object.fromEntries(Array.from({ length: count }, (_, i) => [`profile-${i}`, {
  token: `token-${i}`, enabled: i !== 1, enterpriseHost: 'ghe.example', accountKey: copilotAccountKey(`saved-${i}`, 'ghe.example')
}]));
async function collect(settings, scope) {
  const seen = [];
  const config = limitsAccountConfig(settings, { env: {} });
  const raw = await LIMIT_PROVIDER_FETCHERS.copilot({ ...config, ...(scope ? { limitRefreshScope: { provider: 'copilot', accountKey: scope } } : {}) }, {
    env: { COPILOT_API_TOKEN: 'must-not-collect' }, providerRuntimeState: new Map(),
    fetch: async (url, init) => {
      const token = init.headers.Authorization.slice(6);
      seen.push([url, token]);
      return { ok: true, json: async () => url.includes('copilot_internal')
        ? { quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 75, percent_remaining: 75 } } }
        : { login: `login-${token}`, id: 1 } };
    }
  });
  return { rows: (Array.isArray(raw) ? raw : [raw]).filter(r => !r.removed), seen };
}
test('Copilot first destination write failure keeps every enabled legacy account collecting and retry imports once', async t => {
  const source = { copilotProfiles: profiles(3), copilotApiToken: 'fixed', copilotEnterpriseHost: 'ghe.example' };
  const store = fixture(t, source);
  const write = store.replaceSettingsCredentials.bind(store);
  store.replaceSettingsCredentials = () => { throw new Error('first write failed'); };
  assert.throws(() => migrateAccountSlots(store, {}, Date.now, {}), /first write failed/);
  store.replaceSettingsCredentials = write;
  assert.deepEqual(store.settingsCredentials().copilotProfiles, source.copilotProfiles);
  const { rows, seen } = await collect({ ...store.settingsCredentials(), copilotEnterpriseHost: 'ghe.example' });
  assert.deepEqual(new Set(seen.map(c => c[1])), new Set(['token-0', 'token-2', 'fixed']));
  assert.ok(seen.every(c => c[0].includes('api.ghe.example')));
  assert.ok(rows.some(r => r.accountKey === source.copilotProfiles['profile-0'].accountKey));
  const imported = migrateAccountSlots(store, {}, Date.now, {});
  assert.equal(imported.copilotAccountSlots.length, 4);
  assert.deepEqual(migrateAccountSlots(store, {}, Date.now, {}), imported);
});
test('Copilot 22 profiles import bounded slots, collect overflow, and finish after space is freed', async t => {
  const source = profiles(22);
  const store = fixture(t, { copilotProfiles: source });
  const settings = migrateAccountSlots(store, {}, Date.now, {});
  assert.equal(settings.copilotAccountSlots.length, 21);
  assert.deepEqual(Object.keys(settings.copilotProfiles), ['profile-21']);
  assert.equal(store.readDocument().migrations.accountSlots.copilot, undefined);
  assert.deepEqual(migrateAccountSlots(store, {}, Date.now, {}), settings);
  const { rows, seen } = await collect(settings);
  assert.equal(rows.length, 21);
  assert.equal(new Set(seen.map(c => c[1])).size, 21);
  assert.equal(seen.length, 42);
  assert.ok(rows.some(r => r.accountKey === source['profile-21'].accountKey));
  const scoped = await collect(settings, source['profile-21'].accountKey);
  assert.deepEqual(scoped.rows.map(r => r.accountKey), [source['profile-21'].accountKey]);
  assert.deepEqual(new Set(scoped.seen.map(c => c[1])), new Set(['token-21']));
  store.replaceSettingsCredentials({ ...settings, copilotAccountSlots: settings.copilotAccountSlots.slice(1) });
  const completed = migrateAccountSlots(store, {}, Date.now, {});
  assert.equal(completed.copilotAccountSlots.length, 21);
  assert.equal(completed.copilotProfiles, undefined);
  assert.equal(store.readDocument().migrations.accountSlots.copilot, 1);
  assert.ok(!completed.copilotAccountSlots.some(s => s.values.copilotApiToken === 'token-0'));
  assert.ok(completed.copilotAccountSlots.some(s => s.accountKey === source['profile-21'].accountKey));
});


test('Copilot fallback dedupes interrupted imports and keeps paused duplicates from hiding enabled overflow', async t => {
  const source = profiles(3);
  source.copy = { ...source['profile-0'] };
  const store = fixture(t, { copilotProfiles: source });
  const read = store.readDocument.bind(store);
  store.readDocument = () => { const doc = read(); if (doc.credentials.providers?.copilot?.accountSlots?.length) throw new Error('readback failed'); return doc; };
  assert.throws(() => migrateAccountSlots(store, {}, Date.now, {}), /readback failed/);
  store.readDocument = read;
  const before = store.settingsCredentials();
  assert.deepEqual(before.copilotProfiles, source);
  const { rows, seen } = await collect(before);
  assert.equal(rows.length, 2);
  assert.equal(seen.length, 4);
  assert.deepEqual(new Set(seen.map(c => c[1])), new Set(['token-0', 'token-2']));
  const paused = { ...before, copilotAccountSlots: before.copilotAccountSlots.map(s => ({ ...s, enabled: false })) };
  const overflow = await collect(paused);
  assert.equal(overflow.rows.length, 2);
  assert.equal(overflow.seen.length, 4);
  const after = migrateAccountSlots(store, {}, Date.now, {});
  assert.deepEqual(after.copilotAccountSlots, before.copilotAccountSlots);
});

test('Copilot unmatched fixed import ID stays stable after a profile named legacy is stripped', t => {
  const source = { ...profiles(20), legacy: { token: 'named-legacy' } };
  const store = fixture(t, { copilotProfiles: source, copilotApiToken: 'fixed' });
  const pending = migrateAccountSlots(store, {}, Date.now, {});
  assert.equal(pending.copilotProfiles, undefined);
  assert.equal(pending.copilotApiToken, 'fixed');
  assert.deepEqual(migrateAccountSlots(store, {}, Date.now, {}), pending);
  store.replaceSettingsCredentials({ ...pending, copilotAccountSlots: pending.copilotAccountSlots.slice(1) });
  const write = store.replaceSettingsCredentials.bind(store);
  let writes = 0;
  store.replaceSettingsCredentials = (...args) => { if (++writes === 2) throw new Error('cleanup failed'); return write(...args); };
  assert.throws(() => migrateAccountSlots(store, {}, Date.now, {}), /cleanup failed/);
  store.replaceSettingsCredentials = write;
  const before = store.settingsCredentials();
  const after = migrateAccountSlots(store, {}, Date.now, {});
  assert.deepEqual(after.copilotAccountSlots, before.copilotAccountSlots);
  assert.equal(after.copilotAccountSlots.filter(s => s.values.copilotApiToken === 'fixed').length, 1);
});

test('Copilot legacy config is main-only, reported configured, and excluded after the migration marker', async t => {
  const { accountStatusProjection, accountFieldProjection, normalizeAccountPatch, rendererOmittedAccountKeys } = require('../../src/electron/limits/accountSettings');
  const source = { copilotProfiles: profiles(3) };
  const store = fixture(t, source);
  const settings = store.settingsCredentials();
  assert.equal(accountStatusProjection(settings, {}).copilotApiTokenConfigured, true);
  assert.ok(rendererOmittedAccountKeys().includes('copilotProfiles'));
  assert.ok(!JSON.stringify(accountFieldProjection(settings, {})).includes('token-0'));
  const patch = { ...source };
  normalizeAccountPatch(source, patch);
  assert.equal(patch.copilotProfiles, undefined);
  const fallback = await collect(settings);
  assert.equal(fallback.rows.length, 2);
  const migrated = limitsAccountConfig({ ...settings, copilotApiToken: 'stale' }, { env: {}, copilotSlotsMigrated: true });
  assert.equal(migrated.copilotProfiles, undefined);
  assert.equal(migrated.copilotApiToken, '');
});

test('Copilot failed legacy requests retain each saved enterprise identity before and during bounded migration', async t => {
  const source = profiles(22);
  const store = fixture(t, { copilotProfiles: source });
  const before = store.settingsCredentials();
  const during = migrateAccountSlots(store, {}, Date.now, {});
  for (const settings of [before, during]) {
    const raw = await LIMIT_PROVIDER_FETCHERS.copilot(limitsAccountConfig(settings, { env: {} }), {
      env: {}, fetch: async () => ({ ok: false, status: 401 })
    });
    const rows = (Array.isArray(raw) ? raw : [raw]).filter(r => !r.removed);
    assert.equal(rows.length, 21);
    assert.ok(rows.every(r => r.status === 'unauthorized'));
    assert.deepEqual(new Set(rows.map(r => r.accountKey)), new Set(Object.values(source).filter(p => p.enabled).map(p => p.accountKey)));
  }
});

test('Copilot unbound legacy profiles remember separate identities across failed requests', async () => {
  const { fetchCopilotLimits } = require('../../src/shared/providers/copilot/limits');
  const options = { copilotProfiles: { a: { token: 'a' }, b: { token: 'b', enterpriseHost: 'ghe.example' } } };
  const providerRuntimeState = new Map();
  const good = await fetchCopilotLimits(options, { env: {}, providerRuntimeState, fetch: async (url, init) => ({ ok: true,
    json: async () => url.includes('copilot_internal')
      ? { quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 75, percent_remaining: 75 } } }
      : { login: `user-${init.headers.Authorization.slice(6)}` }
  }) });
  const failed = await fetchCopilotLimits(options, { env: {}, providerRuntimeState, fetch: async () => ({ ok: false, status: 401 }) });
  assert.deepEqual(failed.map(r => r.accountKey), good.map(r => r.accountKey));
  assert.ok(failed.every(r => r.status === 'unauthorized'));
});

for (const [status, saved, verdict] of [[200, true, 'valid'], [401, false, 'invalid'], [429, true, 'indeterminate']]) {
  test(`Copilot draft probe isolates legacy profiles when the draft returns ${status}`, async () => {
    const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
    const legacy = { old: { token: 'old-valid', enabled: true, accountKey: 'old-account' } };
    let settings = { copilotProfiles: legacy };
    const seen = [], writes = [];
    const service = createAccountSlotService({ env: {}, getSettings: () => settings,
      write: async patch => { writes.push(patch); settings = { ...settings, ...patch }; },
      probeDeps: () => ({ fetch: async (url, init) => {
        const token = init.headers.Authorization.slice(6);
        seen.push(token);
        const code = token === 'new-draft' ? status : 200;
        return { ok: code === 200, status: code, json: async () => url.includes('copilot_internal')
          ? { quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 75, percent_remaining: 75 } } }
          : { login: 'draft-user', id: 1 } };
      } }) });
    const result = await service.add('copilot', { copilotApiToken: 'new-draft', copilotEnterpriseHost: '' });
    assert.ok(seen.length > 0);
    assert.deepEqual([...new Set(seen)], ['new-draft'], 'old accounts cannot vouch for a draft');
    assert.equal(result.saved, saved);
    assert.equal(result.verdict, verdict);
    assert.deepEqual(settings.copilotProfiles, legacy);
    if (!saved) assert.equal(writes.length, 0, 'a rejected draft must not change credentials');
  });
}
