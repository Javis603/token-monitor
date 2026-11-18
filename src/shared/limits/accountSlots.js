// @ts-check
'use strict';

const { hashKey } = require('../hashKey');
const { normalizeLimitProvider } = require('./core');
/**
 * @typedef {object} AccountSlot
 * @property {any} [owner] Main-only provider metadata and complete credential record.
 * @property {string} id
 * @property {string} label
 * @property {string} [localLabel] Locally authored name before adopting a shared label.
 * @property {boolean} enabled
 * @property {Record<string, string>} values
 * @property {string} accountKey
 * @property {string} [accountName] Public provider name, separate from a user label or identity key.
 * @property {string[]} accountKeyAliases
 * @property {boolean} serverIdentity Whether `accountKey` was proven to be a server account identity.
 * @property {string} createdAt
 * @property {string} updatedAt
 */
/** @param {{id: string}} entry @param {any} input */
function normalizeAmbientAccounts(entry, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).filter(([fingerprint, value]) => /^sha256:[a-f0-9]{64}$/.test(fingerprint) && value && typeof value === 'object').map(([fingerprint, value]) => {
    const identity = normalizeLimitProvider({ ...value, provider: entry.id, accountLabel: value.label });
    return [fingerprint, { accountKey: identity?.accountKey || '', accountKeyAliases: identity?.accountKeyAliases || [],
      accountName: identity?.accountName || '', accountEmail: identity?.accountEmail || '', label: identity?.accountLabel || '',
      sourceName: typeof value.sourceName === 'string' ? value.sourceName.slice(0, 120) : '',
      enabled: value.enabled !== false, order: Number.isFinite(value.order) ? value.order : -1 }];
  }));
}
/** @param {{id: string}} declaration */
function accountSlotKey(declaration) { return `${declaration.id}AccountSlots`; }
/** @param {import('./accounts').AccountDeclaration} declaration @param {unknown} input @returns {AccountSlot[]} */
function normalizeAccountSlots(declaration, input) {
  if (!Array.isArray(input)) return [];
  const keys = declaration.form?.field ? [declaration.form.field] : (declaration.form?.fields || []).map((field) => field.key);
  const seen = new Set();
  const out = [];
  for (const record of input) {
    if (!record || typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(record.id) || seen.has(record.id)) continue;
    seen.add(record.id);
    if (!record.values || out.length >= 21) continue;
    const values = Object.fromEntries(keys.filter((key) => typeof record.values?.[key] === 'string').map((key) => [key, record.values[key]]));
    const identity = normalizeLimitProvider({ provider: declaration.id, accountLabel: record.label, accountName: record.accountName });
    out.push({
      ...(declaration.accountSlotOwner && record.owner && typeof record.owner === 'object' ? { owner: structuredClone(record.owner) } : {}),
      id: record.id, label: identity?.accountLabel || '',
      ...(typeof record.localLabel === 'string' ? { localLabel: normalizeLimitProvider({ provider: declaration.id, accountLabel: record.localLabel })?.accountLabel || '' } : {}),
      enabled: record.enabled !== false, values,
      accountKey: typeof record.accountKey === 'string' ? record.accountKey.trim() : '',
      ...(identity?.accountName ? { accountName: identity.accountName } : {}),
      accountKeyAliases: Array.isArray(record.accountKeyAliases) ? [...new Set(record.accountKeyAliases.filter((/** @type {unknown} */ key) => typeof key === 'string' && key.trim()).map((/** @type {string} */ key) => key.trim()))].slice(0, 8) : [],
      serverIdentity: record.serverIdentity === true,
      createdAt: typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt)) ? new Date(record.createdAt).toISOString() : '',
      updatedAt: typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt)) ? new Date(record.updatedAt).toISOString() : ''
    });
  }
  return out;
}
/** @param {import('./accounts').AccountDeclaration} declaration @returns {import('./accounts').AccountField} */
function accountSlotField(declaration) {
  return { key: accountSlotKey(declaration), kind: 'profiles', storePath: ['providers', declaration.id, 'accountSlots'], persist: 'never', initial: null, configDefault: [], configNormalize: (value) => normalizeAccountSlots(declaration, value) };
}
/** @param {{id: string}} entry */
function defaultIdentityKey(entry) { return `${entry.id}DefaultAccountIdentity`; }
/** @param {any} entry @param {any} options @param {any} env */
function defaultAccountValues(entry, options, env) {
  if (entry.environmentWhenSaved === false && normalizeAccountSlots(entry, options[accountSlotKey(entry)]).length) env = {};
  return Object.fromEntries(entry.fields.filter((/** @type {any} */ field) => field.config !== false && (field.kind === 'credential' || field.kind === 'setting') && field.key !== `${entry.id}SourcePreference` && field.key !== defaultIdentityKey(entry) && field.key !== `${entry.id}AmbientAccounts`)
    .map((/** @type {any} */ field) => [field.key, options[field.key] || field.resolve?.(env) || field.envFallback?.map((/** @type {string} */ key) => env[key]).find(Boolean) || field.configDefault || '']));
}
// Credential choices are alternative authentication lanes, not companion fields
// such as a device id. Keep one default account with the provider's precedence.
/** @param {any} entry @param {any} values */
function accountCredentialKey(entry, values) {
  const keys = entry.form?.credentialChoice?.fields || entry.accountCredentialKeys || [entry.status?.credential];
  return keys.find((/** @type {string} */ key) => Boolean(values[key]) && (!entry.accountCredentialReady || entry.accountCredentialReady(values, key))) || '';
}
/** @param {any} entry @param {any} values */
function hasAccountCredential(entry, values) {
  return Boolean(accountCredentialKey(entry, values));
}
/** @param {any} values */
function accountValuesFingerprint(values) { return hashKey(JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))); }
// Saved array order fills the gaps between persisted external row positions.
// Unpositioned discoveries keep their initial precedence over the environment.
/** @param {any[]} saved @param {any[]} ambient @param {any} environment */
function orderAccountRows(saved, ambient, environment) {
  const positioned = [...ambient, ...(environment && Number.isFinite(environment.order) ? [environment] : [])]
    .filter(item => Number.isFinite(item.order) && item.order >= 0).sort((a, b) => a.order - b.order);
  const rows = [...ambient.filter(item => !Number.isFinite(item.order) || item.order < 0),
    ...(environment && !positioned.includes(environment) ? [environment] : []), ...saved];
  for (const item of positioned) rows.splice(Math.min(Math.floor(item.order), rows.length), 0, item);
  return rows;
}
/** @param {any[]} entries @param {any} options @param {any} env @param {any} [deps] */
function configuredMultiAccountProviders(entries, options, env, deps = {}) {
  const discoveredCount = (/** @type {any} */ entry) => {
    try {
      /** @type {any[]} */
      const owners = normalizeAccountSlots(entry, options[accountSlotKey(entry)]).filter(slot => slot.enabled);
      const values = defaultAccountValues(entry, options, env);
      if (hasAccountCredential(entry, values)) owners.push({ values, accountKey: hashKey(entry.id, values[accountCredentialKey(entry, values)]), accountKeyAliases: [] });
      const records = (entry.discoveredAccounts?.(env, entry.limits, { ...deps, env }) || []).filter((/** @type {any} */ record) => options[`${entry.id}AmbientAccounts`]?.[accountValuesFingerprint(record.values)]?.enabled !== false);
      let count = 0;
      for (const record of records) {
        const remembered = options[`${entry.id}AmbientAccounts`]?.[accountValuesFingerprint(record.values)] || {};
        const accountKey = remembered.accountKey || record.accountKey;
        const identity = { ...record, accountKey, accountKeyAliases: [...new Set([...(remembered.accountKeyAliases || []),
          ...(record.accountKeyAliases || []), ...(record.accountKey && record.accountKey !== accountKey ? [record.accountKey] : [])])] };
        if (owners.some(owner => accountValuesFingerprint(owner.values) === accountValuesFingerprint(record.values)
          || (owner.accountKey && (owner.accountKey === identity.accountKey || identity.accountKeyAliases?.includes(owner.accountKey) || owner.accountKeyAliases?.includes(identity.accountKey))))) continue;
        owners.push({ ...record, ...identity });
        count += 1;
      }
      return count;
    } catch (_) { return Object.values(options[`${entry.id}AmbientAccounts`] || {}).filter((/** @type {any} */ item) => item.enabled !== false).length; }
  };
  return entries.filter(entry => entry.accountSlots && normalizeAccountSlots(entry, options[accountSlotKey(entry)]).filter(slot => slot.enabled).length
    + discoveredCount(entry)
    + (hasAccountCredential(entry, defaultAccountValues(entry, options, env)) ? 1 : 0) > 1).map(entry => entry.id);
}
module.exports = { orderAccountRows, normalizeAmbientAccounts, accountCredentialKey, hasAccountCredential, defaultIdentityKey, defaultAccountValues, accountValuesFingerprint, configuredMultiAccountProviders, accountSlotKey, accountSlotField, normalizeAccountSlots };
