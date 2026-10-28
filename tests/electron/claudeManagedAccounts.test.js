'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createClaudeManagedAccounts, claudeAccountChangeScope } = require('../../src/electron/providers/claude/managedAccounts');
const { runLimitInvalidation } = require('../../src/electron/deviceRuntimeCoordinator');
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
  let onChanged;
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
    onChanged: (account, reason, flags) => { changes.push({ account, reason, flags }); return onChanged?.(account, reason, flags); }
  });
  return { api, store, dir, changes, requests, deps,
    settings: () => settings, setSettings: (value) => { settings = value; },
    beforeFetch: (fn) => { beforeFetch = fn; }, failSettings: () => { failSettings = true; },
    onChanged: (fn) => { onChanged = fn; },
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
  const patch = { claudeManagedAccounts: [{ id: 'forged', accountKey: 'forged', cookie: 'secret' }] };
  const normalized = { ...patch };
  normalizeAccountPatch(patch, normalized);
  assert.deepEqual(normalized, {});
  assert.equal((await f.save('a')).saved, true);
  assert.deepEqual(f.api.accounts().map((account) => account.id), [a.id, b.id]);
  assert.equal(f.changes.every(({ account }) => account.id && account.accountKey), true);
  assert.equal((await f.api.setAccountEnabled(a.id, false)).ok, true);
  assert.equal(f.api.accounts()[0].enabled, false);
  assert.equal(f.store.readClaudeWebCredential(a.id), 'sessionKey=sk-ant-a');
  assert.deepEqual(f.changes.at(-1).flags, { clear: false, refresh: true, reconcileSources: true });
  assert.equal((await f.api.removeAccount(a.id)).ok, true);
  assert.equal(f.store.readClaudeWebCredential(a.id), '');
  assert.deepEqual(f.api.accounts().map((account) => account.id), [b.id]);
  assert.deepEqual(f.changes.at(-1).flags, { clear: false, refresh: true, reconcileSources: true });
});

