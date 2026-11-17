'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { hashKey } = require('../../src/shared/hashKey');
const { migrateAccountSlots } = require('../../src/electron/limits/accountSlotMigration');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { LIMIT_PROVIDER_FETCHERS } = require('../../src/shared/limits/registry');
const key = n => hashKey('openrouter', `secret-${n}`);
function fixture(t, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrouter-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  store.replaceSettingsCredentials(settings);
  return store;
}
const profiles = { Work: { apiKey: 'secret-a', enabled: true }, Personal: { apiKey: 'secret-b', enabled: false }, Copy: { apiKey: 'secret-a' } };
function transport(seen = [], status = 200) {
  return async (url, init) => {
    assert.equal(init.headers.Cookie, undefined);
    assert.equal(init.headers.Host, undefined);
    const n = init.headers.Authorization;
    assert.match(n, /^Bearer secret-[ab]$/);
    seen.push([url, n]);
    return { ok: status === 200, status, json: async () => ({ data: url.endsWith('/credits') ? { total_credits: n.endsWith('a') ? 20 : 40, total_usage: 2 } : { usage: 2 } }) };
  };
}
test('OpenRouter imports profiles in order with exact identity, labels and pause state, plus fixed key', t => {
  const store = fixture(t, { openrouterProfiles: profiles, openrouterApiKey: 'secret-b' });
  const settings = migrateAccountSlots(store, {});
  const slots = settings.openrouterAccountSlots;
  assert.deepEqual(slots.map(s => [s.label, s.enabled, s.accountKey]), [['', true, key('b')], ['Work', true, key('a')], ['Personal', false, key('b')], ['Copy', true, key('a')]]);
  assert.deepEqual(slots.map(s => s.values.openrouterApiKey), ['secret-b', 'secret-a', 'secret-b', 'secret-a']);
  assert.equal(settings.openrouterApiKey, undefined);
  assert.equal(settings.openrouterProfiles, undefined);
  assert.equal(store.readDocument().migrations.accountSlots.openrouter, 1);
  assert.deepEqual(migrateAccountSlots(store, {}), settings);
});
test('OpenRouter verifies before stripping and retry keeps stable import IDs', t => {
  const store = fixture(t, { openrouterProfiles: profiles });
  const read = store.readDocument.bind(store);
  store.readDocument = () => { const doc = read(); if (doc.credentials.providers?.openrouter?.accountSlots?.length) throw new Error('crash'); return doc; };
  assert.throws(() => migrateAccountSlots(store, {}), /crash/);
  store.readDocument = read;
  const before = store.settingsCredentials();
  assert.deepEqual(before.openrouterProfiles, profiles);
  const after = migrateAccountSlots(store, {});
  assert.deepEqual(after.openrouterAccountSlots, before.openrouterAccountSlots);
  assert.deepEqual(migrateAccountSlots(store, {}), after);
});
test('OpenRouter real transport isolates accounts, scopes by key and dedupes the winning environment key', async () => {
  const slots = ['a', 'b'].map(n => ({ id: n, label: n, values: { openrouterApiKey: `secret-${n}` }, accountKey: key(n) }));
  const seen = [];
  const settings = { openrouterAccountSlots: slots };
  const deps = { env: {}, fetch: transport(seen) };
  const rows = await LIMIT_PROVIDER_FETCHERS.openrouter(settings, deps);
  assert.deepEqual(rows.map(r => [r.accountKey, r.balance.amount]), [[key('a'), 18], [key('b'), 38]]);
  assert.equal(seen.length, 4);
  seen.length = 0;
  const scoped = await LIMIT_PROVIDER_FETCHERS.openrouter({ ...settings, previousLimits: { providers: rows }, limitRefreshScope: { provider: 'openrouter', accountKey: key('b') } }, deps);
  assert.deepEqual(scoped.map(r => r.accountKey), [key('b')]);
  assert.deepEqual(seen.map(call => call[1]), ['Bearer secret-b', 'Bearer secret-b']);
  seen.length = 0;
  const deduped = await LIMIT_PROVIDER_FETCHERS.openrouter(settings, { ...deps, env: { TOKEN_MONITOR_OPENROUTER_API_KEY: 'secret-a', OPENROUTER_API_KEY: 'ignored' } });
  assert.equal(deduped.length, 2);
  assert.equal(seen.length, 4);
});
for (const [status, saved, verdict] of [[200, true, 'valid'], [401, false, 'invalid'], [503, true, 'indeterminate']]) test(`OpenRouter shared probe policy: HTTP ${status}`, async () => {
  let settings = {};
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: patch => { settings = { ...settings, ...patch }; }, probeDeps: () => ({ fetch: transport([], status) }) });
  const result = await service.add('openrouter', { openrouterApiKey: 'secret-a' }, 'Work');
  assert.equal(result.saved, saved);
  assert.equal(result.verdict, verdict);
  const serialized = JSON.stringify([result, service.list('openrouter')]);
  assert.ok(!serialized.includes('secret-a'));
  if (saved) assert.deepEqual(service.list('openrouter').accounts[0].formValues, {});
});
test('legacy OpenRouter methods forward mutations and redact profiles', async () => {
  let settings = {};
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: patch => { settings = { ...settings, ...patch }; }, probeDeps: () => ({ fetch: transport() }) });
  const { createOpenRouterProfileCommands } = require('../../src/electron/limits/openrouterProfileCommands');
  const api = createOpenRouterProfileCommands(service, {});
  assert.equal((await api.saveProfile('Work', 'secret-a')).ok, true);
  assert.equal((await api.saveProfile('Other', 'secret-b')).ok, true);
  assert.equal((await api.renameProfile('Work', 'Other')).ok, false);
  assert.equal((await api.renameProfile('Work', 'Renamed')).ok, true);
  assert.equal((await api.setProfileEnabled('Renamed', false)).ok, true);
  assert.deepEqual(api.getProfiles().profiles.Renamed, { apiKey: 'set', enabled: false });
  assert.equal((await api.deleteProfile('Renamed')).ok, true);
  assert.equal(settings.openrouterAccountSlots.length, 1);
  assert.equal(settings.openrouterProfiles, undefined);
});

