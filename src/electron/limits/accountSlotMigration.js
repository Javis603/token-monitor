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
    if (entry.id === 'copilot') {
      migrateCopilotSlots(store, stored, settings, document, mark, now, env);
      continue;
    }
    if (entry.id === 'openrouter') {
      migrateOpenRouterSlots(store, stored, document, mark, now);
      continue;
    }
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
// The shared label alphabet excludes the ellipsis glyph; use three periods.
// Normalize before counting, and never split a grapheme to fit the 32-codepoint cap.
function migratedOpenRouterLabel(name) {
  const label = name.normalize('NFC');
  if ([...label].length <= 32) return label;
  let prefix = '';
  for (const { segment } of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(label)) {
    if ([...prefix, ...segment].length > 29) break;
    prefix += segment;
  }
  return prefix.trimEnd() + '...';
}

// Names are presentation, never identity. Stable import IDs allow retry after
// the destination write while retaining duplicate and paused profile records.
function migrateOpenRouterSlots(store, stored, document, mark, now) {
  const entry = LIMIT_PROVIDER_REGISTRY.find(entry => entry.id === 'openrouter');
  const profiles = Object.entries(stored.openrouterProfiles || {});
  const imports = [
    ...(stored.openrouterApiKey ? [['', { apiKey: stored.openrouterApiKey }]] : []), ...profiles
  ].flatMap(([name, profile]) => {
    // A profile without a usable key collected nothing; skipping it must not
    // block every other profile's migration.
    const apiKey = entry.limits.openrouterToken({}, profile?.apiKey);
    if (!apiKey) return [];
    const timestamp = new Date(now()).toISOString();
    return [{ id: hashKey('openrouter', 'legacy-profile', name).slice(7), label: migratedOpenRouterLabel(name), enabled: profile.enabled !== false,
      values: { openrouterApiKey: apiKey }, accountKey: hashKey('openrouter', apiKey), accountKeyAliases: [], serverIdentity: false,
      createdAt: timestamp, updatedAt: timestamp }];
  });
  const key = accountSlotKey(entry);
  const raw = stored[key] || [];
  const slots = normalizeAccountSlots(entry, raw);
  if (raw.length !== slots.length) throw new Error('Invalid account slot list');
  const additions = imports.filter(item => !slots.some(slot => slot.id === item.id));
  const accepted = additions.slice(0, 21 - slots.length);
  const next = [...slots, ...accepted];
  const imported = imports.filter(item => next.some(slot => slot.id === item.id));
  for (const item of imported) {
    const slot = next.find(slot => slot.id === item.id);
    if (slot.label !== item.label || slot.enabled !== item.enabled || slot.accountKey !== item.accountKey || !isDeepStrictEqual(slot.values, item.values)) throw new Error('OpenRouter import conflicts with existing slot');
  }
  if (imports.length) {
    store.replaceSettingsCredentials({ ...stored, [key]: next }, document);
    document = store.readDocument();
    const verified = store.settingsCredentials(document);
    if (!isDeepStrictEqual(verified[key], next)) throw new Error('Account slot migration verification failed');
    stored = verified;
  }
  const importedIds = new Set(imported.map(item => item.id));
  stored.openrouterProfiles = Object.fromEntries(profiles.filter(([name, profile]) =>
    entry.limits.openrouterToken({}, profile?.apiKey) && !importedIds.has(hashKey('openrouter', 'legacy-profile', name).slice(7))));
  if (!entry.limits.openrouterToken({}, stored.openrouterApiKey) || importedIds.has(hashKey('openrouter', 'legacy-profile', '').slice(7))) stored.openrouterApiKey = '';
  const pending = Object.keys(stored.openrouterProfiles).length > 0 || Boolean(stored.openrouterApiKey);
  if (pending) console.warn('[OpenRouter] Account list is full. Remaining legacy profiles continue collecting; remove saved accounts and restart to import them.');
  stored[defaultIdentityKey(entry)] = null;
  store.replaceSettingsCredentials(stored, pending ? document : mark(document));
}
function migrateCopilotSlots(store, stored, settings, document, mark, now, env) {
  const entry = LIMIT_PROVIDER_REGISTRY.find(entry => entry.id === 'copilot');
  // Keep the fixed-token ID independent of the remaining profile names: a
  // bounded import can strip a profile named "legacy" before the next retry.
  const profiles = entry.limits.copilotProfiles({ ...settings, ...stored, copilotApiToken: '' }, env);
  const fixed = entry.limits.copilotToken({}, stored);
  const fixedCovered = fixed && Object.values(profiles).some(profile => profile.token === fixed);
  const sources = Object.entries(profiles).map(([id, profile]) => [hashKey('copilot', 'legacy-profile', id).slice(7), profile]);
  const fixedId = hashKey('copilot', 'legacy-fixed-token').slice(7);
  if (fixed && !fixedCovered) sources.push([fixedId, {
    token: fixed, enabled: true, accountKey: '',
    enterpriseHost: entry.limits.normalizedEnterpriseHost(settings.copilotEnterpriseHost || env.COPILOT_ENTERPRISE_HOST || env.GITHUB_ENTERPRISE_HOST)
  }]);
  const timestamp = new Date(now()).toISOString();
  const imports = sources.map(([id, profile]) => ({
    id, label: '', enabled: profile.enabled,
    values: { copilotApiToken: profile.token, copilotEnterpriseHost: profile.enterpriseHost },
    accountKey: profile.accountKey || entry.limits.copilotAccountKey(profile.token, profile.enterpriseHost),
    accountKeyAliases: [], serverIdentity: Boolean(profile.accountKey), createdAt: timestamp, updatedAt: timestamp
  }));
  const raw = stored.copilotAccountSlots || [];
  const slots = normalizeAccountSlots(entry, raw);
  if (raw.length !== slots.length) throw new Error('Invalid account slot list');
  const additions = imports.filter(item => !slots.some(slot => slot.id === item.id));
  const next = [...slots, ...additions.slice(0, 21 - slots.length)];
  const imported = imports.filter(item => next.some(slot => slot.id === item.id));
  for (const item of imported) {
    const slot = next.find(slot => slot.id === item.id);
    if (slot.accountKey !== item.accountKey || slot.enabled !== item.enabled || !isDeepStrictEqual(slot.values, item.values)) throw new Error('Copilot import conflicts with existing slot');
  }
  if (imports.length) {
    store.replaceSettingsCredentials({ ...stored, copilotAccountSlots: next }, document);
    document = store.readDocument();
    stored = store.settingsCredentials(document);
    if (!isDeepStrictEqual(stored.copilotAccountSlots, next)) throw new Error('Account slot migration verification failed');
  }
  const importedIds = new Set(imported.map(item => item.id));
  stored.copilotProfiles = Object.fromEntries(Object.entries(profiles).filter(([id]) =>
    !importedIds.has(hashKey('copilot', 'legacy-profile', id).slice(7))));
  if (!fixed || fixedCovered || importedIds.has(fixedId)) stored.copilotApiToken = '';
  const pending = Object.keys(stored.copilotProfiles).length > 0 || Boolean(stored.copilotApiToken);
  if (pending) console.warn('[Copilot] Account list is full. Remaining legacy accounts continue collecting; remove saved accounts and restart to import them.');
  stored.copilotDefaultAccountIdentity = null;
  store.replaceSettingsCredentials(stored, pending ? document : mark(document));
}
module.exports = { migrateAccountSlots };
