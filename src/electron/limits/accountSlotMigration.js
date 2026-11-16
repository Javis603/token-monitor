'use strict';
const { isDeepStrictEqual } = require('node:util');
const { randomUUID } = require('node:crypto');
const { hashKey } = require('../../shared/hashKey');
const { LIMIT_PROVIDER_REGISTRY } = require('../../shared/limits/registry');
const { accountSlotKey, defaultIdentityKey, defaultAccountValues, accountValuesFingerprint, normalizeAccountSlots } = require('../../shared/limits/accountSlots');

const ACCOUNT_SLOT_MIGRATION_VERSION = 1;

// One-time per provider, recorded in the document's `migrations` like the
// store's other migrations, so a provider that opts in later migrates once too.
// Read the real document before every write: invalid/unsupported/symlinked
// stores must throw, never become an empty replacement.
function migrateAccountSlots(store, settings, now = Date.now, env = process.env) {
  for (const entry of LIMIT_PROVIDER_REGISTRY.filter(entry => entry.accountSlots)) {
    let document = store.readDocument();
    if (Number(document.migrations.accountSlots?.[entry.id] || 0) >= ACCOUNT_SLOT_MIGRATION_VERSION) continue;
    const mark = (target) => {
      target.migrations.accountSlots = { ...target.migrations.accountSlots, [entry.id]: ACCOUNT_SLOT_MIGRATION_VERSION };
      return target;
    };
    const stored = store.settingsCredentials(document);
    // Companion fields can belong to an environment account. Move them only
    // when a stored primary credential (or one of its alternatives) moves too.
    const credentials = [entry.status.credential, ...(entry.form?.credentialChoice?.fields || [])];
    if (!credentials.some(key => stored[key])) {
      store.writeDocument(mark(document));
      continue;
    }
    const values = defaultAccountValues(entry, { ...settings, ...stored }, {});
    // Only non-secret companions may borrow the environment. Secrets remain
    // in the ephemeral environment lane, never copied into a stored slot.
    for (const field of entry.fields) {
      const companion = field.kind === 'setting' || entry.form?.fields?.some(form => form.key === field.key && form.secret === false);
      if (!companion || !(field.key in values) || values[field.key]) continue;
      values[field.key] = field.resolve?.(env) || field.envFallback?.map(key => env[key]).find(Boolean) || field.configDefault || '';
    }
    const fingerprint = accountValuesFingerprint(values);
    const key = accountSlotKey(entry);
    const raw = stored[key] || [];
    const slots = normalizeAccountSlots(entry, raw);
    if (slots.length !== raw.length) throw new Error('Invalid account slot list');
    let slot = slots.find(slot => accountValuesFingerprint(slot.values) === fingerprint);
    if (slot && !slot.enabled) {
      // The fixed credential was being collected; a paused duplicate taking its
      // place must not stop that, so the destination is resumed.
      slot = { ...slot, enabled: true, updatedAt: new Date(now()).toISOString() };
      store.replaceSettingsCredentials({ ...stored, [key]: slots.map(item => item.id === slot.id ? slot : item) }, document);
    } else if (!slot) {
      if (slots.length >= 21) throw new Error('Account slot limit prevents migration');
      const saved = stored[defaultIdentityKey(entry)];
      const identity = saved?.fingerprint === fingerprint ? saved : {};
      const timestamp = new Date(now()).toISOString();
      const proves = entry.serverAccountKey && entry.limits[entry.serverAccountKey];
      slot = { id: randomUUID(), label: '', enabled: true, values,
        accountKey: identity.accountKey || hashKey(entry.id, 'account-slot', 'default'),
        accountKeyAliases: identity.accountKeyAliases || [],
        serverIdentity: identity.serverIdentity === true || Boolean(proves && identity.accountKey !== hashKey(entry.id, 'account-slot', 'default')
          && proves(identity.accountKey, values, identity.accountKeyAliases || [])),
        createdAt: timestamp, updatedAt: timestamp };
      store.replaceSettingsCredentials({ ...stored, [key]: [slot, ...slots] }, document);
    }
    // Verify the destination from disk before stripping even one source field.
    document = store.readDocument();
    const verified = store.settingsCredentials(document);
    if (!verified[key]?.some(item => item.id === slot.id && isDeepStrictEqual(item, slot))) {
      throw new Error('Account slot migration verification failed');
    }
    // Qoder site still selects the endpoint for the environment credential lane.
    // Copy that shared setting; move only the stored credential fields.
    for (const field of entry.fields.filter(field => field.kind === 'credential')) verified[field.key] = '';
    verified[defaultIdentityKey(entry)] = null;
    // Stripping and the marker land in one write; a crash before it re-runs
    // and finds the verified slot instead of adding another.
    store.replaceSettingsCredentials(verified, mark(document));
  }
  return store.settingsCredentials();
}
module.exports = { migrateAccountSlots };