for (const action of ['disable', 'remove']) {
  for (const healthySource of ['web', 'oauth']) {
    test(`${action} of an unidentified account preserves healthy ${healthySource} through reconciliation and removes its temporary row`, async (t) => {
      const f = fixture(t);
      f.beforeFetch((url, init) => init.headers.cookie === 'sessionKey=sk-ant-a' && url.endsWith('/api/account')
        ? response(503, {}) : undefined);
      assert.equal((await f.save('a')).saved, true);
      const [a] = f.api.accounts();
      assert.equal(a.accountKey, '');
      let b;
      if (healthySource === 'web') {
        await f.save('b');
        b = f.api.accounts()[1];
      } else {
        f.deps.env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fixture' };
        f.deps.platform = 'linux';
      }
      let release;
      let reached;
      const paused = new Promise((resolve) => { reached = resolve; });
      let hold = false;
      f.beforeFetch(async (url, init) => {
        if (init.headers.cookie === 'sessionKey=sk-ant-a' && url.endsWith('/api/account')) return response(503, {});
        if (hold && url.includes('/usage')) {
          reached();
          await new Promise((resolve) => { release = resolve; });
        }
        if (!init.headers.cookie && healthySource === 'oauth') return url.endsWith('/api/oauth/profile')
          ? response(200, { account: { uuid: 'account-b', email: 'b@example.com' }, organization: { uuid: 'org-b' } })
          : response(200, { five_hour: { utilization: 35 } });
      });
      const runtime = createLimitsRuntime({ limitProviders: ['claude'] }, {
        ...f.deps, resolveConfigSnapshot: () => f.settings(), resolveClaudeWebCredential: f.api.resolveCredential
      });
      t.after(() => { release?.(); runtime.stop(); });
      await runtime.refresh({ provider: 'claude', accountId: a.id }, 'account-added');
      await runtime.refresh('claude', 'credential-save');
      const healthy = runtime.getSnapshot().providers.find((row) => row.accountEmail === 'b@example.com');
      assert.equal(healthy.status, 'ok');
      if (b) assert.equal(healthy.accountKey, b.accountKey);
      assert.equal(runtime.getSnapshot().providers.some((row) => !row.accountKey), true, 'seeded temporary account row exists');
      const snapshots = [];
      const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));
      t.after(unsubscribe);
      let invalidation;
      f.onChanged((account, reason, flags) => {
        runtime.reconfigure(f.settings());
        invalidation = runLimitInvalidation({ clearLimits: runtime.clear, refreshLimits: runtime.refresh },
          claudeAccountChangeScope(account, flags), reason, flags);
        return invalidation;
      });
      hold = true;
      const result = action === 'remove' ? await f.api.removeAccount(a.id) : await f.api.setAccountEnabled(a.id, false);
      assert.equal(result.ok, true);
      await paused;
      const during = runtime.getSnapshot().providers;
      const visibleDuring = during.some((row) => row.accountKey === healthy.accountKey && row.status === 'ok');
      const temporaryRemoved = during.every((row) => row.accountKey);
      hold = false;
      release();
      await invalidation;
      assert.equal(visibleDuring, true, 'healthy identity must remain visible while collection is paused');
      assert.equal(temporaryRemoved, true, 'only the unidentified account temporary row is cleared');
      assert.equal(snapshots.every((snapshot) => snapshot.providers.some((row) => row.accountKey === healthy.accountKey && row.status === 'ok')), true);
      assert.equal(runtime.getSnapshot().providers.length, 1);
      assert.equal(runtime.getSnapshot().providers[0].accountKey, healthy.accountKey);
      assert.equal(f.store.readClaudeWebCredential(a.id), action === 'remove' ? '' : 'sessionKey=sk-ant-a');
    });
  }
  for (const remaining of ['oauth', 'legacy', 'none']) {
    test(`${action} reconciles the same identity through ${remaining} without polling sibling managed accounts`, async (t) => {
      const f = fixture(t);
      await f.save('a');
      await f.save('b');
      const [a, b] = f.api.accounts();
      if (remaining === 'legacy') f.setSettings({ ...f.settings(), claudeWebCookie: 'sessionKey=sk-ant-a' });
      if (remaining === 'oauth') {
        f.deps.env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fixture' };
        f.deps.platform = 'linux';
      }
      f.beforeFetch((url, init) => {
        if (url.endsWith('/prepaid/credits')) return response(200, { amount: 2500, currency: 'USD' });
        if (remaining !== 'oauth' || init.headers.cookie) return;
        return url.endsWith('/api/oauth/profile')
          ? response(200, { account: { uuid: 'account-a', email: 'a@example.com' }, organization: { uuid: 'org-a' } })
          : response(200, { five_hour: { utilization: 35 } });
      });
      const runtime = createLimitsRuntime({ limitProviders: ['claude'] }, {
        ...f.deps, resolveConfigSnapshot: () => f.settings(), resolveClaudeWebCredential: f.api.resolveCredential
      });
      t.after(() => runtime.stop());
      await runtime.refresh('claude', 'credential-save');
      assert.equal(runtime.getSnapshot().providers.filter((row) => row.accountKey === a.accountKey).length, 1);
      assert.equal(runtime.getSnapshot().providers.find((row) => row.accountKey === a.accountKey).balance.amount, 25);
      let invalidation;
      let visibleDuringReconcile;
      f.onChanged((account, reason, flags) => {
        runtime.reconfigure(f.settings());
        invalidation = runLimitInvalidation({ clearLimits: runtime.clear, refreshLimits: runtime.refresh },
          claudeAccountChangeScope(account, flags), reason, flags);
        visibleDuringReconcile = runtime.getSnapshot().providers.some((row) => row.accountKey === a.accountKey);
        return invalidation;
      });
      f.requests.length = 0;
      const result = action === 'remove' ? await f.api.removeAccount(a.id) : await f.api.setAccountEnabled(a.id, false);
      assert.equal(result.ok, true);
      assert.equal(visibleDuringReconcile, true, 'keep the merged reading visible while its remaining sources are checked');
      await invalidation;
      const rows = runtime.getSnapshot().providers;
      assert.equal(rows.some((row) => row.accountKey === a.accountKey && row.status === 'ok'), remaining !== 'none');
      assert.equal(rows.some((row) => row.accountKey === b.accountKey && row.status === 'ok'), true);
      assert.equal(f.requests.some((request) => request.id === 'b'), false);
      if (remaining === 'none') assert.equal(rows.some((row) => row.accountKey === a.accountKey), false);
      if (remaining === 'oauth') assert.equal(rows.find((row) => row.accountKey === a.accountKey).balance, null);
      if (remaining === 'legacy') assert.equal(rows.find((row) => row.accountKey === a.accountKey).balance.amount, 25);
    });
  }
}

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

