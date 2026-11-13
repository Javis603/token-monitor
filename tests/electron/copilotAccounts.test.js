'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCopilotAccounts } = require('../../src/electron/providers/copilot/accounts');
const { fetchCopilotLimits, copilotProfiles } = require('../../src/shared/providers/copilot/limits');
const { hashKey } = require('../../src/shared/hashKey');

const usage = { copilot_plan: 'pro', quota_snapshots: {
  premium_interactions: { entitlement: 100, remaining: 75, percent_remaining: 75 }
} };
function fixture(initial = {}, env = {}) {
  const settings = structuredClone(initial);
  const requests = [];
  let failSave = false;
  const fetch = async (url, init) => {
    const token = init.headers.Authorization.slice(6);
    requests.push({ url, token });
    if (token === 'bad-token') return { ok: false, status: 401 };
    return { ok: true, json: async () => url.endsWith('/user') && !url.includes('copilot_internal')
      ? { login: token.startsWith('personal') ? 'alice' : 'bob', id: token.startsWith('personal') ? 1 : 2 } : usage };
  };
  const api = createCopilotAccounts({ getSettings: () => settings, env, changed: () => {},
    saveSettings: () => { if (failSave) throw new Error('disk full'); }, probeDeps: () => ({ fetch, env }) });
  return { api, settings, fetch, requests, failSave: () => { failSave = true; } };
}

test('Copilot adds multiple accounts without replacing legacy tokens, and updates duplicate identities', async () => {
  const f = fixture({ copilotApiToken: 'personal-token' });
  await f.api.addAccount('work-token');
  assert.equal(f.settings.copilotApiToken, 'personal-token');
  assert.equal(f.api.getAccounts().length, 2);
  assert.deepEqual(f.api.getAccounts().map(a => a.accountName).sort(), ['alice', 'bob']);
  await f.api.addAccount('personal-new-token');
  assert.equal(f.api.getAccounts().length, 2);
  assert.equal(f.settings.copilotApiToken, 'personal-new-token');
  assert.equal(Object.values(copilotProfiles(f.settings)).some(p => p.token === 'personal-token'), false);
  assert.equal(JSON.stringify(f.api.getAccounts()).includes('-token'), false);
});

test('Copilot scopes refreshes, isolates failed tokens, and retains failed account identity', async () => {
  const f = fixture();
  await f.api.addAccount('personal-token');
  await f.api.addAccount('work-token');
  const work = f.api.getAccounts().find(a => a.accountName === 'bob');
  f.settings.copilotProfiles[work.id].token = 'bad-token';
  f.requests.length = 0;
  const rows = await fetchCopilotLimits(f.settings, { fetch: f.fetch, env: {} });
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.accountName === 'alice').status, 'ok');
  assert.equal(rows.find(r => r.accountKey === work.accountKey).status, 'unauthorized');
  assert.equal(rows.find(r => r.accountKey === work.accountKey).accountName, 'bob');
  f.requests.length = 0;
  const scoped = await fetchCopilotLimits({ ...f.settings,
    limitRefreshScope: { provider: 'copilot', accountKey: work.accountKey } }, { fetch: f.fetch, env: {} });
  assert.equal(scoped.length, 1);
  assert.ok(f.requests.every(r => r.token === 'bad-token'));
  f.requests.length = 0;
  assert.deepEqual(await fetchCopilotLimits({ ...f.settings,
    limitRefreshScope: { provider: 'copilot', accountKey: 'removed' } }, { fetch: f.fetch, env: {} }), []);
  assert.equal(f.requests.length, 0);
});

test('Copilot disabling and deleting accounts preserves other accounts and provider selection', async () => {
  const f = fixture({ copilotApiToken: 'personal-token' }, { COPILOT_API_TOKEN: 'env-token' });
  await f.api.addAccount('work-token');
  f.settings.limitsEnabled = false;
  f.settings.limitProviders = '';
  const personal = f.api.getAccounts().find(a => a.accountName === 'alice');
  await f.api.setEnabled(personal.id, false);
  assert.equal(f.api.getAccounts().find(a => a.id === personal.id).enabled, false);
  const rows = await fetchCopilotLimits(f.settings, { fetch: f.fetch, env: {} });
  assert.deepEqual(rows.map(r => r.accountName), ['bob']);
  await f.api.removeAccount(personal.id);
  assert.equal(f.settings.copilotApiToken, '');
  assert.equal(f.api.getAccounts().length, 1);
  assert.equal(f.settings.limitsEnabled, false);
  assert.equal(f.settings.limitProviders, '');
});

