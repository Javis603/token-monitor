'use strict';

const antigravityOAuth = require('../../../shared/providers/antigravity/oauth');
const { runAntigravityOAuthLogin } = require('./oauthLogin');
const crypto = require('node:crypto');

/**
 * Owns antigravity account workflows and process-local state.
 * @param {object} deps Provider-scoped persistence and named host IO capabilities.
 */
function createAntigravityAccountService(deps) {
  const { getAntigravityManagedAccounts, getCredentialStore, electronLimitsFetch, openExternal, setAntigravityManagedAccounts, saveSettings, pushSettingsToRenderer, sendAntigravityAccountsPush, queueLimitInvalidation, env = process.env, oauthLogin = runAntigravityOAuthLogin } = deps;
  let antigravityOAuthLoginController = null;
  function normalizeAntigravityManagedAccounts(value) {
    return antigravityOAuth.normalizeManagedAccounts(value);
  }

  function antigravityAccountsForRenderer() {
    return normalizeAntigravityManagedAccounts(getAntigravityManagedAccounts());
  }

  function readAntigravityCredential(id) {
    try {
      return getCredentialStore().readAntigravityCredential(id);
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
      getAntigravityManagedAccounts(),
      readAntigravityCredential
    );
  }

  function persistAntigravityCredentialsRenewal({ account, credentials, previous } = {}) {
    const accountId = String(account?.id || '').trim();
    if (!accountId || !credentials || typeof credentials !== 'object') return false;
    const current = readAntigravityCredential(accountId);
    if (!current || JSON.stringify(current) !== JSON.stringify(previous || {})) return false;
    return writeAntigravityCredential(accountId, credentials);
  }

  async function addAntigravityManagedAccount() {
    if (antigravityOAuthLoginController) return { ok: false, errorCode: 'loginInProgress' };
    const controller = new AbortController();
    antigravityOAuthLoginController = controller;
    try {
      const { credential, identity } = await oauthLogin({
        env: env,
        fetch: electronLimitsFetch(),
        openExternal: (url) => openExternal(url),
        signal: controller.signal,
        logger: (message) => console.log(`[antigravity-oauth] ${message}`)
      });
      const accounts = normalizeAntigravityManagedAccounts(getAntigravityManagedAccounts());
      const now = new Date().toISOString();
      const existing = accounts.find((account) => account.accountEmail === identity.email);
      const account = {
        id: existing?.id || `antigravity-${crypto.randomUUID()}`,
        accountKey: antigravityOAuth.accountKey(identity.email),
        accountEmail: identity.email,
        accountLabel: existing?.accountLabel || identity.name || '',
        enabled: true,
        addedAt: existing?.addedAt || now,
        updatedAt: now
      };
      const previousCredential = existing ? readAntigravityCredential(existing.id) : null;
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
    const accounts = normalizeAntigravityManagedAccounts(getAntigravityManagedAccounts());
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    const previousCredential = readAntigravityCredential(accountId);
    if (!removeAntigravityCredential(accountId)) return { ok: false, error: 'Could not remove stored credential' };
    setAntigravityManagedAccounts(accounts.filter((entry) => entry.id !== accountId));
    try {
      saveSettings({ throwOnError: true });
    } catch (_) {
      if (previousCredential) writeAntigravityCredential(accountId, previousCredential);
      return { ok: false, error: 'Could not persist account removal' };
    }
    pushSettingsToRenderer();
    sendAntigravityAccountsPush();
    void queueLimitInvalidation({ provider: 'antigravity', accountId, accountKey: account.accountKey }, 'account-removed', {
      clear: true,
      refresh: false
    });
    return { ok: true, accounts: antigravityAccountsForRenderer() };
  }

  function setAntigravityManagedAccountEnabled(id, enabled) {
    const accountId = String(id || '').trim();
    const accounts = normalizeAntigravityManagedAccounts(getAntigravityManagedAccounts());
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    account.enabled = Boolean(enabled);
    account.updatedAt = new Date().toISOString();
    setAntigravityManagedAccounts(accounts);
    try {
      saveSettings({ throwOnError: true });
    } catch (_) {
      return { ok: false, error: 'Could not persist account state' };
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
