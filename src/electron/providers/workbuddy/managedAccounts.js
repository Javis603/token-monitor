'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeManagedAccounts, normalizeCredential, refreshCredential,
  authError, boundedOperation } = require('../../../shared/providers/workbuddy/oauth');
const { runWorkbuddyOAuthLogin } = require('./oauthLogin');

function createWorkbuddyManagedAccounts({ getAccounts, setAccounts, saveSettings,
  credentialStore, fetch, openExternal, onChanged, now = Date.now }) {
  let mutationLane = Promise.resolve();
  let login = null;
  const generations = new Map();
  const flights = new Map();
  const accounts = () => normalizeManagedAccounts(getAccounts());
  const generation = (id) => generations.get(id) || 0;
  const fingerprint = (value) => JSON.stringify(value);
  const serialize = (work) => {
    const task = mutationLane.then(work);
    mutationLane = task.catch(() => {});
    return task;
  };
  const changed = (account, reason, flags) => {
    // Notification failure cannot turn a completed durable mutation into a
    // failed login or expose a caller's exception.
    try { Promise.resolve(onChanged?.(account, reason, flags)).catch(() => {}); } catch (_) {}
  };
  const retire = (id) => {
    generations.set(id, generation(id) + 1);
    flights.get(id)?.controller.abort();
  };
  const storeCredential = (id, credential) => {
    const ok = credential ? credentialStore.writeWorkbuddyCredential(id, credential)
      : credentialStore.removeWorkbuddyCredential(id);
    if (ok !== true) throw authError('PERSISTENCE_FAILED');
  };

  // The store and settings writer are deliberately separate. Restore both
  // even when an atomic writer renamed successfully before reporting failure.
  async function commitAccounts(next, id, credential, writeCredential = true, validate = () => {}) {
    const previous = accounts();
    const oldCredential = writeCredential ? credentialStore.readWorkbuddyCredential(id) : null;
    try {
      if (writeCredential) storeCredential(id, credential);
      setAccounts(next);
      if (await saveSettings() === false) throw authError('PERSISTENCE_FAILED');
      validate();
    } catch (error) {
      let rollbackFailed = false;
      try { if (writeCredential) storeCredential(id, oldCredential); } catch (_) { rollbackFailed = true; }
      try {
        setAccounts(previous);
        if (await saveSettings() === false) rollbackFailed = true;
      } catch (_) { rollbackFailed = true; }
      throw authError(rollbackFailed ? 'ROLLBACK_FAILED'
        : ['CANCELED', 'SUPERSEDED'].includes(error?.code) ? error.code : 'PERSISTENCE_FAILED');
    }
  }

  function cancelLogin() {
    const active = login !== null && !login.controller.signal.aborted;
    login?.controller.abort();
    login = null;
    return active;
  }

  async function addAccount(realm) {
    cancelLogin();
    const startingAccounts = accounts();
    const startingGenerations = new Map(startingAccounts.map((account) => [account.id, generation(account.id)]));
    const attempt = { controller: new AbortController() };
    login = attempt;
    try {
      const { credential, identity } = await runWorkbuddyOAuthLogin({
        realm, fetch, openExternal, signal: attempt.controller.signal, now
      });
      return await serialize(async () => {
        if (login !== attempt || attempt.controller.signal.aborted) throw authError('CANCELED');
        const previous = accounts();
        const original = startingAccounts.find((account) => account.accountKey === identity.accountKey);
        if (original && (generation(original.id) !== startingGenerations.get(original.id)
          || !previous.some((account) => account.id === original.id))) throw authError('SUPERSEDED');
        const existing = previous.find((account) => account.accountKey === identity.accountKey);
        const timestamp = new Date(now()).toISOString();
        const account = { ...identity, id: existing?.id || randomUUID(), enabled: true,
          addedAt: existing?.addedAt || timestamp, updatedAt: timestamp };
        const next = normalizeManagedAccounts([...previous.filter((item) => item.id !== account.id), account]);
        retire(account.id);
        await commitAccounts(next, account.id, credential, true, () => {
          if (login !== attempt || attempt.controller.signal.aborted) throw authError('CANCELED');
        });
        changed(account, 'account-added', { clear: true, refresh: true });
        return { ok: true, accounts: accounts() };
      });
    } catch (error) {
      const allowed = new Set(['INVALID_REALM', 'INVALID_STATE', 'INVALID_LOGIN_URL', 'INVALID_DOMAIN',
        'INVALID_IDENTITY', 'INVALID_TOKEN', 'CONTEXT_CHANGED', 'CANCELED', 'TIMEOUT', 'AUTH_REQUIRED',
        'RATE_LIMITED', 'NETWORK_UNAVAILABLE', 'INVALID_RESPONSE', 'TRANSPORT_UNAVAILABLE',
        'BROWSER_UNAVAILABLE', 'LOGIN_FAILED', 'PERSISTENCE_FAILED', 'ROLLBACK_FAILED', 'SUPERSEDED']);
      return { ok: false, accounts: accounts(), errorCode: allowed.has(error?.code) ? error.code : 'LOGIN_FAILED' };
    } finally { if (login === attempt) login = null; }
  }

  async function mutateAccount(id, enabled) {
    return serialize(async () => {
      try {
        const previous = accounts();
        const account = previous.find((item) => item.id === id);
        if (!account) return { ok: false, accounts: previous, errorCode: 'ACCOUNT_NOT_FOUND' };
        retire(id);
        const removing = enabled === undefined;
        const next = removing ? previous.filter((item) => item.id !== id)
          : previous.map((item) => item.id === id
            ? { ...item, enabled, updatedAt: new Date(now()).toISOString() } : item);
        await commitAccounts(next, id, null, removing);
        changed(removing ? account : next.find((item) => item.id === id),
          removing ? 'account-removed' : 'account-enabled', { clear: true, refresh: !removing && enabled });
        return { ok: true, accounts: accounts() };
      } catch (error) {
        return { ok: false, accounts: accounts(),
          errorCode: error?.code === 'ROLLBACK_FAILED' ? 'ROLLBACK_FAILED' : 'PERSISTENCE_FAILED' };
      }
    });
  }

  function matchingAccount(candidate) {
    const normalized = normalizeManagedAccounts([candidate])[0];
    const current = accounts().find((item) => item.id === normalized?.id);
    if (!current || !normalized || current.accountKey !== normalized.accountKey
      || current.domain !== normalized.domain || current.departmentInfo !== normalized.departmentInfo
      || candidate.credentials || candidate.accessToken || candidate.auth) throw authError('NOT_CONFIGURED', 'notConfigured');
    if (!current.enabled) throw authError('ACCOUNT_DISABLED', 'notConfigured');
    return current;
  }

  async function resolveCredential(candidate, { signal, forceRefresh = false } = {}) {
    if (signal?.aborted) throw authError('CANCELED');
    const account = matchingAccount(candidate);
    let stored;
    try { stored = credentialStore.readWorkbuddyCredential(account.id); }
    catch (_) { throw authError('PERSISTENCE_FAILED'); }
    if (!stored) throw authError('NOT_CONFIGURED', 'notConfigured');
    const credential = normalizeCredential(stored, { realm: account.realm, now: now() });
    if (credential.domain !== account.domain) throw authError('CONTEXT_CHANGED');
    if (!forceRefresh && credential.expiresAt !== null && credential.expiresAt > now() + 60_000) return credential;
    let flight = flights.get(account.id);
    if (flight?.controller.signal.aborted) flight = null;
    if (!flight) {
      const controller = new AbortController();
      flight = { controller, waiters: 0, generation: generation(account.id), account, stored };
      const ownedFlight = flight;
      flight.promise = (async () => {
        const updated = await refreshCredential(credential, account, { fetch, signal: controller.signal, now });
        return serialize(() => {
          const latest = accounts().find((item) => item.id === account.id);
          if (controller.signal.aborted || generation(account.id) !== ownedFlight.generation
            || fingerprint(latest) !== fingerprint(account)) throw authError('SUPERSEDED');
          try {
            if (fingerprint(credentialStore.readWorkbuddyCredential(account.id)) !== fingerprint(stored)) throw authError('SUPERSEDED');
            storeCredential(account.id, updated);
          } catch (error) {
            if (error?.code === 'SUPERSEDED') throw error;
            throw authError('PERSISTENCE_FAILED');
          }
          changed(account, 'credential-renewed', { refresh: false });
          return updated;
        });
      })().finally(() => { if (flights.get(account.id) === ownedFlight) flights.delete(account.id); });
      // A canceled waiter may leave no consumer when the transport settles.
      flight.promise.catch(() => {});
      flights.set(account.id, flight);
    }
    flight.waiters += 1;
    try {
      // Each waiter owns its cancellation. Only the last canceled waiter
      // retires the underlying refresh, so a sibling's signal cannot poison it.
      return await boundedOperation(() => flight.promise, { signal, timeoutMs: 30_000 });
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && flights.get(account.id) === flight) flight.controller.abort();
    }
  }

  return { accounts, addAccount, cancelLogin,
    removeAccount: (id) => mutateAccount(id),
    setAccountEnabled: (id, enabled) => typeof enabled === 'boolean'
      ? mutateAccount(id, enabled) : Promise.resolve({ ok: false, accounts: accounts(), errorCode: 'INVALID_ENABLED' }),
    resolveCredential };
}

module.exports = { createWorkbuddyManagedAccounts };
