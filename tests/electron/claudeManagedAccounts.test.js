'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createClaudeManagedAccounts } = require('../../src/electron/providers/claude/managedAccounts');
const { CredentialStore, persistSettingsAndCredentials } = require('../../src/shared/credentialStore');
const { accountFieldProjection, normalizeAccountPatch } = require('../../src/electron/limits/accountSettings');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');

function response(status, body, cookies = []) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => '', getSetCookie: () => cookies }, json: async () => body };
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-managed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  let settings = { claudeManagedAccounts: [], limitProviders: 'claude', limitsEnabled: true };
  const changes = [];
  const requests = [];
  let beforeFetch;
  let failSettings = false;
  const fetch = async (url, init) => {
    const id = (init.headers.cookie || '').replace('sessionKey=sk-ant-', '').replace('-renewed', '');
    requests.push({ id, url });
    const override = await beforeFetch?.(url, init);
    if (override) return override;
    if (url.endsWith('/api/organizations')) return response(200, [{ uuid: `org-${id}`, name: `Workspace ${id}` }]);
    if (url.endsWith('/api/account')) return response(200, { uuid: `account-${id}`, email_address: `${id}@example.com` });
    if (url.endsWith('/prepaid/credits')) return response(200, { amount: 0, currency: 'USD' });
    return response(200, { five_hour: { utilization: 20 } });
  };
  const deps = { env: {}, readMacKeychain: false, readWindowsCredential: false,
    stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    isClaudeCliAuthenticated: async () => false, fetch, autoStart: false, autoRetry: false };
  const saveSettings = () => {
    if (failSettings) { failSettings = false; throw new Error('simulated settings failure'); }
    return persistSettingsAndCredentials({ store, settingsPath: path.join(dir, 'settings.json'), settings });
  };
  const api = createClaudeManagedAccounts({
    getSettings: () => settings, setSettings: (next) => { settings = next; }, saveSettings,
    credentialStore: store,
    projectSettings: () => accountFieldProjection(settings, {}),
    probeDeps: (renewed) => ({ ...deps, providerRuntimeState: new Map(),
      onClaudeWebCookieRenewed: ({ cookie }) => { renewed.claudeWebCookie = cookie; return true; } }),
    onChanged: (account, reason, flags) => changes.push({ account, reason, flags })
  });
  return { api, store, dir, changes, requests, deps,
    settings: () => settings, setSettings: (value) => { settings = value; },
    beforeFetch: (fn) => { beforeFetch = fn; }, failSettings: () => { failSettings = true; },
    save: (id, accountId = 'new', extra = {}) => api.saveAccount({ claudeWebCookie: `sk-ant-${id}`, claudeWebAccountId: accountId, ...extra }) };
}

test('managed accounts store metadata separately, reject generic writes and use account-scoped notifications', async (t) => {
  const f = fixture(t);
  assert.equal((await f.save('a')).saved, true);
  assert.equal((await f.save('b')).saved, true);
  const [a, b] = f.api.accounts();
  assert.equal(JSON.stringify(f.api.accounts()).includes('sk-ant-'), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'settings.json'), 'utf8').includes('sk-ant-'), false);
  assert.equal(f.store.readClaudeWebCredential(a.id), 'sessionKey=sk-ant-a');
  assert.equal(f.store.readClaudeWebCredential(b.id), 'sessionKey=sk-ant-b');
  const patch = { claudeManagedAccounts: [{ id: 'forged', accountKey: 'forged', cookie: 'secret' }], claudeWebAccounts: [{ cookie: 'forged' }] };
  const normalized = { ...patch };
  normalizeAccountPatch(patch, normalized);
  assert.deepEqual(normalized, {});
  assert.equal((await f.save('a')).saved, true);
  assert.deepEqual(f.api.accounts().map((account) => account.id), [a.id, b.id]);
  assert.equal(f.changes.every(({ account }) => account.id && account.accountKey), true);
  assert.equal((await f.api.setAccountEnabled(a.id, false)).ok, true);
  assert.equal(f.api.accounts()[0].enabled, false);
  assert.equal(f.store.readClaudeWebCredential(a.id), 'sessionKey=sk-ant-a');
  assert.deepEqual(f.changes.at(-1).flags, { clear: true, refresh: false });
  assert.equal((await f.api.removeAccount(a.id)).ok, true);
  assert.equal(f.store.readClaudeWebCredential(a.id), '');
  assert.deepEqual(f.api.accounts().map((account) => account.id), [b.id]);
  assert.deepEqual(f.changes.at(-1).flags, { clear: true, refresh: false });
});

test('a failed metadata save restores both the credential and the account list', async (t) => {
  const f = fixture(t);
  await f.save('a');
  const before = f.api.accounts();
  const a = before[0];
  f.failSettings();
  assert.equal((await f.save('b', a.id)).saved, false);
  assert.deepEqual(f.api.accounts(), before);
  assert.equal(f.store.readClaudeWebCredential(a.id), 'sessionKey=sk-ant-a');
  f.failSettings();
  assert.equal((await f.api.removeAccount(a.id)).ok, false);
  assert.deepEqual(f.api.accounts(), before);
  assert.equal(f.store.readClaudeWebCredential(a.id), 'sessionKey=sk-ant-a');
});

