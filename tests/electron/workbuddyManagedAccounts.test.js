'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkbuddyManagedAccounts } = require('../../src/electron/providers/workbuddy/managedAccounts');
const { normalizeManagedAccounts } = require('../../src/shared/providers/workbuddy/oauth');
const { CredentialStore, writePrivateJsonAtomic } = require('../../src/shared/credentialStore');

const copy = (value) => value === undefined ? undefined : structuredClone(value);
const reply = (data, status = 200) => ({ status, json: async () => data });
const account = normalizeManagedAccounts([{ id: 'a', realm: 'cn', userId: 'u1', enterpriseId: '',
  domain: 'www.codebuddy.cn', enabled: true, addedAt: '2026-01-01', updatedAt: '2026-01-01' }])[0];
const old = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 500,
  refreshExpiresAt: 500000, domain: account.domain };
const rotated = { accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresIn: 300, refreshExpiresIn: 600 };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
}

function harness(options = {}) {
  let rows = copy(options.accounts ?? [account]);
  let disk = copy(rows);
  const secrets = new Map([[account.id, copy(old)]]);
  const notifications = [];
  let failure = '';
  const store = {
    readWorkbuddyCredential: (id) => copy(secrets.get(id) || null),
    writeWorkbuddyCredential: (id, credential) => {
      secrets.set(id, copy(credential));
      if (failure === 'credential') { failure = ''; throw new Error('private-secret disk failure'); }
      return true;
    },
    removeWorkbuddyCredential: (id) => {
      secrets.delete(id);
      if (failure === 'credential') { failure = ''; throw new Error('private-secret disk failure'); }
      return true;
    }
  };
  const service = createWorkbuddyManagedAccounts({ getAccounts: () => rows,
    setAccounts: (value) => { rows = copy(value); },
    saveSettings: async () => {
      disk = copy(rows);
      if (failure === 'settings') { failure = ''; throw new Error('private-secret settings failure'); }
    }, credentialStore: store, now: () => 1000,
    fetch: options.fetch || (async () => reply({ code: 0, data: rotated })),
    openExternal: options.openExternal || (async () => {}),
    onChanged: (...args) => notifications.push(args) });
  return { service, store, secrets, notifications, getDisk: () => copy(disk),
    fail: (type) => { failure = type; }, replace: (value) => { rows = copy(value); } };
}

function loginTransport({ uid = 'u1', enterpriseId = '', realm = 'cn', token = 'login', gate } = {}) {
  const origin = realm === 'cn' ? 'https://www.codebuddy.cn' : 'https://www.workbuddy.ai';
  const platform = realm === 'cn' ? 'workbuddy' : 'workbuddy-ai';
  return async (url) => {
    if (url.includes('/auth/state')) return reply({ code: 0,
      data: { state: 'private-state', authUrl: `${origin}/login?state=private-state&platform=${platform}` } });
    if (url.includes('/auth/token?')) return reply({ code: 0,
      data: { accessToken: `${token}-access`, refreshToken: `${token}-refresh`, expiresIn: 3600 } });
    if (url.includes('/login/account')) {
      if (gate) { gate.started.resolve(); await gate.release.promise; }
      return reply({ code: 0, data: { uid, enterpriseId, type: enterpriseId ? 'enterprise' : 'personal' } });
    }
    throw new Error('unexpected route');
  };
}

test('duplicate browser login updates existing id and keeps metadata secret-free', async () => {
  const h = harness({ fetch: loginTransport() });
  const result = await h.service.addAccount('cn');
  assert.equal(result.ok, true);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].id, 'a');
  assert.equal(result.accounts[0].addedAt, account.addedAt);
  assert.equal(result.accounts[0].accountKey, account.accountKey);
  assert.equal(h.store.readWorkbuddyCredential('a').accessToken, 'login-access');
  assert.equal(JSON.stringify(result).includes('login-access'), false);
  assert.equal(JSON.stringify(result).includes('private-state'), false);
  assert.equal(h.notifications[0][1], 'account-added');
  assert.deepEqual(h.notifications[0][2], { clear: true, refresh: true });
  result.accounts[0].userId = 'tampered';
  assert.equal(h.service.accounts()[0].userId, 'u1');
});

test('same uid in AI creates a separate managed identity and realm-bound credentials', async () => {
  const h = harness({ fetch: loginTransport({ realm: 'ai' }) });
  const result = await h.service.addAccount('ai');
  assert.equal(result.ok, true);
  assert.equal(result.accounts.length, 2);
  const ai = result.accounts.find((row) => row.realm === 'ai');
  assert.notEqual(ai.accountKey, account.accountKey);
  assert.equal(h.store.readWorkbuddyCredential(ai.id).domain, 'www.workbuddy.ai');
});

