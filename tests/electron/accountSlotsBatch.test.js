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
    store.replaceSettingsCredentials({ ...fixed, ...(known ? { [`${id}DefaultAccountIdentity`]: { fingerprint: accountValuesFingerprint(values), accountKey: key, accountKeyAliases: ['old-key'] } } : { [`${id}DefaultAccountIdentity`]: { fingerprint: accountValuesFingerprint(values), accountKey: key, accountKeyAliases: [] } }) });
    const settings = Object.fromEntries(entry.fields.filter(f => f.kind === 'setting' && values[f.key]).map(f => [f.key, values[f.key]]));
    const migrated = migrateAccountSlots(store, settings);
    const slot = migrated[`${id}AccountSlots`][0];
    assert.deepEqual(slot.values, values);
    assert.equal(slot.accountKey, key);
    if (!known) assert.equal(slot.serverIdentity, false);
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
  for (const id of ['factory', 'cline', 'alibaba', 'kimi']) assert.ok(!limitProviderEntry(id).accountSlots, id);
  assert.deepEqual(LIMIT_PROVIDER_REGISTRY.filter(e => e.accountSlots).map(e => e.id).sort(), ['qoder', 'deepseek', ...Object.keys(fixtures)].sort());
});

for (const id of ['opendesign', 'commandcode', 'notion']) {
  test(`${id}: verified identity changes separate aliases and quota history; provisional identity still adopts`, async t => {
    const { createLimitsHistoryStore } = require('../../src/electron/limits/historyStore');
    const fixture = fixtures[id], entry = limitProviderEntry(id), values = fixture.values('a');
    const fetch = async (url) => ({ ok: true, status: 200, json: async () => fixture.body('b', url) });
    const now = new Date(2026, 10, 17, 12).getTime();
    const old = await entry.fetchLimits(values, { env: {}, fetch: transport(id), now: () => now - 300000 });
    const slot = { id: 'one', values, accountKey: old.accountKey, accountKeyAliases: ['older'], serverIdentity: true };
    const rows = await LIMIT_PROVIDER_FETCHERS[id]({ [`${id}AccountSlots`]: [slot] }, { env: {}, fetch, now: () => now });
    const row = rows.find(r => !r.removed);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-separation-'));
    const errors = [];
    const history = createLimitsHistoryStore(path.join(dir, 'history.sqlite'), { now: () => now, onError: e => errors.push(e) });
    t.after(async () => { await history.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    await history.record('local', { providers: [old] });
    // Query invokes historyStore.adoptions() before any new observation exists.
    const result = await history.query('local', row);
    assert.ok(result.windows.length);
    assert.ok(result.windows.every(w => w.points.length === 0), 'no adoption of the previous account history');
    assert.deepEqual(errors, []);
    assert.equal(row.accountKey, fixture.key('b'));
    assert.ok(!(row.accountKeyAliases || []).includes(old.accountKey));
    assert.ok(!(row.accountKeyAliases || []).includes('older'));
    const provisional = hashKey(id, 'account-slot', 'slot:one');
    const first = await LIMIT_PROVIDER_FETCHERS[id]({ [`${id}AccountSlots`]: [{ ...slot, accountKey: provisional, serverIdentity: false }] }, { env: {}, fetch });
    assert.ok(first.find(r => !r.removed).accountKeyAliases.includes(provisional));
    if (id !== 'notion') {
      const fallback = id === 'opendesign' ? hashKey(id, values.opendesignCookie) : hashKey(id, 'a');
      assert.equal(entry.limits[entry.serverAccountKey](fallback, values), false);
      if (id === 'commandcode') {
        const fallbackRows = await LIMIT_PROVIDER_FETCHERS[id]({ [`${id}AccountSlots`]: [slot] }, { env: {},
          fetch: async url => ({ ok: true, status: 200, json: async () => url.endsWith('/credits') ? fixture.body('a', url) : {} }) });
        const fallbackRow = fallbackRows.find(r => !r.removed);
        assert.equal(fallbackRow.accountKey, fallback);
        assert.ok(fallbackRow.accountKeyAliases.includes(old.accountKey));
      }
    }
  });
  test(`${id}: replacement rejects another verified account`, async () => {
    const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
    let settings = {};
    const service = createAccountSlotService({ getSettings: () => settings, env: {},
      write: async patch => { settings = { ...settings, ...patch }; }, probeDeps: () => ({ fetch: transport(id) }) });
    assert.equal((await service.add(id, fixtures[id].values('a'))).saved, true);
    const slot = settings[`${id}AccountSlots`][0];
    assert.equal((await service.replace(id, slot.id, fixtures[id].values('b'))).verdict, 'differentAccount');
    assert.deepEqual(settings[`${id}AccountSlots`][0], slot);
    // A migrated, never-verified provisional key is not a different server account.
    settings = { [`${id}AccountSlots`]: [{ ...slot, accountKey: hashKey(id, 'account-slot', 'default'), serverIdentity: false }] };
    await service.resolved(id, slot.id, { accountKey: hashKey(id, 'account-slot', 'default'), accountKeyAliases: [] }, slot.values);
    assert.equal(settings[`${id}AccountSlots`][0].serverIdentity, false);
    assert.equal((await service.replace(id, slot.id, fixtures[id].values('a'))).saved, true);
  });
}

for (const id of ['notion', 'zaiteam']) {
  test(`${id}: migration preserves environment companions and successful slot fetch without persisting environment secrets`, async t => {
    const fixture = fixtures[id], values = fixture.values('a');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-env-companions-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new CredentialStore(dir), entry = limitProviderEntry(id);
    const primary = entry.status.credential;
    store.replaceSettingsCredentials({ [primary]: values[primary] });
    const env = id === 'notion' ? { TOKEN_MONITOR_NOTION_WORKSPACE_ID: values.notionWorkspaceId, TOKEN_MONITOR_NOTION_COOKIE: 'env-secret' }
      : { ZAI_TEAM_ORGANIZATION_ID: values.zaiTeamOrganizationId, ZAI_TEAM_PROJECT_ID: values.zaiTeamProjectId, ZAI_TEAM_API_KEY: 'env-secret' };
    const before = await entry.fetchLimits({ [primary]: values[primary] }, { env, fetch: transport(id) });
    assert.equal(before.status, 'ok');
    const migrated = migrateAccountSlots(store, {}, Date.now, env);
    const slot = migrated[`${id}AccountSlots`][0];
    assert.deepEqual(slot.values, values);
    const rows = await LIMIT_PROVIDER_FETCHERS[id](migrated, { env: {}, fetch: transport(id) });
    assert.equal(rows.find(r => !r.removed).status, 'ok');
    assert.ok(!JSON.stringify(store.readDocument()).includes('env-secret'));
    // A wholly environment-backed account stays ephemeral.
    const empty = new CredentialStore(path.join(dir, 'empty'));
    const migratedEmpty = migrateAccountSlots(empty, {}, Date.now, env);
    assert.ok(!migratedEmpty[`${id}AccountSlots`]?.length);
    assert.ok(!JSON.stringify(empty.readDocument()).includes('env-secret'));
    // Explicit companion settings precede environment values.
    const override = new CredentialStore(path.join(dir, 'override'));
    override.replaceSettingsCredentials(values);
    const conflictingEnv = Object.fromEntries(Object.keys(env).map(key => [key, 'conflicting-env']));
    const preferred = migrateAccountSlots(override, values, Date.now, conflictingEnv)[`${id}AccountSlots`][0];
    assert.deepEqual(preferred.values, values);
  });
}
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { accountStatusProjection } = require('../../src/electron/limits/accountSettings');
const { configuredMultiAccountProviders } = require('../../src/shared/limits/accountSlots');
const { legacyTraeBody } = require('../fixtures/accountSlotsBatch');
for (const id of ['devin', 'trae']) test(`${id}: environment lane remains first and read-only alongside a slot`, async () => {
  const fixture = fixtures[id];
  const settings = { [`${id}AccountSlots`]: [{ id: 'b', values: fixture.values('b'), enabled: true }] };
  const env = id === 'devin' ? { DEVIN_BEARER_TOKEN: 'token-a', DEVIN_ORG: 'a' } : { TRAE_ACCESS_TOKEN: 'token-a', TRAE_DEVICE_ID: 'device-a' };
  const seen = [];
  const fetch = id === 'devin' ? transport(id, seen) : async (url, init) => {
    if (url.endsWith('/ide_user_ent_usage')) {
      assert.equal(init.headers.Authorization, 'Cloud-IDE-JWT token-a');
      assert.equal(init.headers['X-Device-Id'], 'device-a');
      seen.push({ n: 'a' });
      return { ok: true, status: 200, json: async () => legacyTraeBody };
    }
    return transport(id, seen)(url, init);
  };
  const service = createAccountSlotService({ getSettings: () => settings, write: async () => {}, env });
  const listed = service.list(id).accounts;
  assert.deepEqual(listed.map(a => a.id), ['environment', 'b']);
  assert.equal(listed[0].source, 'environment');
  assert.equal((await service.remove(id, 'environment')).errorCode, 'environmentCredential');
  assert.ok(!JSON.stringify(listed).includes('token-a'));
  assert.deepEqual(configuredMultiAccountProviders([limitProviderEntry(id)], settings, env), [id]);
  const rows = await LIMIT_PROVIDER_FETCHERS[id](settings, { env, fetch });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.status === 'ok'));
  assert.equal(rows[0].accountKey, id === 'devin' ? fixture.key('a') : hashKey('trae', 'token-a'));
  assert.equal(rows[1].accountKey, fixture.key('b'));
  assert.ok(seen.some(c => c.n === 'a') && seen.some(c => c.n === 'b'));
  assert.equal(accountStatusProjection(settings, {})[limitProviderEntry(id).status.configuredKey], true);
});
test('Trae legacy-token slots retain device isolation and scoped refresh', async () => {
  const values = n => ({ traeCookie: '', traeAccessToken: `token-${n}`, traeDeviceId: `device-${n}` });
  const key = n => hashKey('trae', `token-${n}`);
  const slots = ['a', 'b'].map(n => ({ id: n, values: values(n), accountKey: key(n) }));
  const seen = [];
  const deps = { env: { TRAE_COOKIE: 'foreign-cookie' }, fetch: async (url, init) => {
    const n = init.headers.Authorization.slice(-1);
    assert.ok(url.endsWith('/ide_user_ent_usage'));
    assert.equal(init.headers.Cookie, undefined);
    assert.equal(init.headers['X-Device-Id'], `device-${n}`);
    seen.push(n);
    return { ok: true, status: 200, json: async () => legacyTraeBody };
  } };
  // No environment credential for this dispatch; its foreign companion must
  // never fill a slot's own device id.
  deps.env = { TRAE_DEVICE_ID: 'foreign-device' };
  const rows = await LIMIT_PROVIDER_FETCHERS.trae({ traeAccountSlots: slots }, deps);
  assert.deepEqual(rows.map(r => [r.accountKey, r.status]), ['a', 'b'].map(n => [key(n), 'ok']));
  seen.length = 0;
  const scoped = await LIMIT_PROVIDER_FETCHERS.trae({ traeAccountSlots: slots, previousLimits: { providers: rows }, limitRefreshScope: { provider: 'trae', accountKey: key('b') } }, deps);
  assert.deepEqual(scoped.map(r => r.accountKey), [key('b')]);
  assert.deepEqual(seen, ['b']);
});

