'use strict';
const { isDeepStrictEqual } = require('node:util');
const { randomUUID } = require('node:crypto');
const { hashKey } = require('../../shared/hashKey');
const { normalizeLimitProvider } = require('../../shared/limits/core');
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
    const complete = Number(document.migrations.accountSlots?.[entry.id] || 0) >= ACCOUNT_SLOT_MIGRATION_VERSION;
    const legacyOwnerRecords = entry.accountSlotOwner && entry.id !== 'minimax'
      && Object.keys(document.credentials.providers?.[entry.id]?.accounts || {}).length > 0;
    if (complete && !legacyOwnerRecords) continue;
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
    if (entry.accountSlotOwner) {
      migrateOwnerSlots(store, stored, settings, entry, document, mark, now);
      continue;
    }
    const credentials = entry.form?.credentialChoice?.fields || entry.accountCredentialKeys || [entry.status.credential];
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
    if (entry.id === 'alibaba' && !values.alibabaVariant && env.ALIBABA_TOKEN_PLAN_VARIANT) {
      values.alibabaVariant = entry.limits.alibabaVariant(values, env);
    }
    // Keep a working fixed lane intact when only the environment completes its credentials.
    if (entry.limits?.accountSlotMigrationNeedsEnvironment?.(values, env)) {
      store.writeDocument(mark(document));
      continue;
    }
    const fingerprint = accountValuesFingerprint(values);
    const key = accountSlotKey(entry);
    const raw = stored[key] || [];
    const slots = normalizeAccountSlots(entry, raw);
    if (slots.length !== raw.length) throw new Error('Invalid account slot list');
    const alibabaImport = entry.id === 'alibaba';
    // Journal the chosen destination with its first write. A restart can have
    // a different console environment even though the fixed cookie is unchanged.
    const pendingAlibaba = alibabaImport && document.migrations.alibabaSlotImport;
    let slot = slots.find(slot => pendingAlibaba === slot.id && slot.values.alibabaCookie === values.alibabaCookie)
      || slots.find(slot => accountValuesFingerprint(slot.values) === fingerprint);
    let next = slots;
    if (slot && !slot.enabled) {
      // The fixed credential was being collected; a paused duplicate taking its
      // place must not stop that, so the destination is resumed.
      slot = { ...slot, enabled: true, updatedAt: new Date(now()).toISOString() };
      next = slots.map(item => item.id === slot.id ? slot : item);
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
      next = [slot, ...slots];
    }
    if (alibabaImport) document.migrations.alibabaSlotImport = slot.id;
    if (alibabaImport || next !== slots) {
      store.replaceSettingsCredentials({ ...stored, [key]: next }, document);
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
    if (alibabaImport) delete document.migrations.alibabaSlotImport;
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
    return [{ id: hashKey('openrouter', 'legacy-profile', name).slice(7), label: normalizeLimitProvider({ provider: 'openrouter', accountLabel: migratedOpenRouterLabel(name) })?.accountLabel || '', enabled: profile.enabled !== false,
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
  const imports = sources.map(([id, profile]) => normalizeAccountSlots(entry, [{
    id, label: '', enabled: profile.enabled,
    values: { copilotApiToken: profile.token, copilotEnterpriseHost: profile.enterpriseHost },
    accountKey: profile.accountKey || entry.limits.copilotAccountKey(profile.token, profile.enterpriseHost),
    ...(profile.accountName ? { accountName: profile.accountName } : {}),
    accountKeyAliases: [], serverIdentity: Boolean(profile.accountKey), createdAt: timestamp, updatedAt: timestamp
  }])[0]);
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
// Provider metadata and its complete credential travel together. A missing
// credential remains a visible repairable account, including disabled records.
function migrateOwnerSlots(store, stored, settings, entry, document, mark, now) {
  const provider = entry.id;
  const key = accountSlotKey(entry);
  const metadataKey = `${provider}ManagedAccounts`;
  let sources;
  const records = provider === 'minimax' ? {} : document.credentials.providers?.[provider]?.accounts || {};
  if (provider === 'minimax') {
    // Collection merges saved slots into profiles; migration must read only
    // legacy sources still present, including an interrupted destination write.
    const legacy = { ...settings, ...stored, minimaxAccountSlots: [] };
    const named = entry.limits.minimaxApiProfiles({ ...legacy, minimaxApiKey: '' });
    // Reserve the names already imported when choosing a name for the fixed
    // key. They are no longer in the legacy map after partial cleanup.
    const combined = entry.limits.minimaxApiProfiles({ ...legacy, minimaxAccountSlots: stored[key] });
    const occupied = new Set((stored[key] || []).map(slot => slot.id));
    const fixed = Object.entries(combined).filter(([id]) => !Object.hasOwn(named, id) && !occupied.has(id));
    sources = [...Object.entries(named), ...fixed].map(([id, profile]) => ({
      metadata: { id, accountKey: hashKey(provider, profile.apiKey), enabled: profile.enabled, billingMode: profile.billingMode, apiRegion: profile.apiRegion }, credential: profile.apiKey
    }));
  } else {
    sources = (settings[metadataKey] || []).map(metadata => ({ metadata,
      credential: records[metadata.id]?.[provider === 'claude' ? 'cookie' : 'credentials'] ?? null }));
    if (provider === 'claude' && stored.claudeWebCookie) sources.unshift({
      metadata: { id: 'legacy-web-cookie', organizationId: settings.claudeWebOrganizationId || '', enabled: true }, credential: stored.claudeWebCookie
    });
  }
  // Credentials can outlive their metadata (for example after a partial
  // restore). Leave the migration open so restoring that metadata can recover.
  if (!sources.length && Object.keys(records).length) {
    if (document.migrations.accountSlots?.[provider]) {
      delete document.migrations.accountSlots[provider];
      store.writeDocument(document);
    }
    return;
  }
  const raw = stored[key] || [];
  const slots = normalizeAccountSlots(entry, raw);
  if (raw.length !== slots.length) throw new Error('Invalid account slot list');
  const timestamp = new Date(now()).toISOString();
  const imports = sources.map(({ metadata, credential }) => ({
    id: /^[A-Za-z0-9_-]{1,64}$/.test(metadata.id) ? metadata.id : hashKey(provider, 'legacy-owner', metadata.id).slice(7),
    label: migratedOpenRouterLabel(String(metadata.accountLabel || '')), enabled: metadata.enabled !== false, values: {},
    accountKey: metadata.accountKey || '', accountKeyAliases: metadata.accountKeyAliases || [], serverIdentity: Boolean(metadata.accountKey),
    createdAt: metadata.addedAt || timestamp, updatedAt: metadata.updatedAt || timestamp,
    owner: { metadata, credential }
  }));
  // An independently saved account may reuse a live legacy ID after a restore.
  // Give the saved copy its own ID so even a full list leaves both credentials
  // reachable, while keeping its account key and quota history.
  if (provider !== 'minimax') {
    const reserved = new Set([...slots, ...imports].map(slot => slot.id));
    for (const item of imports) {
      const index = slots.findIndex(slot => slot.id === item.id);
      const existing = slots[index];
      if (!existing || item.owner.credential == null || isDeepStrictEqual(existing.owner, item.owner)) continue;
      if (!existing.owner) throw new Error('Saved account import conflict');
      let id = hashKey(provider, 'owner-slot-conflict', existing.id).slice(7);
      for (let attempt = 1; reserved.has(id); attempt++) {
        id = hashKey(provider, 'owner-slot-conflict', existing.id, attempt).slice(7);
      }
      reserved.add(id);
      slots[index] = { ...existing, id, owner: { ...existing.owner, metadata: { ...existing.owner.metadata, id } } };
    }
  }
  const additions = imports.filter(item => !slots.some(slot => slot.id === item.id));
  const next = normalizeAccountSlots(entry, [...slots, ...additions.slice(0, 21 - slots.length)]);
  const imported = imports.filter(item => next.some(slot => slot.id === item.id));
  for (const item of imported) {
    const existing = next.find(slot => slot.id === item.id);
    // Cleanup may have removed the legacy credential before settings metadata
    // reached disk. The durable destination and identical metadata prove import.
    const cleanedSource = item.owner.credential === null && existing.owner?.credential != null
      && isDeepStrictEqual(existing.owner.metadata, item.owner.metadata);
    if ((!cleanedSource && !isDeepStrictEqual(existing.owner, item.owner)) || existing.enabled !== item.enabled) throw new Error('Saved account import conflict');
  }
  store.replaceSettingsCredentials({ ...stored, [key]: next }, document);
  document = store.readDocument();
  const verified = store.settingsCredentials(document);
  if (!isDeepStrictEqual(verified[key] || [], next)) throw new Error('Account slot migration verification failed');
  const ids = new Set(imported.map(item => item.owner.metadata.id));
  // Remove credentials only from the document just verified, never an earlier
  // snapshot. Metadata cleanup is repeated by main on every settings load.
  if (provider === 'minimax') {
    verified.minimaxApiProfiles = Object.fromEntries(Object.entries(stored.minimaxApiProfiles || {}).filter(([id]) => !ids.has(id)));
    if (stored.minimaxApiKey && next.some(item => item.owner?.credential === stored.minimaxApiKey)) verified.minimaxApiKey = '';
  } else {
    for (const id of ids) if (document.credentials.providers?.[provider]?.accounts) delete document.credentials.providers[provider].accounts[id];
    if (provider === 'claude' && ids.has('legacy-web-cookie')) verified.claudeWebCookie = '';
  }
  const pending = imported.length < imports.length;
  const remainingRecords = provider !== 'minimax' && Object.keys(document.credentials.providers?.[provider]?.accounts || {}).length > 0;
  if ((pending || remainingRecords) && document.migrations.accountSlots?.[provider]) {
    delete document.migrations.accountSlots[provider];
  }
  store.replaceSettingsCredentials(verified, pending || remainingRecords ? document : mark(document));
  if (pending) console.warn(`[${provider}] Account list is full; remaining legacy accounts are retained and continue collecting.`);
}
module.exports = { migrateAccountSlots };
