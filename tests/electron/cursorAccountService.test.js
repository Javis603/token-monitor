'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCursorAccountService } = require('../../src/electron/providers/cursor/accountService');
const { canonicalCursorUserId } = require('../../src/shared/providers/cursor/auth');
const { fetchCursorLimits } = require('../../src/shared/providers/cursor/limits');
const { hashKey } = require('../../src/shared/hashKey');

function createService(accounts, result, { disabled = [], manual = accounts.map(account => account.id), desktop = { state: 'unknown' }, external = false, probeCalls = [] } = {}) {
  const forbidden = () => assert.fail('status must not mutate credentials, settings or Tokscale state');
  return createCursorAccountService({
    isExternalAgentActive: () => external,
    getCursorDisabledAccountIds: () => disabled,
    getCursorManualAccountIds: () => manual,
    setCursorDisabledAccountIds: forbidden,
    setCursorManualAccountIds: forbidden,
    saveSettings: forbidden,
    reconfigureLimits: forbidden,
    queueLimitInvalidation: forbidden,
    refreshUsage: forbidden,
    auth: {
      listAccounts: () => accounts,
      canonicalCursorUserId,
      readCursorDesktopSignIn: () => desktop,
      runCursorDiscover: forbidden,
      runCursorLogin: forbidden,
      runCursorLogout: forbidden
    },
    probe: { probe: async token => {
      probeCalls.push(token);
      assert.ok(accounts.some(account => account.sessionToken === token));
      return result;
    } }
  });
}

const success = sub => ({ ok: true, user: { sub, email: 'shared@example.com', name: 'Shared Name' }, usage: {} });
const failure = kind => ({ ok: false, error: { kind, message: 'Probe unavailable' } });

for (const fixture of [
  { name: 'API subject overrides stored identity', account: { id: 'user_local', userId: 'user_saved' }, result: success('auth0|user_api'), expected: hashKey('cursor', 'user_api') },
  { name: 'saved subject works without API identity', account: { id: 'opaque', userId: 'auth0|user_saved' }, result: success(null), expected: hashKey('cursor', 'user_saved') },
  { name: 'canonical local ID works during network failure', account: { id: 'user_local' }, result: failure('network'), expected: hashKey('cursor', 'user_local') },
  { name: 'saved identity works when unauthorized', account: { id: 'opaque', userId: 'user_saved' }, result: failure('unauthorized'), expected: hashKey('cursor', 'user_saved') },
  { name: 'invalid API subject falls through to local ID', account: { id: 'user_local', userId: 'invalid' }, result: success('not-a-canonical-subject'), expected: hashKey('cursor', 'user_local') },
  { name: 'opaque local ID stays local despite matching email and name', account: { id: 'opaque-a', label: 'Shared Name' }, result: success(null), expected: hashKey('cursor-local', 'opaque-a') },
  { name: 'opaque local ID works during probe failure', account: { id: 'opaque-b' }, result: failure('parse'), expected: hashKey('cursor-local', 'opaque-b') }
]) {
  test(`Cursor status identity: ${fixture.name}`, async () => {
    const account = { ...fixture.account, sessionToken: 'private-session-token' };
    const service = createService([account], fixture.result);
    const status = await service.status();
    assert.equal(status.accounts[0].accountKey, fixture.expected);
    const limits = await fetchCursorLimits({}, { listAccounts: () => [account], probe: async () => fixture.result });
    assert.equal(status.accounts[0].accountKey, limits.accountKey);
    assert.equal(status.accounts[0].expired, fixture.result.error?.kind === 'unauthorized');
    assert.doesNotMatch(JSON.stringify(status), /private-session-token|sessionToken|userId/);
    assert.deepEqual(Object.keys(status.accounts[0]).sort(), [
      'accountKey', 'email', 'enabled', 'error', 'expired', 'id', 'label', 'membershipType', 'removable', 'source'
    ]);
  });
}