test('Web login health stays independent of healthy OAuth for the same subscription', async (t) => {
  const f = fixture(t);
  await f.save('a');
  const [account] = f.api.accounts();
  let webStatus = 401;
  f.deps.env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fixture' };
  f.deps.platform = 'linux';
  f.beforeFetch((url, init) => {
    if (init.headers.cookie && webStatus !== 200) return response(webStatus, {});
    if (url.endsWith('/api/oauth/profile')) return response(200, {
      account: { uuid: 'account-a', email: 'a@example.com' }, organization: { uuid: 'org-a' }
    });
  });
  const runtime = createLimitsRuntime({ limitProviders: ['claude'], claudeManagedAccounts: f.api.accounts() }, {
    ...f.deps, onClaudeWebAccountResolved: f.api.resolved, resolveClaudeWebCredential: f.api.resolveCredential
  });
  t.after(() => runtime.stop());
  await runtime.refresh('claude', 'credential-save');
  assert.equal(runtime.getSnapshot().providers.length, 1);
  assert.equal(runtime.getSnapshot().providers[0].status, 'ok');
  assert.equal(f.api.loginStatuses()[account.id], 'unauthorized');
  webStatus = 200;
  await runtime.refresh('claude', 'credential-save');
  assert.equal(f.api.loginStatuses()[account.id], 'ok');
  assert.equal(fs.readFileSync(path.join(f.dir, 'settings.json'), 'utf8').includes('loginStatus'), false);
  await f.api.setAccountEnabled(account.id, false);
  assert.equal(f.api.loginStatuses()[account.id], undefined);
  await f.api.removeAccount(account.id);
  await f.api.resolved({ id: account.id, cookie: 'sessionKey=sk-ant-a', organizationId: 'org-a', provider: { status: 'unauthorized' } });
  assert.equal(f.api.loginStatuses()[account.id], undefined);
});

test('login-status projection skips unobserved accounts and isolates credential read or format failures', async (t) => {
  const f = fixture(t);
  await f.save('a');
  await f.save('b');
  const [a, b] = f.api.accounts();
  const read = f.store.readClaudeWebCredential.bind(f.store);
  f.store.readClaudeWebCredential = () => { throw new Error('credential read failed'); };
  assert.deepEqual(f.api.loginStatuses(), {}, 'unobserved logins need no credential read');
  f.store.readClaudeWebCredential = read;
  for (const account of [a, b]) await f.api.resolved({ id: account.id,
    cookie: read(account.id), organizationId: account.organizationId, provider: { status: 'ok' } });
  for (const failure of ['read', 'format']) {
    f.store.readClaudeWebCredential = id => {
      if (id !== a.id) return read(id);
      if (failure === 'read') throw new Error('credential read failed');
      return 'not-a-session-key';
    };
    assert.deepEqual(f.api.loginStatuses(), { [b.id]: 'ok' });
  }
  f.store.readClaudeWebCredential = read;
  f.setSettings({ ...f.settings(), claudeWebCookie: 'sessionKey=sk-ant-a', claudeWebOrganizationId: a.organizationId });
  await f.api.resolved({ id: 'legacy', cookie: read(a.id), organizationId: a.organizationId, provider: { status: 'ok' } });
  f.setSettings({ ...f.settings(), claudeWebCookie: 'not-a-session-key' });
  assert.deepEqual(f.api.loginStatuses(), { [a.id]: 'ok', [b.id]: 'ok' });
});

