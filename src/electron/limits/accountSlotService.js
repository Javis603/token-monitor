'use strict';

const { ambientAccounts } = require('../../shared/limits/ambientAccounts');
const { accountSelectionKey } = require('../../shared/limits/accountScope');
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
function createAccountSlotService({ getSettings, write, onChanged, onPresentation, probeDeps, owners = {}, ownerWrite, presentationAccounts = () => [], env = process.env, now = Date.now }) {
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
  const sameAccount = (a, b) => Boolean(a?.accountKey && b?.accountKey && (a.accountKey === b.accountKey
    || a.accountKeyAliases?.includes(b.accountKey) || b.accountKeyAliases?.includes(a.accountKey)));
  const slotPresentationKey = (entry, slot, key = slot.accountKey || hashKey(entry.id, 'account-slot', slot.source ? 'default' : `slot:${slot.id}`)) =>
    accountSelectionKey(entry.id, key, entry.id === 'alibaba' ? accountVariant(entry, slot) : '');
  const slotPresentationAliases = (entry, slot) =>
    (slot.accountKeyAliases || []).map(key => slotPresentationKey(entry, slot, key));
  const slots = (entry, order = getSettings().limitAccountPresentation?.[entry.id]?.order || []) => {
    const rank = slot => {
      const canonical = order.indexOf(slotPresentationKey(entry, slot));
      const index = canonical >= 0 ? canonical : order.findIndex(key => slotPresentationAliases(entry, slot).includes(key));
      return index < 0 ? order.length : index;
    };
    return normalizeAccountSlots(entry, getSettings()[accountSlotKey(entry)]).sort((a, b) => rank(a) - rank(b));
  };
  function localLabels(providerId) {
    const entry = entryFor(providerId);
    if (!entry) return [];
    return slots(entry).flatMap(slot => {
      const label = slot.localLabel ?? slot.label;
      return label ? [{ provider: providerId, type: 'rename', key: slotPresentationKey(entry, slot), label }] : [];
    });
  }
  const environment = entry => {
    const values = defaultAccountValues(entry, getSettings(), env);
    const cached = environmentIdentities.get(entry.id);
    const identity = cached?.fingerprint === accountValuesFingerprint(values) ? cached.identity : {};
    const credentialKey = accountCredentialKey(entry, values);
    const credential = values[credentialKey];
    return credentialKey && !getSettings()[credentialKey] ? { id: 'environment', label: '', enabled: true, source: 'environment', values, accountKey: hashKey(entry.id, credential), ...identity } : null;
  };
  const ambient = entry => ambientAccounts(entry, getSettings(), { ...probeDeps?.(), env });
  const ordered = (entry, list = slots(entry)) => {
    const rows = orderAccountRows(list, ambient(entry),
      environment(entry) ? { ...environment(entry), order: getSettings()[defaultIdentityKey(entry)]?.order } : null);
    const order = getSettings().limitAccountPresentation?.[entry.id]?.order || [];
    const rank = row => {
      const canonical = order.indexOf(slotPresentationKey(entry, row));
      const index = canonical >= 0 ? canonical : order.findIndex(key => slotPresentationAliases(entry, row).includes(key));
      return index < 0 ? order.length : index;
    };
    return rows.sort((a, b) => rank(a) - rank(b));
  };
  // Saved plans do not inherit the environment lane's variant. Keep the raw
  // values for fingerprints and resolve only the plan used for presentation.
  const accountVariant = (entry, account) => entry.id === 'alibaba'
    ? entry.limits.alibabaVariant(account.values, account.source === 'environment' ? env : {}) : '';
  const sameVisibleAccount = (entry, item, other) => (other.source || item.source)
    && other.enabled !== false && item.enabled !== false && accountVariant(entry, other) === accountVariant(entry, item) && sameAccount(other, item);
  function accountRows(entry) {
    const primary = [];
    const rows = [];
    for (const account of ordered(entry)) {
      const representative = primary.find(other => sameVisibleAccount(entry, account, other));
      if (!representative) {
        primary.push(account);
        rows.push(account);
      } else if ((representative.source === 'discovered' && !account.source)
        || (!representative.source && account.source === 'discovered')) {
        // Use one account identity for presentation, with a separate edit and
        // removal target for each saved credential.
        rows.push({ ...account, credentialFor: representative.id });
      }
    }
    return { primary, rows };
  }
  function dto(entry) {
    return accountRows(entry).rows.map(({ id, label, enabled, accountKey, accountKeyAliases = [], values, fingerprint, source, sourceName, accountName, accountEmail, createdAt, updatedAt, credentialFor }) => {
    const key = accountKey || hashKey(entry.id, 'account-slot', source ? 'default' : `slot:${id}`);
    const formValues = Object.fromEntries(accountForm(entry).fields.filter(field => !field.secret).map(field => [field.key, values[field.key]]));
    if (entry.id === 'alibaba' && source === 'environment') formValues.alibabaVariant = accountVariant(entry, { values, source });
    return { id, label, enabled, accountKey: key, accountKeyAliases, ...(source ? { source } : {}),
      ...(credentialFor ? { credentialFor } : {}),
      ...(accountName ? { accountName } : {}),
      ...(source === 'discovered' ? { sourceName, accountName, accountEmail } : {}),
      ...(entry.accountSlotOwner ? { capabilities: { rename: true, move: true, remove: true, pause: true, edit: true }, accountEmail: values?.accountEmail || '' } : {}),
      ...(entry.id === 'alibaba' ? { presentationKey: slotPresentationKey(entry, { id, source, accountKey, values }) } : {}),
      formValues,
      fingerprint: (source === 'discovered' ? fingerprint : accountValuesFingerprint(values)).slice(7, 19), createdAt, updatedAt };
    });
  }
  const failure = (errorCode) => ({ ok: false, errorCode });
  const slotLimit = 21;
  const capacityFailure = () => ({ ...failure('slotLimit'), limit: slotLimit });
  // `refresh: false`: only local presentation changed (label, order), so the
  // runtime re-projects its rows without asking the provider again.
  const changed = (entry, retiredAccountKeys, refresh) => {
    try { Promise.resolve(onChanged?.(entry.id, { retiredAccountKeys, refresh })).catch(() => {}); } catch (_) { /* Durable save already succeeded. */ }
  };
  async function commit(entry, next, notify = true, refresh = true, activate = false) {
    const previous = ordered(entry);
    const normalized = normalizeAccountSlots(entry, next);
    const keys = slot => [slot.accountKey || hashKey(entry.id, 'account-slot', slot.source ? 'default' : `slot:${slot.id}`), ...(slot.accountKeyAliases || []), ...(entry.limits?.accountSlotKeys?.(slot.values) || [])];
    const active = ordered(entry, [...normalized]).filter(slot => slot.enabled);
    const fixedKeys = entry.limits?.accountSlotKeys?.(getSettings(), env) || [];
    const owned = new Set([...active.flatMap(keys), ...fixedKeys]);
    const retiredAccountKeys = [...new Set(previous.filter(slot => slot.enabled
      && !active.some(item => item.id === slot.id)).flatMap(keys))].filter(key => !owned.has(key));
    // A saved credential turns collection on for its provider, as the fixed
    // credential form always did.
    await write({ [accountSlotKey(entry)]: normalized, ...(activate ? {
      limitProviders: providerSelectionIncluding(getSettings().limitProviders, entry.id), limitsEnabled: true } : {}) });
    if (notify) changed(entry, retiredAccountKeys, refresh);
  }
  // An account whose key changes (resolution or a replaced credential) keeps
  // its shared name and position under the new key.
  async function migratePresentationKey(providerId, previousKey, nextKey, fallbackLabel = '') {
    if (!nextKey || nextKey === previousKey) return;
    const group = getSettings().limitAccountPresentation?.[providerId] || {};
    const labels = group.labels || {};
    const order = group.order || [];
    const label = Object.hasOwn(labels, previousKey) ? labels[previousKey] : fallbackLabel;
    const operations = [];
    if ((label || Object.hasOwn(labels, previousKey)) && !Object.hasOwn(labels, nextKey)) operations.push({ provider: providerId, type: 'rename', key: nextKey, label });
    if (order.includes(previousKey) && !order.includes(nextKey)) operations.push({ provider: providerId, type: 'order', order: order.map(key => key === previousKey ? nextKey : key) });
    if (!operations.length) return;
    const { replayPresentation } = require('./accountPresentationSync');
    await write({ limitAccountPresentation: replayPresentation(getSettings().limitAccountPresentation, operations) });
    publishPresentation(operations);
  }
  function list(providerId) {
    const entry = entryFor(providerId);
    return entry ? { ok: true, accounts: dto(entry) } : failure('unsupportedProvider');
  }
  function save(providerId, values, { replacing = false, id, label = '', verified, isCurrent = () => true } = {}) {
    return serialize(async () => {
      const entry = entryFor(providerId);
      if (!entry) return failure('unsupportedProvider');
      if (entry.accountSlotOwner) return failure('providerEditorRequired');
      if (!isCurrent()) return failure('cancelled');
      if (id === 'environment' || id?.startsWith('discovered-')) return failure('environmentCredential');
      const previous = slots(entry);
      let old = replacing ? previous.find(slot => slot.id === id) : null;
      if (replacing && !old) return failure('accountNotFound');
      if (!replacing && !entry.dedupeAccounts && previous.length >= slotLimit) return capacityFailure();
      let rejected;
      // Reuse the fixed credential validator, including transport isolation and
      // unauthorized/indeterminate verdicts. Never return its settings payload.
      const commitCredential = async ({ candidate, provider }) => {
        if (!isCurrent()) throw new Error('Login cancelled');
        if (entry.limits?.accountSlotIsSecondary?.(provider, candidate, {})) provider = null;
        if (!old && entry.dedupeAccounts) old = previous.find(slot => slot.accountKey === provider?.accountKey || accountValuesFingerprint(slot.values) === accountValuesFingerprint(candidate));
        if (!old && previous.length >= slotLimit) {
          rejected = capacityFailure();
          return;
        }
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
        const accountName = provider?.accountName || (key === old?.accountKey ? old?.accountName : '');
        const record = { id: old?.id || randomUUID(), label: old ? old.label : label, enabled: old?.enabled !== false,
          values: candidate, accountKey: key,
          ...(old?.localLabel !== undefined ? { localLabel: old.localLabel } : {}),
          ...(accountName ? { accountName } : {}),
          accountKeyAliases: [...new Set([...(old?.accountKeyAliases || []),
            ...(old?.accountKey && old.accountKey !== key ? [old.accountKey] : []), ...(provider?.accountKeyAliases || [])])].filter(alias => alias !== key).slice(-8),
          // The proof outlives an unproven answer (Qoder without a user id).
          serverIdentity: provenNow || oldProven,
          createdAt: old?.createdAt || timestamp, updatedAt: timestamp };
        const previousKey = old ? slotPresentationKey(entry, old) : '';
        await commit(entry, old ? previous.map(slot => slot.id === old.id ? record : slot) : [...previous, record], true, true, true);
        // Discovery may hide this slot from the visible list. Presentation still
        // belongs to its committed identity and normalized label.
        const account = slots(entry).find(slot => slot.id === record.id);
        const accountKey = slotPresentationKey(entry, account);
        if (old) await migratePresentationKey(providerId, previousKey, accountKey, old.label);
        if (!old && account.label) {
          const operations = [{ provider: providerId, type: 'rename', key: accountKey, label: account.label }];
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
    if (owners[providerId] && ['remove', 'enabled'].includes(operation)) return owners[providerId](id, operation, value);
    return serialize(async () => {
      const entry = entryFor(providerId);
      if (!entry) return failure('unsupportedProvider');
      if (operation === 'move' && ['up', 'down'].includes(value)) {
        const rows = accountRows(entry).primary;
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
        const operations = [{ provider: providerId, type: 'order', order: rows.map(row => slotPresentationKey(entry, row)) }];
        const { replayPresentation } = require('./accountPresentationSync');
        await write({ ...patch, limitAccountPresentation: replayPresentation(getSettings().limitAccountPresentation, operations) });
        publishPresentation(operations);
        changed(entry, [], false);
        return list(providerId);
      }
      const external = ordered(entry).find(item => item.id === id && item.source);
      if (external?.source === 'discovered') {
        if (!['rename', 'enabled'].includes(operation)) return failure('environmentCredential');
        const metadata = { ...(getSettings()[`${entry.id}AmbientAccounts`] || {}) };
        const record = { ...metadata[external.fingerprint], order: external.order, accountKey: external.accountKey, accountKeyAliases: external.accountKeyAliases, accountName: external.accountName, accountEmail: external.accountEmail, sourceName: external.sourceName, label: external.label, enabled: external.enabled };
        if (operation === 'rename' && typeof value === 'string') record.label = value;
        else if (operation === 'enabled' && typeof value === 'boolean') record.enabled = value;
        else return failure('invalidOperation');
        metadata[external.fingerprint] = record;
        // One control record per account: drop records left by an earlier token.
        for (const [fingerprint, item] of Object.entries(metadata)) if (fingerprint !== external.fingerprint && sameAccount(item, external)) delete metadata[fingerprint];
        const operations = operation === 'rename' ? [{ provider: providerId, type: 'rename', key: external.accountKey, label: value }] : [];
        const { replayPresentation } = require('./accountPresentationSync');
        await write({ [`${entry.id}AmbientAccounts`]: metadata,
          ...(operations.length ? { limitAccountPresentation: replayPresentation(getSettings().limitAccountPresentation, operations) } : {}) });
        if (operations.length) publishPresentation(operations);
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
      else if (operation === 'rename' && typeof value === 'string') {
        next[index].label = value;
        delete next[index].localLabel;
      }
      else if (operation === 'enabled' && typeof value === 'boolean') next[index].enabled = value;
      else return failure('invalidOperation');
      if (operation !== 'remove') next.find(slot => slot.id === id).updatedAt = new Date(now()).toISOString();
      await commit(entry, next, true, operation !== 'rename');
      if (operation === 'rename') {
        const slot = slots(entry).find(slot => slot.id === id);
        const operations = [{ provider: providerId, type: 'rename',
          key: slotPresentationKey(entry, slot), label: slot.label }];
        const { replayPresentation } = require('./accountPresentationSync');
        await write({ limitAccountPresentation: replayPresentation(getSettings().limitAccountPresentation, operations) });
        publishPresentation(operations);
      }
      return list(providerId);
    }).catch(() => failure('credentialStorageUnavailable'));
  }
  // Persist controls for source-owned rows too, so an offline restart has the
  // same local subsequence even before the shared document is loaded.
  function sourcePresentationPatch(entry, group) {
    const patch = {};
    const metadata = { ...(getSettings()[`${entry.id}AmbientAccounts`] || {}) };
    const rows = ordered(entry);
    const keyOf = row => slotPresentationKey(entry, row);
    const canonicalKeys = new Set(rows.map(keyOf));
    // Remote-only keys and old aliases occupy no position in the local list.
    const sharedOrder = group.order || [];
    const localOrder = [...new Set(sharedOrder.map(key => rows.find(row => keyOf(row) === key)
      || rows.find(row => !sharedOrder.includes(keyOf(row)) && slotPresentationAliases(entry, row).includes(key))).filter(Boolean))];
    for (const row of rows.filter(row => row.source)) {
      const labelKey = [keyOf(row), ...slotPresentationAliases(entry, row).filter(key => !canonicalKeys.has(key))]
        .find(key => Object.hasOwn(group.labels || {}, key));
      const order = localOrder.indexOf(row);
      if (row.source === 'discovered') metadata[row.fingerprint] = { ...metadata[row.fingerprint],
        accountKey: row.accountKey, accountKeyAliases: row.accountKeyAliases, accountName: row.accountName,
        accountEmail: row.accountEmail, sourceName: row.sourceName, enabled: row.enabled,
        label: labelKey === undefined ? row.label : group.labels[labelKey], order: order < 0 ? row.order : order };
      else if (order >= 0) patch[defaultIdentityKey(entry)] = { ...getSettings()[defaultIdentityKey(entry)], order };
    }
    if (entry.discoveredAccounts) patch[`${entry.id}AmbientAccounts`] = metadata;
    return patch;
  }
  function presentation(providerId, accountKey, operation, value) {
    return serialize(async () => {
      const registered = limitProviderEntry(providerId);
      const entry = entryFor(providerId);
      if (!registered || operation !== 'order' && !validKey(accountKey)) return failure('invalidOperation');
      if (!entry) {
        // Source-owned accounts expose presentation only, proven by main's current metadata.
        const canonical = new Set(await presentationAccounts(providerId));
        if (operation === 'rename' && (typeof value !== 'string' || value.length > 256 || !canonical.has(accountKey))) return failure('invalidOperation');
        if (operation === 'order' && (!Array.isArray(value) || value.length > 200 || new Set(value).size !== value.length || !value.every(key => validKey(key) && canonical.has(key)))) return failure('invalidOperation');
        if (!['rename', 'order'].includes(operation)) return failure('invalidOperation');
        const { replayPresentation } = require('./accountPresentationSync');
        const operations = [{ provider: providerId, type: operation, ...(operation === 'rename' ? { key: accountKey, label: value } : { order: value }) }];
        await write({ limitAccountPresentation: replayPresentation(getSettings().limitAccountPresentation, operations) });
        publishPresentation(operations);
        changed(registered, [], false);
        return { ok: true, presentation: getSettings().limitAccountPresentation };
      }
      const all = normalizeAccountPresentation(getSettings().limitAccountPresentation);
      const group = all[providerId] || { labels: {}, order: [] };
      if (operation === 'rename' && typeof value === 'string') group.labels = { ...group.labels, [accountKey]: value };
      else if (operation === 'order' && Array.isArray(value) && value.every(validKey)) group.order = value;
      else return failure('invalidOperation');
      const next = normalizeAccountPresentation({ ...all, [providerId]: group });
      const local = slots(entry, next[providerId].order);
      const stored = normalizeAccountSlots(entry, getSettings()[accountSlotKey(entry)]);
      if (operation === 'rename' && !Object.hasOwn(next[providerId]?.labels || {}, accountKey)) return failure('invalidOperation');
      const renamed = operation === 'rename' && local.find(slot => slotPresentationKey(entry, slot) === accountKey);
      if (renamed) {
        renamed.label = next[providerId]?.labels[accountKey] || '';
        delete renamed.localLabel;
      }
      const reordered = local.some((slot, index) => slot.id !== stored[index]?.id);
      await write({ ...sourcePresentationPatch(entry, next[providerId]), limitAccountPresentation: next, ...(renamed || reordered ? { [accountSlotKey(entry)]: local } : {}) });
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
        const previous = dto(entry).find(item => item.id === 'environment');
        const previousKey = previous?.presentationKey || previous?.accountKey || '';
        environmentIdentities.set(entry.id, { fingerprint, identity });
        await migratePresentationKey(providerId, previousKey, accountSelectionKey(entry.id, identity.accountKey, previous?.formValues.alibabaVariant));
        return true;
      }
      if (id?.startsWith('discovered-')) {
        const current = ambient(entry).find(item => item.id === id);
        if (!current || fingerprint !== current.fingerprint) return false;
        const metadata = { ...(getSettings()[`${entry.id}AmbientAccounts`] || {}) };
        // A rotated token keeps the account's name, pause and position.
        const previous = metadata[fingerprint] || Object.values(metadata).find(item => sameAccount(item, identity)) || current;
        const nextIdentity = { label: previous.label, enabled: previous.enabled, order: previous.order, ...metadata[fingerprint], ...identity, sourceName: current.sourceName };
        let retired = false;
        for (const [key, item] of Object.entries(metadata)) if (key !== fingerprint && sameAccount(item, identity)) {
          delete metadata[key];
          retired = true;
        }
        if (!retired && JSON.stringify(metadata[fingerprint]) === JSON.stringify(nextIdentity)) return true;
        metadata[fingerprint] = nextIdentity;
        await write({ [`${entry.id}AmbientAccounts`]: metadata });
        await migratePresentationKey(providerId, current.accountKey, identity.accountKey, previous.label);
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
      const previousKey = slotPresentationKey(entry, slot);
      const label = slot.label;
      // A missing provider name is not an explicit clear. Keep it only while
      // this remains the same identity; another account cannot inherit it.
      const accountName = identity.accountName || (identity.accountKey === slot.accountKey ? slot.accountName : '');
      Object.assign(slot, identity);
      if (accountName) slot.accountName = accountName;
      else delete slot.accountName;
      await commit(entry, next, false);
      await migratePresentationKey(providerId, previousKey, slotPresentationKey(entry, slot), label);
      return true;
    });
  }
  function renew({ provider, slotId, field, previous, value, values }) {
    return serialize(async () => {
      const entry = entryFor(provider);
      if (!entry || !slotId || slotId === 'environment'
        || !entry.fields.some(item => item.key === field && item.kind === 'credential')) return false;
      const next = slots(entry);
      const slot = next.find(item => item.id === slotId);
      if (!slot || !slot.enabled || accountValuesFingerprint(slot.values) !== accountValuesFingerprint(values)) return false;
      const expected = normalizeAccountField(field, previous);
      const renewed = normalizeAccountField(field, value);
      if (!expected || !renewed || normalizeAccountField(field, slot.values[field]) !== expected) return false;
      slot.values = { ...slot.values, [field]: renewed };
      slot.updatedAt = new Date(now()).toISOString();
      await commit(entry, next, false);
      return true;
    });
  }
  // Provider owns authentication and returns a main-only verified draft. The
  // fence is checked again inside the same serialized lane as every slot write.
  async function loginAction(providerId, produce) {
    const draft = await produce();
    return save(providerId, draft.values, { verified: draft.identity, isCurrent: draft.isCurrent, label: draft.label });
  }
  // Adopt shared labels and persist the local order for offline restarts.
  // Incoming presentation changes are not republished.
  function adoptSharedLabels(shared) {
    const expectedGroups = Object.fromEntries(Object.keys(shared || {}).map(providerId =>
      [providerId, JSON.stringify(getSettings().limitAccountPresentation?.[providerId] || {})]));
    return serialize(async () => {
      for (const [providerId, group] of Object.entries(shared || {})) {
        const entry = entryFor(providerId);
        if (!entry || JSON.stringify(getSettings().limitAccountPresentation?.[providerId] || {})
          !== expectedGroups[providerId]) continue;
        const labels = group?.labels || {};
        const next = slots(entry, group?.order || []);
        const stored = normalizeAccountSlots(entry, getSettings()[accountSlotKey(entry)]);
        let changedAny = next.some((slot, index) => slot.id !== stored[index]?.id);
        const canonicalKeys = new Set(ordered(entry, next).map(row => slotPresentationKey(entry, row)));
        for (const slot of next) {
          // A retired alias may now be another local account's canonical key.
          const labelKey = [slotPresentationKey(entry, slot), ...slotPresentationAliases(entry, slot).filter(key => !canonicalKeys.has(key))]
            .find(key => Object.hasOwn(labels, key));
          if (!slot.accountKey || labelKey === undefined || labels[labelKey] === slot.label) continue;
          slot.localLabel ??= slot.label;
          slot.label = labels[labelKey];
          changedAny = true;
        }
        const sourcePatch = sourcePresentationPatch(entry, group);
        const sourceChanged = Object.entries(sourcePatch).some(([key, value]) => JSON.stringify(getSettings()[key]) !== JSON.stringify(value));
        if (sourceChanged) await write(sourcePatch);
        if (changedAny) await commit(entry, next, true, false);
        else if (sourceChanged) changed(entry, [], false);
      }
    }).catch(() => {});
  }
  // Provider workflows execute their fences inside this same persistence lane.
  function ownerTransaction(providerId, produce, preferences = {}) {
    return serialize(async () => {
      const entry = entryFor(providerId);
      if (!entry?.accountSlotOwner) throw new Error('Unsupported account owner');
      const plan = await produce(slots(entry));
      const next = Array.isArray(plan) ? plan : plan.slots;
      if (next.length > 21) throw new Error('Account slot limit');
      const normalized = normalizeAccountSlots(entry, next);
      if (normalized.length !== next.length) throw new Error('Invalid account slot transaction');
      const patch = { ...(typeof preferences === 'function' ? preferences() : preferences), [accountSlotKey(entry)]: normalized };
      const { legacyMetadata, legacyWrites } = Array.isArray(plan) ? {} : plan;
      if (ownerWrite) await ownerWrite(providerId, patch, legacyMetadata, legacyWrites);
      else {
        if (legacyMetadata !== undefined) throw new Error('Legacy account transaction unavailable');
        await write(patch);
      }
      return true;
    });
  }
  return { ownerTransaction, list, localLabels, renew, loginAction, presentation, adoptSharedLabels, add: (provider, values, label) => save(provider, values, { label }),
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
