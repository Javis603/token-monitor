'use strict';

// Unit tests for the dep-injected Codex account import/remove orchestration. These exercise the
// rollback and token-cleanup paths that live behind Electron IPC in main.js, with fakes injected so
// no Electron (or real filesystem/settings) is required. items 2/3/4 of the follow-up.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  authFromCodexAccessToken,
  codexAccountKey
} = require('../../src/shared/codexAuth');
const {
  managedCodexAccountId,
  commitManagedCodexAccountFromMaterial,
  removeManagedCodexAccountRecord
} = require('../../src/shared/codexAccountImport');

function jwt(payload) {
  const seg = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'none', typ: 'JWT' })}.${seg(payload)}.`;
}

function enoent() {
  const error = new Error('ENOENT');
  error.code = 'ENOENT';
  return error;
}

// --- Item 2: parse -> material -> commit (valid token -> account; identity-less -> clear error) ---

test('commitManagedCodexAccountFromMaterial commits a parsed token to an account', async () => {
  const material = authFromCodexAccessToken(
    jwt({ email: 'alice@example.com', chatgpt_account_id: 'acct_1' })
  );
  let committedIdentity;
  let wroteTo;
  const result = await commitManagedCodexAccountFromMaterial(material, {
    accounts: [],
    resolveHomePath: (id) => `/home/${id}`,
    ensureRoot: async () => {},
    fs: { mkdir: async () => {}, stat: async () => { throw enoent(); } },
    snapshot: async () => { throw new Error('snapshot must not run for a brand-new home'); },
    writeAuth: async (authPath, data) => { wroteTo = { authPath, data }; },
    restore: async () => {},
    removeHome: async () => {},
    commit: async (identity) => { committedIdentity = identity; return { id: 'codex-1', accountKey: identity.accountKey }; },
    invalidate: () => {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.account.id, 'codex-1');
  assert.equal(committedIdentity.email, 'alice@example.com');
  assert.equal(wroteTo.data, material.data);
});

test('commitManagedCodexAccountFromMaterial rejects identity-less material with a clear error', async () => {
  const result = await commitManagedCodexAccountFromMaterial(
    { identity: { email: '', accountKey: '' }, data: '{}' },
    {
      accounts: [],
      resolveHomePath: () => '/home/x',
      ensureRoot: async () => {},
      fs: { mkdir: async () => {}, stat: async () => { throw enoent(); } },
      snapshot: async () => ({}),
      writeAuth: async () => {},
      restore: async () => {},
      removeHome: async () => {},
      commit: async () => { throw new Error('commit must not run for identity-less material'); }
    }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /identify/i);
});

test('a malformed paste is rejected at the parse step before reaching the import path', () => {
  // authFromCodexAccessToken is the parse->material step the IPC handler runs first.
  assert.throws(() => authFromCodexAccessToken('opaque-token-without-claims'), /Could not identify/i);
  assert.throws(() => authFromCodexAccessToken(''), /empty/i);
});

// --- Item 3: atomic re-import rollback ---

test('re-import over an existing account restores the prior auth.json when commit fails', async () => {
  const identity = { email: 'alice@example.com', accountKey: codexAccountKey('alice@example.com', 'acct_1') };
  const material = { identity, data: 'NEW-AUTH-JSON' };
  const restored = [];
  await assert.rejects(
    commitManagedCodexAccountFromMaterial(material, {
      accounts: [{ id: 'codex-existing', email: 'alice@example.com', accountKey: identity.accountKey }],
      resolveHomePath: (id) => `/home/${id}`,
      ensureRoot: async () => {},
      fs: { mkdir: async () => {}, stat: async () => {} }, // stat succeeds -> home pre-existed
      snapshot: async (authPath) => ({ authPath, data: 'ORIGINAL-AUTH-JSON', existed: true, parentExisted: true }),
      writeAuth: async () => {},
      restore: async (snapshot) => { restored.push(snapshot); },
      removeHome: async () => { throw new Error('a pre-existing home must NOT be deleted on rollback'); },
      commit: async () => { throw new Error('commit failed'); },
      onSettingsRollback: async () => {}
    }),
    /commit failed/
  );
  // The overwritten working auth.json was restored from the snapshot, not dropped.
  assert.equal(restored.length, 1);
  assert.equal(restored[0].data, 'ORIGINAL-AUTH-JSON');
});

test('a brand-new home that fails mid-write is removed, with no snapshot/restore', async () => {
  const identity = { email: 'bob@example.com', accountKey: codexAccountKey('bob@example.com', 'acct_2') };
  const material = { identity, data: 'NEW-AUTH-JSON' };
  const expectedHome = `/home/${managedCodexAccountId(identity, undefined)}`;
  let removedHome = '';
  await assert.rejects(
    commitManagedCodexAccountFromMaterial(material, {
      accounts: [],
      resolveHomePath: (id) => `/home/${id}`,
      ensureRoot: async () => {},
      fs: { mkdir: async () => {}, stat: async () => { throw enoent(); } }, // home does not pre-exist
      snapshot: async () => { throw new Error('snapshot must not run for a brand-new home'); },
      writeAuth: async () => { throw new Error('write failed'); },
      restore: async () => { throw new Error('restore must not run for a brand-new home'); },
      removeHome: async (homePath) => { removedHome = homePath; },
      commit: async () => { throw new Error('commit must not be reached'); }
    }),
    /write failed/
  );
  assert.equal(removedHome, expectedHome);
});

// --- Item 4: removeCodexAccountToken wiring ---

test('removeManagedCodexAccountRecord cleans the managed home and the stored token for the removed id', async () => {
  const removedHome = [];
  const removedTokens = [];
  const result = await removeManagedCodexAccountRecord('codex-1', {
    accounts: [
      { id: 'codex-1', homePath: '/home/codex-1', accountKey: 'k1' },
      { id: 'codex-2', homePath: '/home/codex-2', accountKey: 'k2' }
    ],
    persist: async () => {},
    removeHome: async (homePath) => { removedHome.push(homePath); },
    removeToken: (id) => { removedTokens.push(id); },
    invalidate: () => {},
    rendererAccounts: () => [{ id: 'codex-2' }]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.accounts, [{ id: 'codex-2' }]);
  assert.deepEqual(removedHome, ['/home/codex-1']);
  // The cleanup line this test guards: the credential-store token for the removed id is dropped too.
  assert.deepEqual(removedTokens, ['codex-1']);
});

test('removeManagedCodexAccountRecord returns not-found and skips cleanup for an unknown id', async () => {
  let cleaned = false;
  const result = await removeManagedCodexAccountRecord('missing', {
    accounts: [{ id: 'codex-1', homePath: '/home/codex-1' }],
    persist: async () => { cleaned = true; },
    removeHome: async () => { cleaned = true; },
    removeToken: () => { cleaned = true; }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
  assert.equal(cleaned, false);
});

test('removeManagedCodexAccountRecord returns ok:false and skips cleanup when persistence fails', async () => {
  let cleaned = false;
  const result = await removeManagedCodexAccountRecord('codex-1', {
    accounts: [{ id: 'codex-1', homePath: '/home/codex-1' }],
    persist: async () => { throw new Error('persist failed'); },
    removeHome: async () => { cleaned = true; },
    removeToken: () => { cleaned = true; }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /persist failed/);
  assert.equal(cleaned, false);
});

test('removeManagedCodexAccountRecord aborts cleanup (and throws) when home removal fails', async () => {
  // Matches the original contract: removeManagedHomeIfSafe was an uncaught await, so a home-removal
  // failure propagates and skips the token cleanup + invalidation that follow it.
  let removeTokenCalled = false;
  await assert.rejects(
    removeManagedCodexAccountRecord('codex-1', {
      accounts: [{ id: 'codex-1', homePath: '/home/codex-1' }],
      persist: async () => {},
      removeHome: async () => { throw new Error('rm failed'); },
      removeToken: () => { removeTokenCalled = true; }
    }),
    /rm failed/
  );
  assert.equal(removeTokenCalled, false);
});
