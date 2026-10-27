'use strict';

const { createCredentialCommands, providerSelectionIncluding } = require('../../limits/credentialCommands');
const { claudeWebAccountMetadata, normalizeClaudeManagedAccounts, upsertClaudeManagedAccount } = require('../../../shared/providers/claude/webAccounts');
const { normalizeClaudeWebCookieInput } = require('../../../shared/providers/claude/limits');

function claudeAccountChangeScope(account, options = {}) {
  return { provider: 'claude', ...(!options.reconcileSources ? { accountId: account.id } : {}),
    ...(options.reconcileSources ? { reconcileSources: true } : {}),
    ...(account.accountKey ? { accountKey: account.accountKey } : {}) };
}

function createClaudeManagedAccounts({ getSettings, setSettings, saveSettings, credentialStore,
  probeDeps, projectSettings, onChanged, getLegacyCredential = () => getSettings().claudeWebCookie, now = Date.now }) {
  let mutationLane = Promise.resolve();
  let epoch = 0;
  let legacyObservation = null;
  const loginObservations = new Map();
  const contexts = new WeakMap();
  const accounts = () => normalizeClaudeManagedAccounts(getSettings().claudeManagedAccounts);
  const serialize = (work) => {
    const task = mutationLane.then(work);
    mutationLane = task.catch(() => {});
    return task;
  };
  const changed = (account, reason, flags = {}) => {
    try { Promise.resolve(onChanged?.(account, reason, flags)).catch(() => {}); } catch (_) {}
  };
  const writeCredential = (id, cookie) => {
    const ok = cookie ? credentialStore.writeClaudeWebCredential(id, cookie) : credentialStore.removeClaudeWebCredential(id);
    if (ok !== true) throw new Error('credentialStorageUnavailable');
  };

  // Settings holds only metadata; the same canonical store owns credentials.
  // Restore both sides if either durable write fails, including post-rename errors.
  function commit(next, writes, preferences = {}) {
    const previous = getSettings();
    const saved = writes.map(({ id }) => ({ id, cookie: credentialStore.readClaudeWebCredential(id) }));
    try {
      for (const { id, cookie } of writes) writeCredential(id, cookie);
      setSettings({ ...getSettings(), ...preferences, claudeManagedAccounts: next });
      if (saveSettings() === false) throw new Error('credentialStorageUnavailable');
    } catch (error) {
      let failed = false;
      for (const { id, cookie } of saved) {
        try { writeCredential(id, cookie); } catch (_) { failed = true; }
      }
      setSettings({ ...getSettings(), ...Object.fromEntries(Object.keys(preferences).map((key) => [key, previous[key]])),
        claudeManagedAccounts: previous.claudeManagedAccounts });
      try { if (saveSettings() === false) failed = true; } catch (_) { failed = true; }
      throw new Error(failed ? 'credentialRollbackFailed' : 'credentialStorageUnavailable', { cause: error });
    }
  }

  const commands = createCredentialCommands({
    getSettings, probeDeps: (renewed) => ({ ...probeDeps(renewed), probe: true }), env: {},
    commitCredential: ({ candidate, provider, values }) => serialize(() => {
      if (contexts.get(values) !== epoch) throw new Error('superseded');
      const previous = accounts();
      const requested = values.claudeWebAccountId;
      if (requested !== 'new' && !previous.some((account) => account.id === requested)) throw new Error('superseded');
      const sameCookie = previous.find((account) => account.organizationId === candidate.claudeWebOrganizationId
        && credentialStore.readClaudeWebCredential(account.id) === candidate.claudeWebCookie);
      const next = upsertClaudeManagedAccount(previous, candidate, provider, requested === 'new' ? sameCookie?.id : requested, now());
      const account = next.find((entry) => entry.id === requested)
        || next.find((entry) => provider?.accountKey && entry.accountKey === provider.accountKey)
        || next.find((entry) => sameCookie && entry.id === sameCookie.id)
        || next.find((entry) => !previous.some((old) => old.id === entry.id));
      if (!account) throw new Error('credentialStorageUnavailable');
      const removed = previous.filter((entry) => !next.some((current) => current.id === entry.id));
      commit(next, [{ id: account.id, cookie: candidate.claudeWebCookie }, ...removed.map(({ id }) => ({ id, cookie: '' }))], {
        limitProviders: providerSelectionIncluding(getSettings().limitProviders, 'claude'), limitsEnabled: true
      });
      for (const entry of [account, ...removed]) loginObservations.delete(entry.id);
      // A duplicate credential disappearing does not retire the shared identity.
      for (const old of removed) changed(old, 'account-removed', { refresh: false });
      const old = previous.find((entry) => entry.id === account.id);
      if (old?.accountKey && old.accountKey !== account.accountKey) changed(old, 'identity-switch', { refresh: true, reconcileSources: true });
      changed(account, 'account-added', { refresh: true });
      return projectSettings();
    })
  });

  function retire() {
    epoch += 1;
    commands.noteSettingsPatch({ claudeWebCookie: '' });
  }

  async function saveAccount(values) {
    if (!values || typeof values !== 'object') return { saved: false, status: 'required', verdict: 'invalid' };
    const id = String(values.claudeWebAccountId || 'new');
    if (id !== 'new' && !accounts().some((account) => account.id === id)) return { saved: false, status: 'notConfigured', verdict: 'invalid' };
    const draft = { claudeWebCookie: values.claudeWebCookie,
      claudeWebOrganizationId: values.claudeWebOrganizationId, claudeWebAccountId: id };
    contexts.set(draft, ++epoch);
    try { return await commands.saveCredential('claude', draft); }
    catch (error) { return { saved: false, verdict: error.message === 'superseded' ? 'superseded' : 'indeterminate', status: 'unavailable', errorCode: 'credentialStorageUnavailable' }; }
  }

  function mutateAccount(id, enabled) {
    retire();
    return serialize(() => {
      const previous = accounts();
      const account = previous.find((entry) => entry.id === id);
      if (!account) return { ok: false, errorCode: 'accountNotFound' };
      const removing = enabled === undefined;
      const next = removing ? previous.filter((entry) => entry.id !== id)
        : previous.map((entry) => entry.id === id ? { ...entry, enabled, updatedAt: new Date(now()).toISOString() } : entry);
      try {
        commit(next, removing ? [{ id, cookie: '' }] : []);
        loginObservations.delete(id);
        if ((removing || !enabled) && !account.accountKey) {
          // Retire only this provisional ID. Reconciliation has no stable key
          // yet, so its provider-wide refresh must never clear sibling rows.
          changed(account, 'account-state', { clear: true, refresh: false });
        }
        // Stable identity refreshes replace or explicitly retire the merged row.
        // Do not blank a still-valid OAuth/legacy reading while that runs.
        changed(removing ? account : next.find((entry) => entry.id === id), 'account-state', {
          clear: false, refresh: true,
          ...(removing || !enabled ? { reconcileSources: true } : {})
        });
        return { ok: true, accounts: accounts(), settings: projectSettings() };
      } catch (_) { return { ok: false, errorCode: 'credentialStorageUnavailable' }; }
    });
  }

  function resolveCredential(account) {
    const current = accounts().find((entry) => entry.id === account.id);
    if (!current?.enabled || current.organizationId !== account.organizationId || current.accountKey !== account.accountKey) {
      throw Object.assign(new Error('Claude account is no longer configured'), { status: 'notConfigured' });
    }
    return normalizeClaudeWebCookieInput(credentialStore.readClaudeWebCredential(current.id));
  }

  function renew({ accountId, previousCookie, cookie }) {
    return serialize(() => {
      const expected = normalizeClaudeWebCookieInput(previousCookie);
      const renewed = normalizeClaudeWebCookieInput(cookie);
      if (!expected || !renewed || !accounts().some((account) => account.id === accountId && account.enabled)
        || credentialStore.readClaudeWebCredential(accountId) !== expected) return false;
      const matches = accounts().filter((account) => credentialStore.readClaudeWebCredential(account.id) === expected);
      commit(accounts(), matches.map(({ id }) => ({ id, cookie: renewed })));
      return true;
    });
  }

  function legacyAccount() {
    let cookie;
    try { cookie = normalizeClaudeWebCookieInput(getLegacyCredential()); } catch (_) { return null; }
    return legacyObservation?.cookie === cookie
      && legacyObservation.organizationId === (getSettings().claudeWebOrganizationId || '')
      ? legacyObservation.metadata : null;
  }

  function loginStatuses() {
    const current = [...accounts(), { id: 'legacy', enabled: true, organizationId: getSettings().claudeWebOrganizationId || '' }];
    return Object.fromEntries(current.flatMap((account) => {
      const observation = loginObservations.get(account.id);
      if (!account.enabled || !observation || observation.organizationId !== account.organizationId) return [];
      try {
        const cookie = account.id === 'legacy' ? getLegacyCredential() : credentialStore.readClaudeWebCredential(account.id);
        return observation.cookie === normalizeClaudeWebCookieInput(cookie) ? [[account.id, observation.status]] : [];
      } catch (_) { return []; }
    }));
  }

  function resolved({ id, cookie, organizationId, provider, scopedById }) {
    return serialize(() => {
      const account = id === 'legacy'
        ? { id, enabled: true, organizationId: getSettings().claudeWebOrganizationId || '' }
        : accounts().find((entry) => entry.id === id);
      const currentCookie = id === 'legacy' ? getLegacyCredential() : credentialStore.readClaudeWebCredential(id);
      if (!account?.enabled || account.organizationId !== organizationId
        || normalizeClaudeWebCookieInput(currentCookie) !== cookie) return;
      const observation = { cookie, organizationId, status: provider?.status || 'notChecked' };
      if (JSON.stringify(loginObservations.get(id)) !== JSON.stringify(observation)) {
        loginObservations.set(id, observation);
        changed(account, 'login-status', { refresh: false });
      }
      if (provider?.status !== 'ok' || !provider.accountKey) return;
      if (id === 'legacy') {
        const metadata = claudeWebAccountMetadata(provider);
        if (JSON.stringify(legacyAccount()) === JSON.stringify(metadata)) return;
        legacyObservation = { cookie, organizationId, metadata };
        changed({ ...metadata, id: 'legacy' }, 'identity-resolved', { refresh: false });
        return;
      }
      const current = accounts();
      const identity = ['accountKey', 'accountEmail', 'accountName', 'accountLabel'];
      if (identity.every((key) => account[key] === (provider[key] || ''))) return;
      const next = current.map((entry) => entry.id === id
        ? { ...entry, ...Object.fromEntries(identity.map((key) => [key, provider[key] || ''])) } : entry);
      commit(next, []);
      if (scopedById && !account.accountKey) {
        changed(account, 'identity-switch', { clear: true, refresh: false });
      }
      changed(next.find((entry) => entry.id === id), 'identity-resolved', { refresh: scopedById && !account.accountKey });
    });
  }

  return { accounts, saveAccount, removeAccount: (id) => mutateAccount(id),
    setAccountEnabled: (id, enabled) => typeof enabled === 'boolean'
      ? mutateAccount(id, enabled) : Promise.resolve({ ok: false, errorCode: 'invalidEnabled' }),
    resolveCredential, renew, resolved, legacyAccount, loginStatuses };
}

module.exports = { createClaudeManagedAccounts, claudeAccountChangeScope };