test('Devin migration captures its env organization without persisting an env token', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slots-devin-env-'));
  const previous = process.env.DEVIN_ORGANIZATION;
  process.env.DEVIN_ORGANIZATION = 'a';
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.DEVIN_ORGANIZATION; else process.env.DEVIN_ORGANIZATION = previous; });
  const store = new CredentialStore(dir);
  store.replaceSettingsCredentials({ devinBearerToken: 'token-a' });
  const migrated = migrateAccountSlots(store, {});
  assert.deepEqual(migrated.devinAccountSlots[0].values, fixtures.devin.values('a'));
  const rows = await LIMIT_PROVIDER_FETCHERS.devin(migrated, { env: {}, fetch: transport('devin') });
  assert.equal(rows[0].accountKey, fixtures.devin.key('a'));
});
test('Trae legacy migration preserves its key, token and device companion', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slots-trae-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const values = { traeCookie: '', traeAccessToken: 'token-a', traeDeviceId: 'device-a' };
  const accountKey = hashKey('trae', 'token-a');
  const store = new CredentialStore(dir);
  store.replaceSettingsCredentials({ ...values, traeDefaultAccountIdentity: { fingerprint: accountValuesFingerprint(values), accountKey } });
  const migrated = migrateAccountSlots(store, {});
  assert.deepEqual(migrated.traeAccountSlots[0].values, values);
  assert.equal(migrated.traeAccountSlots[0].accountKey, accountKey);
  const rows = await LIMIT_PROVIDER_FETCHERS.trae(migrated, { env: {}, fetch: async (_url, init) => {
    assert.equal(init.headers.Authorization, 'Cloud-IDE-JWT token-a');
    assert.equal(init.headers['X-Device-Id'], 'device-a');
    return { ok: true, status: 200, json: async () => legacyTraeBody };
  } });
  assert.equal(rows[0].accountKey, accountKey);
  assert.equal(rows[0].status, 'ok');
});