test('Copilot cancelled, rejected and failed saves leave credentials unchanged', async () => {
  const f = fixture({ copilotApiToken: 'personal-token' });
  const before = structuredClone(f.settings);
  await assert.rejects(f.api.addAccount('bad-token'));
  await assert.rejects(f.api.addAccount('work-token', () => false), /cancelled/);
  assert.deepEqual(f.settings, before);
  f.failSave();
  await assert.rejects(f.api.addAccount('work-token'), /disk full/);
  assert.equal(f.settings.copilotApiToken, before.copilotApiToken);
  assert.equal(f.api.getAccounts().length, 1);
});

test('Copilot legacy and environment refreshes never return a different scoped account', async () => {
  const f = fixture();
  const row = await fetchCopilotLimits({}, { fetch: f.fetch, env: { COPILOT_API_TOKEN: 'personal-token' } });
  assert.equal(row.accountName, 'alice');
  assert.equal(row.accountKey, hashKey('copilot', 'alice'));
  const other = await fetchCopilotLimits({ copilotApiToken: 'work-token',
    limitRefreshScope: { provider: 'copilot', accountKey: row.accountKey } }, { fetch: f.fetch, env: {} });
  assert.deepEqual(other, []);
});

test('Copilot profiles stay in the credential store, outside settings and renderer projections', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { CredentialStore, persistSettingsAndCredentials, credentialSettingsForRenderer } = require('../../src/shared/credentialStore');
  const { limitsAccountConfig } = require('../../src/electron/limits/accountSettings');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'copilot-accounts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = fixture();
  await f.api.addAccount('personal-token');
  const store = new CredentialStore(directory);
  const settingsPath = path.join(directory, 'settings.json');
  persistSettingsAndCredentials({ store, settingsPath, settings: f.settings, previousSettings: {} });
  assert.equal(fs.readFileSync(settingsPath, 'utf8').includes('personal-token'), false);
  assert.equal(JSON.stringify(credentialSettingsForRenderer(f.settings)).includes('personal-token'), false);
  assert.equal(Object.values(store.settingsCredentials().copilotProfiles)[0].token, 'personal-token');
  assert.equal(Object.values(limitsAccountConfig(f.settings).copilotProfiles)[0].token, 'personal-token');
});

test('Copilot legacy and environment scoped failures retain identity only for the unchanged credential and host', async () => {
  for (const fromEnv of [false, true]) {
    let unauthorized = false;
    const f = fixture();
    const options = fromEnv ? {} : { copilotApiToken: 'personal-token' };
    const deps = { env: fromEnv ? { COPILOT_API_TOKEN: 'personal-token' } : {},
      providerRuntimeState: new Map(),
      fetch: (url, init) => unauthorized ? { ok: false, status: 401 } : f.fetch(url, init) };
    const initial = await fetchCopilotLimits(options, deps);
    assert.equal(initial.status, 'ok');
    unauthorized = true;
    const limitRefreshScope = { provider: 'copilot', accountKey: initial.accountKey };
    const expired = await fetchCopilotLimits({ ...options, limitRefreshScope }, deps);
    assert.equal(expired.status, 'unauthorized');
    assert.equal(expired.accountKey, initial.accountKey);
    assert.equal(expired.accountName, initial.accountName);
    // A different token, even sharing its prefix, cannot inherit that identity.
    assert.deepEqual(await fetchCopilotLimits({ copilotApiToken: 'personal-other-token', limitRefreshScope }, deps), []);
    assert.deepEqual(await fetchCopilotLimits({ ...options, copilotEnterpriseHost: 'other.ghe.com', limitRefreshScope }, deps), []);
  }
});