test('login, remove and enable roll back both metadata and credentials after pre/post-write failures', async () => {
  for (const operation of ['login', 'remove', 'disable']) {
    for (const failure of operation === 'disable' ? ['settings'] : ['credential', 'settings']) {
      const h = harness({ fetch: loginTransport() });
      h.fail(failure);
      const result = operation === 'login' ? await h.service.addAccount('cn')
        : operation === 'remove' ? await h.service.removeAccount('a') : await h.service.setAccountEnabled('a', false);
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, 'PERSISTENCE_FAILED');
      assert.deepEqual(h.service.accounts(), [account]);
      assert.deepEqual(h.getDisk(), [account]);
      assert.deepEqual(h.store.readWorkbuddyCredential('a'), old);
      assert.equal(h.notifications.length, 0);
      assert.equal(JSON.stringify(result).includes('private-secret'), false);
    }
  }
});

test('real credential/settings files restore durable state when settings fails after rename', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-managed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  store.writeWorkbuddyCredential('a', old);
  const settingsPath = path.join(dir, 'settings.json');
  let rows = [account];
  writePrivateJsonAtomic(settingsPath, rows);
  let fail = true;
  const service = createWorkbuddyManagedAccounts({ getAccounts: () => rows, setAccounts: (next) => { rows = next; },
    saveSettings: () => {
      writePrivateJsonAtomic(settingsPath, rows);
      if (fail) { fail = false; throw new Error('after rename'); }
    }, credentialStore: store, fetch: loginTransport(), openExternal: async () => {}, now: () => 1000 });
  const result = await service.addAccount('cn');
  assert.equal(result.ok, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), [account]);
  assert.deepEqual(new CredentialStore(dir).readWorkbuddyCredential('a'), old);
  assert.deepEqual(service.accounts(), [account]);
});

test('missing credential keeps identity and rejects borrowed app-owned credentials without fetching', async () => {
  let requests = 0;
  const h = harness({ fetch: async () => { requests++; } });
  await assert.rejects(h.service.resolveCredential({ ...account, credentials: old }), { status: 'notConfigured' });
  await assert.rejects(h.service.resolveCredential({ ...account, id: 'local-app', accessToken: 'app-token' }), { status: 'notConfigured' });
  h.secrets.delete('a');
  await assert.rejects(h.service.resolveCredential(account), { status: 'notConfigured' });
  assert.deepEqual(h.service.accounts(), [account]);
  assert.equal(requests, 0);
});

test('non-expiring/unknown expiry triggers bounded refresh; valid stored token avoids it unless forced', async () => {
  let requests = 0;
  const h = harness({ fetch: async () => { requests++; return reply({ code: 0, data: rotated }); } });
  h.secrets.set('a', { ...old, expiresAt: 1_000_000 });
  assert.equal((await h.service.resolveCredential(account)).accessToken, old.accessToken);
  assert.equal(requests, 0);
  assert.equal((await h.service.resolveCredential(account, { forceRefresh: true })).accessToken, 'rotated-access');
  assert.equal(requests, 1);
  h.secrets.set('a', { ...old, expiresAt: null });
  await h.service.resolveCredential(account);
  assert.equal(requests, 2);
});

test('single-flight refresh persists rotated credentials immediately before resolving to quota callers', async () => {
  const ready = deferred();
  const release = deferred();
  let requests = 0;
  const h = harness({ fetch: async () => { requests++; ready.resolve(); await release.promise; return reply({ code: 0, data: rotated }); } });
  const first = h.service.resolveCredential(account);
  const second = h.service.resolveCredential(account);
  await ready.promise;
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.equal(results[0].refreshToken, 'rotated-refresh');
  assert.deepEqual(results[0], results[1]);
  assert.equal(h.store.readWorkbuddyCredential('a').refreshToken, 'rotated-refresh');
  assert.equal(h.store.readWorkbuddyCredential('a').accessToken, 'rotated-access');
  assert.equal(h.notifications[0][1], 'credential-renewed');
});

test('transient refresh and auth rejection retain stored secrets and stable metadata', async () => {
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'unauthorized'], [429, 'sourceRateLimited'], [503, 'unavailable']]) {
    const h = harness({ fetch: async () => reply({ msg: 'private-secret' }, status) });
    await assert.rejects(h.service.resolveCredential(account), { status: expected });
    assert.deepEqual(h.service.accounts(), [account]);
    assert.deepEqual(h.store.readWorkbuddyCredential('a'), old);
  }
  const h = harness({ fetch: async () => { throw new Error('private-secret'); } });
  await assert.rejects(h.service.resolveCredential(account), (error) => error.status === 'unavailable' && !String(error).includes('private'));
  assert.deepEqual(h.store.readWorkbuddyCredential('a'), old);
  const invalidGrant = harness({ fetch: async () => reply({ code: 12153, msg: 'private-secret invalid_grant' }) });
  await assert.rejects(invalidGrant.service.resolveCredential(account), { status: 'unauthorized' });
  assert.deepEqual(invalidGrant.store.readWorkbuddyCredential('a'), old);
  assert.deepEqual(invalidGrant.service.accounts(), [account]);
});