test('an in-flight save cannot restore an account removed through its dedicated operation', async (t) => {
  const f = fixture(t);
  await f.save('a');
  const a = f.api.accounts()[0];
  let release;
  f.beforeFetch((url) => url.includes('/usage?') ? new Promise((resolve) => { release = () => resolve(); }) : null);
  const saving = f.save('a', a.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  await f.api.removeAccount(a.id);
  release();
  assert.equal((await saving).verdict, 'superseded');
  assert.deepEqual(f.api.accounts(), []);
  assert.equal(f.store.readClaudeWebCredential(a.id), '');
});

test('session rotation compares the current credential and cannot resurrect a removed account', async (t) => {
  const f = fixture(t);
  await f.save('a');
  const a = f.api.accounts()[0];
  assert.equal(await f.api.renew({ accountId: a.id, previousCookie: 'sk-ant-a', cookie: 'sk-ant-a-renewed' }), true);
  assert.equal(f.api.resolveCredential(a), 'sessionKey=sk-ant-a-renewed');
  assert.equal(await f.api.renew({ accountId: a.id, previousCookie: 'sk-ant-a', cookie: 'sk-ant-stale' }), false);
  await f.api.removeAccount(a.id);
  assert.equal(await f.api.renew({ accountId: a.id, previousCookie: 'sk-ant-a-renewed', cookie: 'sk-ant-late' }), false);
  assert.equal(f.store.readClaudeWebCredential(a.id), '');
});

test('migration verifies the new credential and strips the previous format only on success', async (t) => {
  const f = fixture(t);
  const original = { claudeManagedAccounts: [], claudeWebAccounts: [{ id: 'legacy-a', cookie: 'sessionKey=sk-ant-a', organizationId: 'org-a', accountKey: 'key-a' }] };
  f.setSettings(original);
  f.failSettings();
  assert.throws(() => f.api.migrateLegacyAccounts(), /credentialStorageUnavailable/);
  assert.equal(f.settings().claudeWebAccounts[0].cookie, 'sessionKey=sk-ant-a');
  assert.equal(f.store.readClaudeWebCredential('legacy-a'), '');
  f.api.migrateLegacyAccounts();
  assert.equal(f.store.readClaudeWebCredential('legacy-a'), 'sessionKey=sk-ant-a');
  assert.equal(f.settings().claudeWebAccounts.length, 0);
  assert.equal(f.api.accounts()[0].accountKey, 'key-a');
  assert.equal(fs.readFileSync(path.join(f.dir, 'settings.json'), 'utf8').includes('sk-ant-'), false);
  f.api.migrateLegacyAccounts();
  assert.equal(f.api.accounts().length, 1);
});

test('collection resolves only the selected managed credential and publishes no secret', async (t) => {
  const f = fixture(t);
  await f.save('a');
  await f.save('b');
  const [a] = f.api.accounts();
  const runtime = createLimitsRuntime({ limitProviders: ['claude'], claudeManagedAccounts: f.api.accounts() }, {
    ...f.deps, resolveConfigSnapshot: () => ({ claudeManagedAccounts: f.api.accounts() }),
    resolveClaudeWebCredential: f.api.resolveCredential,
    onClaudeWebCookieRenewed: f.api.renew,
    onClaudeWebAccountResolved: f.api.resolved
  });
  t.after(() => runtime.stop());
  f.requests.length = 0;
  await runtime.refresh({ provider: 'claude', accountId: a.id, accountKey: a.accountKey }, 'account-added');
  assert.equal(f.requests.every((request) => request.id === 'a'), true);
  assert.equal(runtime.getSnapshot().providers[0].accountEmail, 'a@example.com');
  assert.equal(JSON.stringify(runtime.getSnapshot()).includes('sk-ant-'), false);
  await f.api.setAccountEnabled(a.id, false);
  f.requests.length = 0;
  await runtime.refresh('claude', 'account-state');
  assert.equal(f.requests.length > 0, true);
  assert.equal(f.requests.every((request) => request.id === 'b'), true);
});

test('an identity learned by an id-scoped refresh retires the temporary scope and refreshes the stable identity', async (t) => {
  const f = fixture(t);
  await f.save('a');
  const [a] = f.api.accounts();
  f.setSettings({ ...f.settings(), claudeManagedAccounts: [{ ...a, accountKey: '', accountEmail: '' }] });
  f.changes.length = 0;
  const runtime = createLimitsRuntime({ limitProviders: ['claude'], claudeManagedAccounts: f.api.accounts() }, {
    ...f.deps, resolveConfigSnapshot: () => ({ claudeManagedAccounts: f.api.accounts() }),
    resolveClaudeWebCredential: f.api.resolveCredential, onClaudeWebAccountResolved: f.api.resolved
  });
  t.after(() => runtime.stop());
  await runtime.refresh({ provider: 'claude', accountId: a.id }, 'account-panel');
  assert.equal(f.api.accounts()[0].accountKey, a.accountKey);
  assert.deepEqual(f.changes.map(({ account, reason, flags }) => ({ key: account.accountKey, reason, flags })), [
    { key: '', reason: 'identity-switch', flags: { clear: true, refresh: false } },
    { key: a.accountKey, reason: 'identity-resolved', flags: { refresh: true } }
  ]);
});
