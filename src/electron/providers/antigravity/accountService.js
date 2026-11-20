'use strict';

const antigravityOAuth = require('../../../shared/providers/antigravity/oauth');
const { runAntigravityOAuthLogin } = require('./oauthLogin');
const crypto = require('node:crypto');

/**
 * Owns antigravity account workflows and process-local state.
 * @param {object} deps Provider-scoped persistence and named host IO capabilities.
 */
function createAntigravityAccountService(deps) {
  const { getAntigravityManagedAccounts, getCredentialStore, electronLimitsFetch, openExternal, setAntigravityManagedAccounts, saveSettings, pushSettingsToRenderer, sendAntigravityAccountsPush, queueLimitInvalidation, slotPersistence, env = process.env, oauthLogin = runAntigravityOAuthLogin } = deps;
  let antigravityOAuthLoginController = null;
  const generations = new Map();
  const retire = id => generations.set(id, (generations.get(id) || 0) + 1);
  function normalizeAntigravityManagedAccounts(value) {
    return antigravityOAuth.normalizeManagedAccounts(value);
  }

  function antigravityAccountsForRenderer() {
    return normalizeAntigravityManagedAccounts(slotPersistence ? slotPersistence.accounts() : getAntigravityManagedAccounts());
  }

  function readAntigravityCredential(id) {
    try {
      return slotPersistence ? slotPersistence.read(id) : getCredentialStore().readAntigravityCredential(id);
    } catch (_) {
      return null;
    }
  }

  function writeAntigravityCredential(id, credentials) {
    try {
      return getCredentialStore().writeAntigravityCredential(id, credentials);
    } catch (_) {
      return false;
    }
  }

  function removeAntigravityCredential(id) {
    try {
      return getCredentialStore().removeAntigravityCredential(id);
    } catch (_) {
      return false;
    }
  }

  function antigravityManagedAccountsForCollector() {
    return antigravityOAuth.managedAccountsForCollector(
      slotPersistence ? slotPersistence.accounts() : getAntigravityManagedAccounts(),
      readAntigravityCredential
    );
  }

  function persistAntigravityCredentialsRenewal({ account, credentials, previous } = {}) {
    const accountId = String(account?.id || '').trim();
    if (!accountId || !credentials || typeof credentials !== 'object') return false;
    const current = readAntigravityCredential(accountId);
    if (!current || JSON.stringify(current) !== JSON.stringify(previous || {})) return false;
    if (slotPersistence) {
      return slotPersistence.commit(antigravityAccountsForRenderer(), [{ id: accountId, credential: credentials }], () => {
        if (!antigravityAccountsForRenderer().some(item => item.id === accountId && item.enabled)
          || JSON.stringify(readAntigravityCredential(accountId)) !== JSON.stringify(previous || {})) throw new Error('superseded');
      }).then(() => true, () => false);
    }
    return writeAntigravityCredential(accountId, credentials);
  }

  async function addAntigravityManagedAccount() {
    if (antigravityOAuthLoginController) return { ok: false, errorCode: 'loginInProgress' };
    const controller = new AbortController();
    antigravityOAuthLoginController = controller;
    const startingAccounts = antigravityAccountsForRenderer();
    const startingGenerations = new Map(generations);
    try {
      const { credential, identity } = await oauthLogin({
        env: env,
        fetch: electronLimitsFetch(),
        openExternal: (url) => openExternal(url),
        signal: controller.signal,
        logger: (message) => console.log(`[antigravity-oauth] ${message}`)
      });
      if (controller.signal.aborted) return { ok: false, errorCode: 'cancelled' };
      const accounts = normalizeAntigravityManagedAccounts(slotPersistence ? slotPersistence.accounts() : getAntigravityManagedAccounts());
      const now = new Date().toISOString();
      const existing = accounts.find((account) => account.accountEmail === identity.email);
      const account = {
        id: existing?.id || `antigravity-${crypto.randomUUID()}`,
        accountKey: antigravityOAuth.accountKey(identity.email),
        accountEmail: identity.email,
        // The Google profile name is an identity, not a rename; the email
        // stays the account's display name unless the user renames it.
        accountName: identity.name || existing?.accountName || '',
        accountLabel: '',
        enabled: true,
        addedAt: existing?.addedAt || now,
        updatedAt: now
      };
      const previousCredential = existing ? readAntigravityCredential(existing.id) : null;
      if (slotPersistence) {
        const original = startingAccounts.find(item => item.accountEmail === identity.email);
        await slotPersistence.commit([...accounts.filter(item => item.id !== account.id), account], [{ id: account.id, credential: {
          ...credential, refreshToken: credential.refreshToken || previousCredential?.refreshToken || ''
        } }], () => {
          if (controller.signal.aborted || original && ((generations.get(original.id) || 0) !== (startingGenerations.get(original.id) || 0)) || original && JSON.stringify(antigravityAccountsForRenderer().find(item => item.id === original.id)) !== JSON.stringify(original)) throw new Error('superseded');
        });
      } else {
      if (!writeAntigravityCredential(account.id, {
        ...credential,
        refreshToken: credential.refreshToken || previousCredential?.refreshToken || ''
      })) {
        return { ok: false, errorCode: 'credentialStorageUnavailable' };
      }
      setAntigravityManagedAccounts(normalizeAntigravityManagedAccounts([
        ...accounts.filter((entry) => entry.id !== account.id && entry.accountEmail !== account.accountEmail),
        account
      ]));
      try {
        saveSettings({ throwOnError: true });
      } catch (_) {
        if (previousCredential) writeAntigravityCredential(account.id, previousCredential);
        else removeAntigravityCredential(account.id);
        return { ok: false, errorCode: 'credentialStorageUnavailable' };
      }
      }
      pushSettingsToRenderer();
      sendAntigravityAccountsPush();
      void queueLimitInvalidation({
        provider: 'antigravity',
        accountId: account.id,
        accountKey: account.accountKey,
        accountEmail: account.accountEmail,
        sourceDetail: 'oauth'
      }, 'account-added');
      return { ok: true, accounts: antigravityAccountsForRenderer() };
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.code === 'CANCELLED' || error?.name === 'AbortError';
      return {
        ok: false,
        errorCode: cancelled ? 'cancelled' : error?.code || 'loginFailed',
        error: cancelled ? '' : String(error?.message || error)
      };
    } finally {
      if (antigravityOAuthLoginController === controller) antigravityOAuthLoginController = null;
    }
  }

  function cancelAntigravityManagedAccountLogin() {
    if (!antigravityOAuthLoginController) return false;
    antigravityOAuthLoginController.abort();
    return true;
  }

  async function removeAntigravityManagedAccount(id) {
    const accountId = String(id || '').trim();
    const accounts = normalizeAntigravityManagedAccounts(slotPersistence ? slotPersistence.accounts() : getAntigravityManagedAccounts());
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    retire(accountId);
    if (slotPersistence) await slotPersistence.commit(accounts.filter(item => item.id !== accountId), [{ id: accountId, credential: null }]);
    else {
    const previousCredential = readAntigravityCredential(accountId);
    if (!removeAntigravityCredential(accountId)) return { ok: false, error: 'Could not remove stored credential' };
    setAntigravityManagedAccounts(accounts.filter((entry) => entry.id !== accountId));
    try {
      saveSettings({ throwOnError: true });
    } catch (_) {
      if (previousCredential) writeAntigravityCredential(accountId, previousCredential);
      return { ok: false, error: 'Could not persist account removal' };
    }
    }
    pushSettingsToRenderer();
    sendAntigravityAccountsPush();
    void queueLimitInvalidation({ provider: 'antigravity', accountId, accountKey: account.accountKey }, 'account-removed', {
      clear: true,
      refresh: false
    });
    return { ok: true, accounts: antigravityAccountsForRenderer() };
  }

  async function setAntigravityManagedAccountEnabled(id, enabled) {
    const accountId = String(id || '').trim();
    const accounts = normalizeAntigravityManagedAccounts(slotPersistence ? slotPersistence.accounts() : getAntigravityManagedAccounts());
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    retire(accountId);
    account.enabled = Boolean(enabled);
    account.updatedAt = new Date().toISOString();
    if (slotPersistence) await slotPersistence.commit(accounts, []);
    else {
    setAntigravityManagedAccounts(accounts);
    try {
      saveSettings({ throwOnError: true });
    } catch (_) {
      return { ok: false, error: 'Could not persist account state' };
    }
    }
    pushSettingsToRenderer();
    sendAntigravityAccountsPush();
    void queueLimitInvalidation({ provider: 'antigravity', accountId, accountKey: account.accountKey }, 'account-state', {
      clear: !account.enabled,
      refresh: account.enabled
    });
    return { ok: true, accounts: antigravityAccountsForRenderer() };
  }
  return { normalizeAntigravityManagedAccounts, antigravityAccountsForRenderer, readAntigravityCredential, writeAntigravityCredential, removeAntigravityCredential, antigravityManagedAccountsForCollector, persistAntigravityCredentialsRenewal, addAntigravityManagedAccount, cancelAntigravityManagedAccountLogin, removeAntigravityManagedAccount, setAntigravityManagedAccountEnabled };
}
module.exports = { createAntigravityAccountService };