test('OpenRouter migrated readings retain history and subscription bindings after rename and scoped refresh', async t => {
  const { createLimitsHistoryStore } = require('../../src/electron/limits/historyStore');
  const { bindingFromAccount, matchProviderAccount } = require('../../src/shared/subscriptionDisplay');
  const { fetchOpenRouterAccount } = require('../../src/shared/providers/openrouter/limits');
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const now = new Date(2026, 10, 17, 12).getTime();
  const old = await fetchOpenRouterAccount('Work', 'secret-a', { env: {}, fetch: transport(), now: () => now - 300000 });
  const subscription = { provider: 'openrouter', binding: bindingFromAccount(old) };
  const store = fixture(t, { openrouterProfiles: { Work: profiles.Work, Personal: { ...profiles.Personal, enabled: true } } });
  let settings = migrateAccountSlots(store, {});
  const dir = path.dirname(store.filePath);
  const history = createLimitsHistoryStore(path.join(dir, 'history.sqlite'), { now: () => now });
  t.after(() => history.close());
  await history.record('local', { providers: [old] });
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: patch => { settings = { ...settings, ...patch }; } });
  await service.rename('openrouter', settings.openrouterAccountSlots[0].id, 'Renamed');
  const seen = [];
  const runtime = createLimitsRuntime({ ...settings, limitsEnabled: true, limitProviders: 'openrouter' }, { env: {}, fetch: transport(seen), now: () => now, autoStart: false, autoRetry: false });
  t.after(() => runtime.stop());
  await runtime.refresh({}, 'settings-change');
  const before = runtime.getSnapshot().providers;
  const current = before.find(row => row.accountKey === old.accountKey);
  assert.equal(current.accountName, 'Renamed');
  assert.equal(matchProviderAccount(subscription, before), current);
  const retained = await history.query('local', current);
  assert.ok(retained.windows.some(window => window.points.length > 0));
  seen.length = 0;
  await runtime.refresh({ provider: 'openrouter', accountKey: key('b') }, 'manual');
  assert.deepEqual(seen.map(call => call[1]), ['Bearer secret-b', 'Bearer secret-b']);
  assert.deepEqual(runtime.getSnapshot().providers.find(row => row.accountKey === key('a')), current);
});

test('a legacy profile without a usable key is skipped instead of blocking the migration', t => {
  const store = fixture(t, { openrouterProfiles: { Empty: { apiKey: '' }, Work: { apiKey: 'secret-a', enabled: true } } });
  const settings = migrateAccountSlots(store, {});
  assert.deepEqual(settings.openrouterAccountSlots.map(s => [s.label, s.accountKey]), [['Work', key('a')]]);
  assert.equal(store.readDocument().migrations.accountSlots.openrouter, 1);
});