test('Cursor presentation resolves local and matching verified identities without probing', async () => {
  const account = { id: 'user_saved', sessionToken: 'private-token' };
  const probeCalls = [];
  const service = createService([account], success('user_verified'), { probeCalls });
  assert.deepEqual(service.presentationAccounts(), [{ accountKey: hashKey('cursor', 'user_saved') }]);
  assert.deepEqual(probeCalls, []);
  await service.status();
  assert.deepEqual(service.presentationAccounts(), [{ accountKey: hashKey('cursor', 'user_verified') }]);
  account.sessionToken = 'rotated-token';
  assert.deepEqual(service.presentationAccounts(), [{ accountKey: hashKey('cursor', 'user_saved') }]);
  assert.deepEqual(probeCalls, ['private-token']);
});

test('Cursor disabled accounts keep canonical identity without a quota reading', async () => {
  const account = { id: 'opaque', userId: 'user_saved', sessionToken: 'private-token' };
  const service = createService([account], failure('network'), { disabled: [account.id] });
  const status = await service.status();
  assert.equal(status.accounts[0].enabled, false);
  assert.equal(status.accounts[0].accountKey, hashKey('cursor', 'user_saved'));
  assert.equal(status.linkedCount, 0);
  const limits = await fetchCursorLimits({ cursorDisabledAccountIds: [account.id] }, { listAccounts: () => [account], probe: () => assert.fail('disabled quota must not be probed') });
  assert.equal(limits.status, 'notConfigured');
});

test('Cursor opaque accounts with matching display metadata remain distinct', async () => {
  const accounts = ['opaque-a', 'opaque-b'].map(id => ({ id, label: 'Shared Name', sessionToken: `private-${id}` }));
  const status = await createService(accounts, success(null)).status();
  assert.deepEqual(status.accounts.map(account => account.accountKey), accounts.map(account => hashKey('cursor-local', account.id)));
  assert.notEqual(status.accounts[0].accountKey, status.accounts[1].accountKey);
});

test('Cursor identity addition preserves detected-account visibility rules', async () => {
  const account = { id: 'user_saved', sessionToken: 'private-token' };
  for (const [desktop, result, visible] of [
    [{ state: 'unknown' }, failure('network'), true],
    [{ state: 'unknown' }, failure('unauthorized'), false],
    [{ state: 'signed-out' }, success('user_saved'), false],
    [{ state: 'signed-in', userId: 'user_other' }, success('user_saved'), false]
  ]) {
    const status = await createService([account], result, { manual: [], desktop }).status();
    assert.equal(status.accounts.length, Number(visible));
    if (visible) assert.equal(status.accounts[0].accountKey, hashKey('cursor', 'user_saved'));
  }
});

test('Cursor external authority blocks discovery and mutation while status exposes only safe identity', async () => {
  const account = { id: 'opaque', sessionToken: 'private-token' };
  const service = createService([account], success('user_api'), { external: true });
  const status = await service.status({ discover: true });
  assert.equal(status.managementBlocked, true);
  assert.equal(status.accounts[0].accountKey, hashKey('cursor', 'user_api'));
  assert.doesNotMatch(JSON.stringify(status), /private-token|sessionToken/);
  assert.equal((await service.loginManual('private-token')).code, 'EXTERNAL_AGENT_ACTIVE');
  assert.equal((await service.logout(account.id)).code, 'EXTERNAL_AGENT_ACTIVE');
});

test('Cursor status probes and counts desktop and manual accounts together', async () => {
  const accounts = [{ id: 'user_desktop', sessionToken: 'desktop' }, { id: 'user_manual', sessionToken: 'web' }];
  const probeCalls = [];
  const status = await createService(accounts, success(null), { manual: ['user_manual'], probeCalls }).status();
  assert.deepEqual(probeCalls, ['desktop', 'web']);
  assert.deepEqual(status.accounts.map(account => account.source), ['desktop', 'web']);
  assert.equal(status.linkedCount, 2);
});