test('refresh credential persistence failure reports a sanitized error; no success callback', async () => {
  const h = harness();
  // Failure before writing leaves the previous credential intact.
  h.store.writeWorkbuddyCredential = () => { throw new Error('private-secret'); };
  await assert.rejects(h.service.resolveCredential(account), { code: 'PERSISTENCE_FAILED', status: 'unavailable' });
  assert.deepEqual(h.store.readWorkbuddyCredential('a'), old);
  assert.equal(h.notifications.length, 0);
});

test('remove/disable/replacement during refresh rejects stale completion and never resurrects credentials', async () => {
  for (const mutation of ['remove', 'disable', 'credential', 'membership']) {
    const ready = deferred();
    const release = deferred();
    const h = harness({ fetch: async () => { ready.resolve(); await release.promise; return reply({ code: 0, data: rotated }); } });
    const result = h.service.resolveCredential(account);
    const rejection = assert.rejects(result, (error) => ['CANCELED', 'SUPERSEDED'].includes(error.code));
    await ready.promise;
    if (mutation === 'remove') await h.service.removeAccount('a');
    if (mutation === 'disable') await h.service.setAccountEnabled('a', false);
    if (mutation === 'credential') h.secrets.set('a', { ...old, accessToken: 'replacement' });
    if (mutation === 'membership') h.replace([{ ...account, enabled: false }]);
    release.resolve();
    await rejection;
    assert.notEqual(h.store.readWorkbuddyCredential('a')?.accessToken, 'rotated-access');
    if (mutation === 'remove') assert.equal(h.store.readWorkbuddyCredential('a'), null);
  }
});

test('duplicate relogin retires in-flight refresh and preserves new login credentials', async () => {
  const ready = deferred();
  const release = deferred();
  const login = loginTransport();
  const h = harness({ fetch: async (url, init) => {
    if (!url.endsWith('/refresh')) return login(url, init);
    ready.resolve(); await release.promise;
    return reply({ code: 0, data: rotated });
  } });
  const stale = h.service.resolveCredential(account);
  const rejected = assert.rejects(stale, (error) => ['CANCELED', 'SUPERSEDED'].includes(error.code));
  await ready.promise;
  assert.equal((await h.service.addAccount('cn')).ok, true);
  release.resolve();
  await rejected;
  assert.equal(h.store.readWorkbuddyCredential('a').accessToken, 'login-access');
});

test('removal during duplicate login prevents account recreation', async () => {
  const gate = { started: deferred(), release: deferred() };
  const h = harness({ fetch: loginTransport({ gate }) });
  const pending = h.service.addAccount('cn');
  await gate.started.promise;
  await h.service.removeAccount('a');
  gate.release.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'SUPERSEDED');
  assert.deepEqual(h.service.accounts(), []);
  assert.equal(h.store.readWorkbuddyCredential('a'), null);
});

test('cancelLogin prevents late browser completion from persisting secrets', async () => {
  const gate = { started: deferred(), release: deferred() };
  const h = harness({ fetch: loginTransport({ gate }) });
  const pending = h.service.addAccount('cn');
  await gate.started.promise;
  assert.equal(h.service.cancelLogin(), true);
  assert.equal(h.service.cancelLogin(), false);
  gate.release.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CANCELED');
  assert.deepEqual(h.store.readWorkbuddyCredential('a'), old);
  assert.deepEqual(h.service.accounts(), [account]);
  assert.equal(h.service.cancelLogin(), false);
});

test('one canceled refresh waiter leaves sibling active; final cancellation aborts transport and prevents writes', async () => {
  for (const withSibling of [true, false]) {
    const ready = deferred();
    const release = deferred();
    let transportSignal;
    const h = harness({ fetch: async (_url, init) => {
      transportSignal = init.signal;
      ready.resolve(); await release.promise;
      return reply({ code: 0, data: rotated });
    } });
    const controller = new AbortController();
    const canceled = h.service.resolveCredential(account, { signal: controller.signal });
    const rejected = assert.rejects(canceled, { code: 'CANCELED' });
    const sibling = withSibling ? h.service.resolveCredential(account) : null;
    await ready.promise;
    controller.abort(new Error('private-secret'));
    await rejected;
    assert.equal(transportSignal.aborted, !withSibling);
    release.resolve();
    if (sibling) {
      assert.equal((await sibling).accessToken, 'rotated-access');
      assert.equal(h.store.readWorkbuddyCredential('a').accessToken, 'rotated-access');
    } else {
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(h.store.readWorkbuddyCredential('a'), old);
    }
  }
});

test('remove and enable return safe metadata and expected invalidation flags', async () => {
  const h = harness();
  assert.equal((await h.service.setAccountEnabled('a', false)).ok, true);
  await assert.rejects(h.service.resolveCredential(h.service.accounts()[0]), { status: 'notConfigured' });
  assert.deepEqual(h.notifications[0][2], { clear: true, refresh: false });
  assert.equal((await h.service.setAccountEnabled('a', true)).ok, true);
  assert.deepEqual(h.notifications[1][2], { clear: true, refresh: true });
  assert.equal((await h.service.removeAccount('a')).ok, true);
  assert.equal(h.store.readWorkbuddyCredential('a'), null);
  assert.deepEqual(h.service.accounts(), []);
});
