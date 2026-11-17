'use strict';

const { createMimoAccountMetadataReader } = require('./accountMetadata');
const { withDetectedMimoAccount, normalizeMimoCookieHeader, createMimoManagedAccount, fetchMimoLimits } = require('../../../shared/providers/mimo/limits');
const path = require('node:path');
const { readRegularFileNoFollow } = require('../../../shared/credentialStore');
const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * Owns mimo account workflows and process-local state.
 * @param {object} deps Provider-scoped persistence and named host IO capabilities.
 */
function createMimoAccountService(deps) {
  const { getMimoManagedAccounts, getUserDataPath, getCredentialStore, credentialProbeDeps, setMimoManagedAccounts, saveSettings, pushSettingsToRenderer, sendMimoAccountsPush, queueLimitInvalidation } = deps;
  const MIMO_DETECTED_ACCOUNT_ID = 'mimo-local-session';
  const detectedMimoAccountKey = createMimoAccountMetadataReader();
  function normalizeMimoManagedAccounts(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const accounts = [];
    for (const account of value) {
      if (!account || typeof account !== 'object') continue;
      const id = String(account.id || '').trim();
      const accountKey = String(account.accountKey || '').trim();
      if (!id || !accountKey) continue;
      if (seen.has(accountKey)) continue;
      seen.add(accountKey);
      accounts.push({
        id,
        accountKey,
        accountEmail: String(account.accountEmail || '').trim().slice(0, 254),
        accountLabel: String(account.accountLabel || '').trim(),
        addedAt: account.addedAt || new Date().toISOString(),
        updatedAt: account.updatedAt || account.addedAt || new Date().toISOString(),
        enabled: account.enabled !== false
      });
    }
    return accounts;
  }

  function mimoDetectedAccount() {
    const accountKey = detectedMimoAccountKey();
    if (!accountKey) return null;
    return {
      id: MIMO_DETECTED_ACCOUNT_ID,
      accountKey,
      accountEmail: '',
      accountLabel: '',
      enabled: true
    };
  }

  function mimoAccountsForRenderer() {
    const accounts = normalizeMimoManagedAccounts(getMimoManagedAccounts()).map(({
      id, accountKey, accountEmail, accountLabel, addedAt, updatedAt, enabled
    }) => ({ id, accountKey, accountEmail, accountLabel, addedAt, updatedAt, enabled }));
    return withDetectedMimoAccount(accounts, mimoDetectedAccount());
  }

  function mimoManagedAccountsForCollector() {
    return normalizeMimoManagedAccounts(getMimoManagedAccounts()).map((account) => ({
      ...account,
      cookieHeader: readMimoCredential(account.id)
    }));
  }

  function legacyMimoCredentialPath(id) {
    const digest = crypto.createHash('sha256').update(String(id || '')).digest('hex');
    return path.join(getUserDataPath(), 'mimo-credentials', `${digest}.cookie`);
  }

  function writeMimoCredential(id, value) {
    const cookieHeader = normalizeMimoCookieHeader(value);
    if (!cookieHeader) return false;
    try {
      return getCredentialStore().writeMimoCredential(id, cookieHeader);
    } catch (_) {
      return false;
    }
  }

  function readMimoCredential(id) {
    try {
      return normalizeMimoCookieHeader(getCredentialStore().readMimoCredential(id));
    } catch (_) {
      return '';
    }
  }

  function removeMimoCredential(id) {
    try {
      return getCredentialStore().removeMimoCredential(id);
    } catch (_) {
      return false;
    }
  }

  async function addMimoManagedAccount(cookieValue) {
    const accounts = normalizeMimoManagedAccounts(getMimoManagedAccounts());
    const result = createMimoManagedAccount(cookieValue, accounts);
    if (!result.ok) return result;
    const [validation] = await fetchMimoLimits({
      mimoManagedAccounts: [result.account],
      limitRefreshScope: { provider: 'mimo', accountKey: result.account.accountKey }
    }, credentialProbeDeps());
    if (validation?.status !== 'ok') {
      const errorCode = validation?.status === 'unauthorized'
        ? 'invalidCookie'
        : validation?.status === 'sourceRateLimited' ? 'validationRateLimited' : 'validationUnavailable';
      return { ok: false, errorCode };
    }
    result.account.accountEmail = String(validation.accountEmail || '').trim().slice(0, 254);
    const currentAccounts = normalizeMimoManagedAccounts(getMimoManagedAccounts());
    const current = currentAccounts.find(account => account.accountKey === result.account.accountKey);
    if (current) result.account = { ...current, ...result.account, id: current.id, addedAt: current.addedAt, accountLabel: current.accountLabel, enabled: current.enabled };
    const previousCookie = readMimoCredential(result.account.id);
    const credentialStored = writeMimoCredential(result.account.id, result.account.cookieHeader);
    delete result.account.cookieHeader;
    if (!credentialStored) return { ok: false, errorCode: 'credentialStorageUnavailable' };
    setMimoManagedAccounts(normalizeMimoManagedAccounts([
      ...currentAccounts.filter((account) => account.accountKey !== result.account.accountKey),
      result.account
    ]));
    try {
      saveSettings({ throwOnError: true });
    } catch (_) {
      setMimoManagedAccounts(currentAccounts);
      if (previousCookie) writeMimoCredential(result.account.id, previousCookie);
      else removeMimoCredential(result.account.id);
      return { ok: false, errorCode: 'credentialStorageUnavailable' };
    }
    pushSettingsToRenderer();
    sendMimoAccountsPush();
    void queueLimitInvalidation({
      provider: 'mimo',
      accountId: result.account.id,
      accountKey: result.account.accountKey
    }, 'account-added');
    return { ok: true, accounts: mimoAccountsForRenderer() };
  }

  async function removeMimoManagedAccount(id) {
    const accountId = String(id || '').trim();
    const accounts = normalizeMimoManagedAccounts(getMimoManagedAccounts());
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    const previousCookie = readMimoCredential(accountId);
    if (!removeMimoCredential(accountId)) return { ok: false, error: 'Could not remove stored credential' };
    setMimoManagedAccounts(accounts.filter((entry) => entry.id !== accountId));
    try {
      saveSettings({ throwOnError: true });
    } catch (_) {
      if (previousCookie) writeMimoCredential(accountId, previousCookie);
      return { ok: false, error: 'Could not persist account removal' };
    }
    pushSettingsToRenderer();
    sendMimoAccountsPush();
    void queueLimitInvalidation({ provider: 'mimo', accountId, accountKey: account.accountKey }, 'account-removed', {
      clear: true,
      refresh: false
    });
    return { ok: true, accounts: mimoAccountsForRenderer() };
  }

  function setMimoManagedAccountEnabled(id, enabled) {
    const accountId = String(id || '').trim();
    const accounts = normalizeMimoManagedAccounts(getMimoManagedAccounts());
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    account.enabled = Boolean(enabled);
    account.updatedAt = new Date().toISOString();
    setMimoManagedAccounts(accounts);
    try {
      saveSettings({ throwOnError: true });
    } catch (_) {
      return { ok: false, error: 'Could not persist account state' };
    }
    pushSettingsToRenderer();
    sendMimoAccountsPush();
    void queueLimitInvalidation({ provider: 'mimo', accountId, accountKey: account.accountKey }, 'account-state', {
      clear: !account.enabled,
      refresh: account.enabled
    });
    return { ok: true, accounts: mimoAccountsForRenderer() };
  }

  function migrateLegacyMimoCredentialFiles(accounts) {
    const entries = [];
    for (const account of accounts || []) {
      try {
        const cookieHeader = normalizeMimoCookieHeader(readRegularFileNoFollow(legacyMimoCredentialPath(account.id), {
          fs,
          description: 'Legacy MiMo credential',
          encoding: 'utf8'
        }));
        if (cookieHeader) entries.push({ id: account.id, cookieHeader });
      } catch (_) {}
    }
    if (entries.length === 0) return;
    try {
      getCredentialStore().migrateLegacyMimoCredentials(entries);
      for (const entry of entries) {
        if (!readMimoCredential(entry.id)) continue;
        try { fs.rmSync(legacyMimoCredentialPath(entry.id), { force: true }); } catch (_) {}
      }
      try { fs.rmdirSync(path.join(getUserDataPath(), 'mimo-credentials')); } catch (_) {}
    } catch (error) {
      console.warn(`[credentials] Could not migrate MiMo credentials: ${error.message}`);
    }
  }
  return { normalizeMimoManagedAccounts, mimoDetectedAccount, mimoAccountsForRenderer, mimoManagedAccountsForCollector, legacyMimoCredentialPath, writeMimoCredential, readMimoCredential, removeMimoCredential, addMimoManagedAccount, removeMimoManagedAccount, setMimoManagedAccountEnabled, migrateLegacyMimoCredentialFiles };
}
module.exports = { createMimoAccountService };
