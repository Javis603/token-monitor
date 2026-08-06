'use strict';

// Electron-free orchestration of the Codex account import + removal flows. main.js owns the
// `settings` global, the filesystem, the credential store and the limits collector, so every side
// effect is injected through `deps`; that keeps the snapshot/restore rollback and the token-cleanup
// wiring unit-testable without Electron. The behaviour mirrors addCodexManagedAccountFromMaterial /
// removeCodexManagedAccount in src/electron/main.js 1:1 — main.js is a thin wrapper over these.

const path = require('node:path');
const { codexManagedAccountMatchesIdentity, hasCodexIdentity, hashAccountKey } = require('./codexAuth');

function findExistingManagedCodexAccount(accounts, identity) {
  return (Array.isArray(accounts) ? accounts : []).find(
    (account) => codexManagedAccountMatchesIdentity(account, identity)
  );
}

// Deterministic managed-account id from an identity (and the existing record it refreshes, if any).
// Mirrors main.js's codexAccountId so an import lands on the same id as a web login.
function managedCodexAccountId(identity, existing) {
  if (existing?.id) return existing.id;
  return `codex-${(identity.accountKey || hashAccountKey(identity.email)).replace(/^sha256:/, '').slice(0, 12)}`;
}

// Place auth.json into a managed home, then commit the account record. On a re-import (refresh) the
// existing account's working auth.json is snapshotted before being overwritten and restored if the
// commit fails; a brand-new home that fails mid-write is removed. A pre-existing home is never
// deleted — only its auth.json is restored.
//
// deps:
//   accounts                 : current normalized managed accounts (array)
//   resolveHomePath(id)      : -> homePath ('' if invalid)
//   ensureRoot()             : async, create the managed-homes root
//   fs: { mkdir(home), stat(home) }
//   snapshot(authPath)       : async -> snapshot object
//   writeAuth(authPath, data): async
//   restore(snapshot, opts)  : async
//   removeHome(homePath)     : async, best-effort
//   commit(identity, homePath, existing) : async -> account record (throws on persistence failure)
//   onSettingsRollback()     : async, best-effort restore of prior settings
//   invalidate(account)      : optional, queue a limits refresh
async function commitManagedCodexAccountFromMaterial({ identity, data } = {}, deps = {}) {
  if (!hasCodexIdentity(identity)) {
    return { ok: false, error: 'Could not identify the Codex account.' };
  }
  await deps.ensureRoot();
  const existing = findExistingManagedCodexAccount(deps.accounts || [], identity);
  const homePath = deps.resolveHomePath(managedCodexAccountId(identity, existing));
  if (!homePath) return { ok: false, error: 'The saved Codex account path is invalid.' };

  let homeExisted = false;
  try {
    await deps.fs.stat(homePath);
    homeExisted = true;
  } catch (_) { /* managed home does not exist yet */ }

  const authPath = path.join(homePath, 'auth.json');
  let authSnapshot = null;
  let account;
  try {
    await deps.fs.mkdir(homePath);
    if (homeExisted) authSnapshot = await deps.snapshot(authPath);
    await deps.writeAuth(authPath, data);
    account = await deps.commit(identity, homePath, existing);
  } catch (error) {
    if (typeof deps.onSettingsRollback === 'function') {
      try { await deps.onSettingsRollback(); } catch (_) { /* best-effort */ }
    }
    if (authSnapshot) {
      await deps.restore(authSnapshot, { removeNewParent: false }).catch(() => {});
    } else if (!homeExisted) {
      await deps.removeHome(homePath).catch(() => {});
    }
    throw error;
  }
  // invalidate is fire-and-forget and lives outside the try, matching addCodexManagedAccountFromMaterial:
  // a sync throw here must not trigger a rollback of an already-committed account.
  if (typeof deps.invalidate === 'function') deps.invalidate(account);
  return { ok: true, account };
}

// Remove a managed account: persist the filtered list, then release the managed home and the
// credential-store token. `deps.removeToken` is injected (not the store) so a test can assert the
// token cleanup runs for the removed id — guarding the line against silent deletion.
//
// Error semantics mirror removeCodexManagedAccount 1:1: a persistence failure returns {ok:false}
// before any cleanup; a home-removal failure throws (propagates to the IPC caller) so the token
// cleanup and limits invalidation are skipped, exactly as the original uncaught await did.
//
// deps:
//   accounts                      : normalized managed accounts (array)
//   persist(nextAccounts)         : async, throws on failure
//   removeHome(homePath)          : async (throws propagate)
//   removeToken(accountId)        : sync, best-effort
//   invalidate(accountId, accountKey) : optional
//   rendererAccounts()            : optional, -> array (included in the success result)
async function removeManagedCodexAccountRecord(accountId, deps = {}) {
  const id = String(accountId || '').trim();
  const accounts = Array.isArray(deps.accounts) ? deps.accounts : [];
  const account = accounts.find((entry) => entry?.id === id);
  if (!account) return { ok: false, error: 'Account not found' };
  try {
    await deps.persist(accounts.filter((entry) => entry.id !== id));
  } catch (error) {
    return { ok: false, error: error?.message || 'Could not persist account removal' };
  }
  await deps.removeHome(account.homePath);
  try { deps.removeToken(id); } catch (_) { /* best-effort */ }
  if (typeof deps.invalidate === 'function') deps.invalidate(id, account.accountKey || '');
  if (typeof deps.rendererAccounts === 'function') return { ok: true, accounts: deps.rendererAccounts() };
  return { ok: true };
}

module.exports = {
  findExistingManagedCodexAccount,
  managedCodexAccountId,
  commitManagedCodexAccountFromMaterial,
  removeManagedCodexAccountRecord
};
