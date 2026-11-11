'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { LIMIT_PROVIDER_ACCOUNTS, limitAccountRefreshScope } = require('../../src/shared/limits/accounts');
const accountScope = require('../../src/shared/limits/accountScope');

const providersDir = path.join(__dirname, '..', '..', 'src', 'shared', 'providers');

test('a row refresh names the account only where the provider filters by it', () => {
  const row = {
    accountKey: ' key-1 ', accountEmail: 'Me@Example.com', accountName: '', accountLabel: 'Pro', sourceDetail: 'managed'
  };
  assert.deepEqual(limitAccountRefreshScope('codex', row), {
    provider: 'codex', accountKey: 'key-1', accountEmail: 'me@example.com', accountLabel: 'Pro', sourceDetail: 'managed'
  });
  // Cursor's probe ignores the scope and answers for every account, which the
  // runtime would file under the one scoped identity.
  assert.deepEqual(limitAccountRefreshScope('cursor', row), { provider: 'cursor' });
  // Only an account key names one account precisely enough: a provider's
  // name- or email-only path can fall back to reading every account.
  assert.deepEqual(limitAccountRefreshScope('codex', { accountLabel: 'Pro' }), { provider: 'codex' });
  assert.deepEqual(limitAccountRefreshScope('minimax', { accountName: 'Work', accountEmail: 'a@b.c' }), { provider: 'minimax' });
  assert.deepEqual(limitAccountRefreshScope('codex', { accountKey: 42 }), { provider: 'codex' });
});

test('providers with a source that answers for every account refresh as a whole', () => {
  // Volcengine's signed API returns the Coding and Agent plans together whatever
  // the scope, Antigravity's local RPC answers for whichever account is signed
  // in now, OpenCode's scoped collection leaves out its auto-detected key, and a
  // WorkBuddy local session without a user id is keyed by an id its scoped
  // matcher never computes: narrowing would file another account's row under
  // the clicked one, replace a healthy reading with notConfigured, or probe
  // nothing.
  // MiMo's desktop fallback answers with an unattributed placeholder whatever
  // the scope names.
  for (const provider of ['volcengine', 'antigravity', 'opencode', 'workbuddy', 'mimo']) {
    assert.deepEqual(limitAccountRefreshScope(provider, { accountKey: 'k', accountName: 'Work' }), { provider });
  }
});

test('every provider declaring accountRefresh reads the refresh scope in its probe', () => {
  const declared = LIMIT_PROVIDER_ACCOUNTS.filter((decl) => decl.accountRefresh).map((decl) => decl.id);
  assert.ok(declared.length > 0);
  for (const id of declared) {
    const source = fs.readFileSync(path.join(providersDir, id, 'limits.js'), 'utf8');
    assert.match(source, /limitRefreshScope/, `${id} declares accountRefresh but never reads limitRefreshScope`);
  }
});

test('a probe in flight covers the rows the runtime would file its answer under', () => {
  const row = { provider: 'codex', accountKey: 'K-1', accountEmail: 'Me@Example.com', accountName: 'Work' };
  // The runtime names a probe by the strongest identity its scope carries…
  const probe = (scope) => ({ provider: scope.provider, account: accountScope.probeAccount(scope) });
  assert.ok(accountScope.probeCoversRow(probe({ provider: 'codex', accountKey: 'k-1', accountEmail: 'x@y.z' }), row));
  assert.ok(accountScope.probeCoversRow(probe({ provider: 'codex', accountEmail: 'me@example.com' }), row));
  assert.equal(accountScope.probeCoversRow(probe({ provider: 'codex', accountKey: 'k-2' }), row), false);
  // …and a credential-only scope names no row at all.
  assert.equal(accountScope.probeCoversRow(probe({ provider: 'codex', credential: 'secret' }), row), false);
  assert.ok(accountScope.probeCoversRow({ provider: 'codex', account: null }, row));
  assert.equal(accountScope.probeCoversRow({ provider: 'claude', account: null }, row), false);
  // Exactly the runtime's own scope match, from the same module.
  assert.ok(accountScope.rowMatchesScope(row, { accountKey: ' k-1 ' }));
});