test('a delayed organization A observation cannot overwrite organization B saved with the same cookie', async (t) => {
  const f = fixture(t);
  let release;
  let reached;
  let pause = false;
  const pending = new Promise((resolve) => { reached = resolve; });
  f.beforeFetch((url) => {
    if (url.endsWith('/api/organizations')) return response(200, [{ uuid: 'org-a', name: 'A' }, { uuid: 'org-b', name: 'B' }]);
    if (pause && url.includes('/organizations/org-a/usage')) {
      pause = false;
      reached();
      return new Promise((resolve) => { release = () => resolve(response(200, { five_hour: { utilization: 20 } })); });
    }
  });
  assert.equal((await f.save('a', 'new', { claudeWebOrganizationId: 'org-a' })).saved, true);
  const [a] = f.api.accounts();
  const runtime = createLimitsRuntime({ limitProviders: ['claude'] }, {
    ...f.deps, resolveConfigSnapshot: () => f.settings(), resolveClaudeWebCredential: f.api.resolveCredential,
    onClaudeWebAccountResolved: f.api.resolved
  });
  t.after(() => { release?.(); runtime.stop(); });
  pause = true;
  const readingA = runtime.refresh({ provider: 'claude', accountId: a.id, accountKey: a.accountKey }, 'account-added');
  await pending;
  assert.equal((await f.save('a', a.id, { claudeWebOrganizationId: 'org-b' })).saved, true);
  const savedB = f.api.accounts();
  assert.equal(savedB[0].organizationId, 'org-b');
  assert.notEqual(savedB[0].accountKey, a.accountKey);
  const changesBefore = f.changes.length;
  release();
  await readingA;
  assert.deepEqual(f.api.accounts(), savedB, 'late A result cannot change B metadata');
  assert.equal(f.api.loginStatuses()[a.id], undefined, 'late A result cannot set B login health');
  assert.equal(f.changes.length, changesBefore, 'late result must not trigger another identity refresh');
  const disk = JSON.parse(fs.readFileSync(path.join(f.dir, 'settings.json'), 'utf8'));
  assert.equal(disk.claudeManagedAccounts[0].accountKey, savedB[0].accountKey);
  await runtime.refresh({ provider: 'claude', accountId: a.id, accountKey: savedB[0].accountKey }, 'account-added');
  assert.deepEqual(f.api.accounts(), savedB, 'current B observations still resolve normally');
  assert.equal(f.api.loginStatuses()[a.id], 'ok');
});

test('legacy observations expose only identity and are discarded when the credential or organization changes', async (t) => {
  const f = fixture(t);
  await f.save('a');
  const [a] = f.api.accounts();
  f.setSettings({ ...f.settings(), claudeWebCookie: 'sessionKey=sk-ant-a', claudeWebOrganizationId: 'org-a' });
  const runtime = createLimitsRuntime({ limitProviders: ['claude'] }, {
    ...f.deps, resolveConfigSnapshot: () => f.settings(), resolveClaudeWebCredential: f.api.resolveCredential,
    onClaudeWebAccountResolved: f.api.resolved
  });
  t.after(() => runtime.stop());
  await runtime.refresh('claude', 'credential-save');
  assert.equal(f.api.legacyAccount().accountKey, a.accountKey);
  assert.equal(f.api.loginStatuses().legacy, 'ok');
  assert.equal(JSON.stringify(f.api.legacyAccount()).includes('sk-ant'), false);
  assert.equal(runtime.getSnapshot().providers.filter((row) => row.accountKey === a.accountKey).length, 1);
  f.setSettings({ ...f.settings(), claudeWebOrganizationId: 'another-org' });
  assert.equal(f.api.legacyAccount(), null);
  assert.equal(f.api.loginStatuses().legacy, undefined);
  f.setSettings({ ...f.settings(), claudeWebOrganizationId: 'org-a', claudeWebCookie: 'sessionKey=sk-ant-b' });
  assert.equal(f.api.legacyAccount(), null);
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
    { key: '', reason: 'login-status', flags: { refresh: false } },
    { key: '', reason: 'identity-switch', flags: { clear: true, refresh: false } },
    { key: a.accountKey, reason: 'identity-resolved', flags: { refresh: true } }
  ]);
});
