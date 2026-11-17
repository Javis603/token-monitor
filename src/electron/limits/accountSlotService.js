'use strict';

const { ambientAccounts } = require('../../shared/limits/ambientAccounts');
const { normalizeAccountPresentation, validKey } = require('./accountPresentation');
const { hashKey } = require('../../shared/hashKey');
const { runLimitInvalidation } = require('../deviceRuntimeCoordinator');
const { randomUUID } = require('node:crypto');
const { createCredentialCommands, providerSelectionIncluding } = require('./credentialCommands');
const { accountForm, normalizeAccountField } = require('./accountSettings');
const { limitProviderEntry } = require('../../shared/limits/registry');
const { orderAccountRows, defaultIdentityKey, accountSlotKey, normalizeAccountSlots, defaultAccountValues, accountCredentialKey, accountValuesFingerprint } = require('../../shared/limits/accountSlots');

// All secret/identity writes share one lane. Refresh notification is outside the
// transaction: a refresh may itself enqueue a resolved identity.
function createAccountSlotService({ getSettings, write, onChanged, onPresentation, probeDeps, env = process.env, now = Date.now }) {
  let lane = Promise.resolve();
  // Sharing is best effort and off the account lane: a rename or move answers
  // as soon as it is saved locally, never after a Hub round trip.
  const publishPresentation = (operations) => {
    try { Promise.resolve(onPresentation?.(operations)).catch(() => {}); } catch (_) { /* Local save already succeeded. */ }
  };
  const environmentIdentities = new Map();
  const serialize = (work) => {
    const task = lane.then(work);
    lane = task.catch(() => {});
    return task;
  };
  const entryFor = (id) => {
    const entry = limitProviderEntry(typeof id === 'string' ? id : '');
    return entry?.accountSlots ? entry : null;
  };
  const slots = (entry) => {
    const order = getSettings().limitAccountPresentation?.[entry.id]?.order || [];
    const keyOf = slot => slot.accountKey || hashKey(entry.id, 'account-slot', `slot:${slot.id}`);
    const rank = slot => order.includes(keyOf(slot)) ? order.indexOf(keyOf(slot)) : order.length;
    return normalizeAccountSlots(entry, getSettings()[accountSlotKey(entry)]).sort((a, b) => rank(a) - rank(b));
  };
  const environment = entry => {
    const values = defaultAccountValues(entry, getSettings(), env);
    const cached = environmentIdentities.get(entry.id);
    const identity = cached?.fingerprint === accountValuesFingerprint(values) ? cached.identity : {};
    const credentialKey = accountCredentialKey(entry, values);
    const credential = values[credentialKey];
    return credentialKey && !getSettings()[credentialKey] ? { id: 'environment', label: '', enabled: true, source: 'environment', values, accountKey: hashKey(entry.id, credential), ...identity } : null;
  };
  const ambient = entry => ambientAccounts(entry, getSettings(), { ...probeDeps?.(), env });
  const ordered = (entry, list = slots(entry)) => orderAccountRows(list, ambient(entry),
    environment(entry) ? { ...environment(entry), order: getSettings()[defaultIdentityKey(entry)]?.order } : null);
  const visible = entry => ordered(entry).filter((item, index, all) => !all.slice(0, index).some(other => (other.source || item.source)
    && other.enabled !== false && item.enabled !== false && other.accountKey && (other.accountKey === item.accountKey || other.accountKeyAliases?.includes(item.accountKey) || item.accountKeyAliases?.includes(other.accountKey))));
  const dto = entry => visible(entry).map(({ id, label, enabled, accountKey, accountKeyAliases = [], values, fingerprint, source, sourceName, accountName, accountEmail, createdAt, updatedAt }) => {
    const key = accountKey || hashKey(entry.id, 'account-slot', source ? 'default' : `slot:${id}`);
    return { id, label, enabled, accountKey: key, accountKeyAliases, ...(source ? { source } : {}),
      ...(source === 'discovered' ? { sourceName, accountName, accountEmail } : {}),
      formValues: Object.fromEntries(accountForm(entry).fields.filter(field => !field.secret).map(field => [field.key, values[field.key]])),
      fingerprint: (source === 'discovered' ? fingerprint : accountValuesFingerprint(values)).slice(7, 19), createdAt, updatedAt };
  });
  const failure = (errorCode) => ({ ok: false, errorCode });
  // `refresh: false`: only local presentation changed (label, order), so the
  // runtime re-projects its rows without asking the provider again.
  const changed = (entry, retiredAccountKeys, refresh) => {
    try { Promise.resolve(onChanged?.(entry.id, { retiredAccountKeys, refresh })).catch(() => {}); } catch (_) { /* Durable save already succeeded. */ }
  };
  async function commit(entry, next, notify = true, refresh = true, activate = false) {
    const previous = ordered(entry);
    const normalized = normalizeAccountSlots(entry, next);
    const keys = slot => [slot.accountKey || hashKey(entry.id, 'account-slot', slot.source ? 'default' : `slot:${slot.id}`), ...(slot.accountKeyAliases || [])];
    const active = ordered(entry, [...normalized]).filter(slot => slot.enabled);
    const owned = new Set(active.flatMap(keys));
    const retiredAccountKeys = [...new Set(previous.filter(slot => slot.enabled
      && !active.some(item => item.id === slot.id)).flatMap(keys))].filter(key => !owned.has(key));
    // A saved credential turns collection on for its provider, as the fixed
    // credential form always did.
    await write({ [accountSlotKey(entry)]: normalized, ...(activate ? {
      limitProviders: providerSelectionIncluding(getSettings().limitProviders, entry.id), limitsEnabled: true } : {}) });
    if (notify) changed(entry, retiredAccountKeys, refresh);
  }
  function list(providerId) {
    const entry = entryFor(providerId);
    return entry ? { ok: true, accounts: dto(entry) } : failure('unsupportedProvider');
  }
  function save(providerId, values, { replacing = false, id, label = '', verified, isCurrent = () => true } = {}) {
    return serialize(async () => {
      const entry = entryFor(providerId);
      if (!entry) return failure('unsupportedProvider');
      if (!isCurrent()) return failure('cancelled');
      if (id === 'environment' || id?.startsWith('discovered-')) return failure('environmentCredential');
      const previous = slots(entry);
      let old = replacing ? previous.find(slot => slot.id === id) : null;
      if (replacing && !old) return failure('accountNotFound');
      if (!replacing && !entry.dedupeAccounts && previous.length >= 21) return failure('slotLimit');
      let rejected;
      // Reuse the fixed credential validator, including transport isolation and
      // unauthorized/indeterminate verdicts. Never return its settings payload.
      const commitCredential = async ({ candidate, provider }) => {
        if (!isCurrent()) throw new Error('Login cancelled');
        if (!old && entry.dedupeAccounts) old = previous.find(slot => slot.accountKey === provider?.accountKey || accountValuesFingerprint(slot.values) === accountValuesFingerprint(candidate));
        if (!old && previous.length >= 21) throw new Error('Account slot limit');
        // The same credential twice would be two rows for one account and a
        // duplicate request each pass; it is refused, pointing at the existing row.
        const fingerprint = accountValuesFingerprint(candidate);
        const environmentRow = environment(entry);
        const environmentValues = environmentRow && Object.fromEntries(accountForm(entry).fields.map(({ key }) =>
          [key, normalizeAccountField(key, environmentRow.values[key])]));
        // Re-saving this slot's own values keeps the existing replace contract,
        // even if an environment credential now duplicates this older slot.
        const duplicatesEnvironment = environmentValues && accountValuesFingerprint(environmentValues) === fingerprint
          && (!old || accountValuesFingerprint(old.values) !== fingerprint);
        if (duplicatesEnvironment
          || previous.some(slot => slot.id !== old?.id && accountValuesFingerprint(slot.values) === fingerprint)) {
          rejected = { saved: false, verdict: 'duplicate', status: 'duplicate' };
          return;
        }
        const key = provider?.accountKey || old?.accountKey || '';
        const provesServer = entry.serverAccountKey && entry.limits[entry.serverAccountKey];
        // The proof is remembered on the record: a replacement saved without an
        // answer keeps the old key beside new values, which can no longer prove it.
        // Provisional slot keys are bookkeeping, never server identity proof.
        const oldProven = Boolean(old?.accountKey && provesServer
          && (old.serverIdentity || (old.accountKey !== hashKey(entry.id, 'account-slot', 'default')
            && old.accountKey !== hashKey(entry.id, 'account-slot', `slot:${old.id}`)
            && provesServer(old.accountKey, old.values, old.accountKeyAliases))));
        const provenNow = Boolean(provider?.accountKey && provesServer
          && provesServer(provider.accountKey, candidate, provider.accountKeyAliases || []));
        // A key this slot has been before (an alias) is its own account coming back.
        const different = oldProven && provenNow && key !== old.accountKey && !old.accountKeyAliases.includes(key);
        // Two proven server accounts never share a slot: the caller adds the
        // new one as its own account instead, so no history is handed on.
        if (different) {
          rejected = { saved: false, verdict: 'differentAccount', status: 'differentAccount' };
          return;
        }
        const timestamp = new Date(now()).toISOString();
        const record = { id: old?.id || randomUUID(), label: old ? old.label : label, enabled: old?.enabled !== false,
          values: candidate, accountKey: key,
          accountKeyAliases: [...new Set([...(old?.accountKeyAliases || []),
            ...(old?.accountKey && old.accountKey !== key ? [old.accountKey] : []), ...(provider?.accountKeyAliases || [])])].filter(alias => alias !== key).slice(-8),
          // The proof outlives an unproven answer (Qoder without a user id).
          serverIdentity: provenNow || oldProven,
          createdAt: old?.createdAt || timestamp, updatedAt: timestamp };
        await commit(entry, old ? previous.map(slot => slot.id === old.id ? record : slot) : [...previous, record], true, true, true);
          if (!old && record.label) {
            const account = dto(entry).find(slot => slot.id === record.id);
            const operations = [{ provider: providerId, type: 'rename', key: account.accountKey, label: account.label }];
            const { replayPresentation } = require('./accountPresentationSync');
            await write({ limitAccountPresentation: replayPresentation(getSettings().limitAccountPresentation, operations) });
            publishPresentation(operations);
          }
      };
      const commands = createCredentialCommands({ getSettings, env: {},
        probeDeps: () => ({ ...probeDeps(), probe: true, providerRuntimeState: new Map(), env: {} }),
        commitCredential
      });
      if (!values || typeof values !== 'object' || Array.isArray(values)) return { saved: false, verdict: 'invalid', status: 'required' };
      const draft = Object.fromEntries(accountForm(entry).fields.map(field => [field.key,
        Object.hasOwn(values, field.key) ? values[field.key]
          // A replacement changes only what it names; everything else stays the account's own.
          : old && Object.hasOwn(old.values, field.key) ? old.values[field.key]
          : field.secret ? '' : entry.fields.find(item => item.key === field.key)?.configDefault || '']));
      const result = verified
        ? (await commitCredential({ candidate: draft, provider: verified }), { saved: true, verdict: 'valid', status: 'ok' })
        : await commands.saveCredential(providerId, draft, { includeIndependentSettings: true });
      if (rejected) return rejected;
      // Fetchers may throw arbitrary error codes; only the validator's bounded
      // verdict/status vocabulary is exposed by this API.
      return { saved: result.saved, verdict: result.verdict,
        status: ['ok', 'unauthorized', 'notConfigured', 'required', 'invalidFormat'].includes(result.status) ? result.status : 'unavailable',
        accounts: dto(entry) };
    }).catch(() => failure('credentialStorageUnavailable'));
  }
  function mutate(providerId, id, operation, value) {
    return serialize(async () => {
      const entry = entryFor(providerId);
      if (!entry) return failure('unsupportedProvider');
      if (operation === 'move' && ['up', 'down'].includes(value)) {
        const rows = visible(entry);
        const index = rows.findIndex(item => item.id === id);
        if (index < 0) return failure('accountNotFound');
        const target = index + (value === 'up' ? -1 : 1);
        if (target < 0 || target >= rows.length) return list(providerId);
        [rows[index], rows[target]] = [rows[target], rows[index]];
        // Hidden duplicate owners follow the visible list without displacing
        // the neighbour the user chose. Preserve every saved credential.
        const all = [...rows, ...ordered(entry).filter(item => !rows.some(row => row.id === item.id))];
        const metadata = { ...(getSettings()[`${entry.id}AmbientAccounts`] || {}) };
        const patch = { [accountSlotKey(entry)]: all.filter(item => !item.source) };
        all.forEach((item, order) => {
          if (item.source === 'discovered') metadata[item.fingerprint] = { accountKey: item.accountKey, accountKeyAliases: item.accountKeyAliases, accountName: item.accountName, accountEmail: item.accountEmail, sourceName: item.sourceName, label: item.label, enabled: item.enabled, order };
          if (item.source === 'environment') patch[defaultIdentityKey(entry)] = { ...getSettings()[defaultIdentityKey(entry)], order };
        });
        if (entry.discoveredAccounts) patch[`${entry.id}AmbientAccounts`] = metadata;
        await write(patch);
        changed(entry, [], false);
        return list(providerId);
      }
      const external = ordered(entry).find(item => item.id === id && item.source);
      if (external?.source === 'discovered') {
        if (!['rename', 'enabled'].includes(operation)) return failure('environmentCredential');
        const metadata = { ...(getSettings()[`${entry.id}AmbientAccounts`] || {}) };
        const record = { ...metadata[external.fingerprint], order: external.order, accountKey: external.accountKey, accountKeyAliases: external.accountKeyAliases, label: external.label, enabled: external.enabled };
        if (operation === 'rename' && typeof value === 'string') record.label = value;
        else if (operation === 'enabled' && typeof value === 'boolean') record.enabled = value;
        else return failure('invalidOperation');
        metadata[external.fingerprint] = record;
        // One control record per account: drop records left by an earlier token.
        for (const [fingerprint, item] of Object.entries(metadata)) if (fingerprint !== external.fingerprint && item?.accountKey === external.accountKey) delete metadata[fingerprint];
        await write({ [`${entry.id}AmbientAccounts`]: metadata });
        // A key another enabled owner (saved or environment) still holds is not retired.
        const keys = [external.accountKey, ...(external.accountKeyAliases || [])];
        const stillOwned = ordered(entry).some(item => item.id !== external.id && item.enabled !== false
          && [item.accountKey, ...(item.accountKeyAliases || [])].some(key => keys.includes(key)));
        changed(entry, operation === 'enabled' && !value && !stillOwned ? [external.accountKey] : [], operation === 'enabled');
        return list(providerId);
      }
      if (id === 'environment') return failure('environmentCredential');
      const next = slots(entry);
      const index = next.findIndex(slot => slot.id === id);
      if (index < 0) return failure('accountNotFound');
      if (operation === 'remove') next.splice(index, 1);
      else if (operation === 'rename' && typeof value === 'string') next[index].label = value;
      else if (operation === 'enabled' && typeof value === 'boolean') next[index].enabled = value;
      else return failure('invalidOperation');
      if (operation !== 'remove') next.find(slot => slot.id === id).updatedAt = new Date(now()).toISOString();
      await commit(entry, next, true, operation !== 'rename' && operation !== 'move');
      if (operation === 'rename' || operation === 'move') {
        const accounts = operation === 'move' ? next.map(item => dto(entry).find(slot => slot.id === item.id)) : dto(entry);
        const slot = accounts.find(slot => slot.id === id);
        const operations = operation === 'rename'
          ? [{ provider: providerId, type: 'rename', key: slot.accountKey, label: slot.label }]
          : [{ provider: providerId, type: 'order', order: accounts.map(slot => slot.accountKey) }];
        const { replayPresentation } = require('./accountPresentationSync');
        await write({ limitAccountPresentation: replayPresentation(getSettings().limitAccountPresentation, operations) });
        publishPresentation(operations);
      }
      return list(providerId);
    }).catch(() => failure('credentialStorageUnavailable'));
  }
  function presentation(providerId, accountKey, operation, value) {
    return serialize(async () => {
      const entry = entryFor(providerId);
      if (!entry || !validKey(accountKey)) return failure('invalidOperation');
      const all = normalizeAccountPresentation(getSettings().limitAccountPresentation);
      const group = all[providerId] || { labels: {}, order: [] };
      if (operation === 'rename' && typeof value === 'string') group.labels = { ...group.labels, [accountKey]: value };
      else if (operation === 'order' && Array.isArray(value) && value.every(validKey)) group.order = value;
      else return failure('invalidOperation');
      const next = normalizeAccountPresentation({ ...all, [providerId]: group });
      await write({ limitAccountPresentation: next });
      publishPresentation([operation === 'rename'
        ? { provider: providerId, type: 'rename', key: accountKey, label: next[providerId]?.labels[accountKey] || '' }
        : { provider: providerId, type: 'order', order: next[providerId].order }]);
      changed(entry, [], false);
      return { ...list(providerId), presentation: getSettings().limitAccountPresentation };
    }).catch(() => failure('settingsStorageUnavailable'));
  }
  function resolved(providerId, id, identity, dispatchedValues) {
    return serialize(async () => {
      const entry = entryFor(providerId);
      if (!entry) return false;
      const fingerprint = accountValuesFingerprint(dispatchedValues);
      if (id === 'environment') {
        if (fingerprint !== accountValuesFingerprint(defaultAccountValues(entry, getSettings(), env))) return false;
        environmentIdentities.set(entry.id, { fingerprint, identity });
        return true;
      }
      if (id?.startsWith('discovered-')) {
        const current = ambient(entry).find(item => item.id === id);
        if (!current || fingerprint !== current.fingerprint) return false;
        const metadata = { ...(getSettings()[`${entry.id}AmbientAccounts`] || {}) };
        // A rotated token keeps the account's name, pause and position.
        const previous = metadata[fingerprint] || Object.values(metadata).find(item => item?.accountKey === identity.accountKey || item?.accountKeyAliases?.includes(identity.accountKey)) || current;
        const nextIdentity = { label: previous.label, enabled: previous.enabled, order: previous.order, ...metadata[fingerprint], ...identity, sourceName: current.sourceName };
        for (const [key, item] of Object.entries(metadata)) if (key !== fingerprint && item?.accountKey === identity.accountKey) delete metadata[key];
        if (JSON.stringify(metadata[fingerprint]) === JSON.stringify(nextIdentity)) return true;
        metadata[fingerprint] = nextIdentity;
        await write({ [`${entry.id}AmbientAccounts`]: metadata });
        return true;
      }
      if (!id) return false;
      const next = slots(entry);
      const slot = next.find(item => item.id === id);
      if (!slot || !slot.enabled || fingerprint !== accountValuesFingerprint(slot.values)) return false;
      const provesServer = entry.serverAccountKey && entry.limits[entry.serverAccountKey];
      const proven = Boolean(provesServer && identity.accountKey !== hashKey(entry.id, 'account-slot', 'default')
        && identity.accountKey !== hashKey(entry.id, 'account-slot', `slot:${slot.id}`)
        && provesServer(identity.accountKey, slot.values, identity.accountKeyAliases || []));
      slot.serverIdentity = proven || slot.serverIdentity;
      const previousKey = slot.accountKey || hashKey(entry.id, 'account-slot', `slot:${slot.id}`);
      const labels = getSettings().limitAccountPresentation?.[providerId]?.labels || {};
      const label = Object.hasOwn(labels, previousKey) ? labels[previousKey] : slot.label;
      Object.assign(slot, identity);
      await commit(entry, next, false);
      const order = getSettings().limitAccountPresentation?.[providerId]?.order || [];
      const operations = [];
      if (slot.accountKey && slot.accountKey !== previousKey && (label || Object.hasOwn(labels, previousKey)) && !Object.hasOwn(labels, slot.accountKey)) {
        operations.push({ provider: providerId, type: 'rename', key: slot.accountKey, label });
      }
      // The resolved key takes over the provisional key's saved position.
      if (slot.accountKey && slot.accountKey !== previousKey && order.includes(previousKey) && !order.includes(slot.accountKey)) {
        operations.push({ provider: providerId, type: 'order', order: order.map(key => key === previousKey ? slot.accountKey : key) });
      }
      if (operations.length) {
        const { replayPresentation } = require('./accountPresentationSync');
        await write({ limitAccountPresentation: replayPresentation(getSettings().limitAccountPresentation, operations) });
        publishPresentation(operations);
      }
      return true;
    });
  }
  // Provider owns authentication and returns a main-only verified draft. The
  // fence is checked again inside the same serialized lane as every slot write.
  async function loginAction(providerId, produce) {
    const draft = await produce();
    return save(providerId, draft.values, { verified: draft.identity, isCurrent: draft.isCurrent, label: draft.label });
  }
  // A shared name (including an explicit blank) becomes the local slot label,
  // so readings projected from the slot carry the same name. Not republished.
  function adoptSharedLabels(shared) {
    return serialize(async () => {
      for (const [providerId, group] of Object.entries(shared || {})) {
        const entry = entryFor(providerId);
        if (!entry) continue;
        const labels = group?.labels || {};
        const next = slots(entry);
        let changedAny = false;
        for (const slot of next) {
          if (!slot.accountKey || !Object.hasOwn(labels, slot.accountKey) || labels[slot.accountKey] === slot.label) continue;
          slot.label = labels[slot.accountKey];
          changedAny = true;
        }
        if (changedAny) await commit(entry, next, true, false);
      }
    }).catch(() => {});
  }
  return { list, loginAction, presentation, adoptSharedLabels, add: (provider, values, label) => save(provider, values, { label }),
    replace: (provider, id, values) => save(provider, values, { replacing: true, id }),
    rename: (provider, id, label) => mutate(provider, id, 'rename', label),
    setEnabled: (provider, id, enabled) => mutate(provider, id, 'enabled', enabled),
    remove: (provider, id) => mutate(provider, id, 'remove'),
    move: (provider, id, direction) => mutate(provider, id, 'move', direction), resolved };
}
// Main and integration tests use the same settings-change invalidation path.
function invalidateAccountSlotChange(runtime, provider, { retiredAccountKeys = [] } = {}) {
  // Enqueue the provider refresh synchronously after clearing, fencing an old
  // provider-wide dispatch before it can republish the retired account.
  const clears = retiredAccountKeys.map(accountKey => runLimitInvalidation(runtime,
    { provider, accountKey }, 'settings-change', { clear: true, refresh: false }));
  const refresh = runLimitInvalidation(runtime, { provider }, 'settings-change', { clear: false });
  return Promise.all([...clears, refresh]).then(results => results.at(-1));
}
module.exports = { createAccountSlotService, invalidateAccountSlotChange };
