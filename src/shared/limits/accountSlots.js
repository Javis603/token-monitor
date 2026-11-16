// @ts-check
'use strict';

const { hashKey } = require('../hashKey');
const { normalizeLimitProvider } = require('./core');
/**
 * @typedef {object} AccountSlot
 * @property {string} id
 * @property {string} label
 * @property {boolean} enabled
 * @property {Record<string, string>} values
 * @property {string} accountKey
 * @property {string[]} accountKeyAliases
 * @property {boolean} serverIdentity Whether `accountKey` was proven to be a server account identity.
 * @property {string} createdAt
 * @property {string} updatedAt
 */
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
    const values = Object.fromEntries(keys.filter((key) => typeof record.values?.[key] === 'string').map((key) => [key, record.values[key]]));
    out.push({
      id: record.id, label: normalizeLimitProvider({ provider: declaration.id, accountLabel: record.label })?.accountLabel || '',
      enabled: record.enabled !== false, values,
      accountKey: typeof record.accountKey === 'string' ? record.accountKey.trim() : '',
      accountKeyAliases: Array.isArray(record.accountKeyAliases) ? [...new Set(record.accountKeyAliases.filter((/** @type {unknown} */ key) => typeof key === 'string' && key.trim()).map((/** @type {string} */ key) => key.trim()))].slice(0, 8) : [],
      serverIdentity: record.serverIdentity === true,
      createdAt: typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt)) ? new Date(record.createdAt).toISOString() : '',
      updatedAt: typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt)) ? new Date(record.updatedAt).toISOString() : ''
    });
    if (out.length === 20) break;
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
  return Object.fromEntries(entry.fields.filter((/** @type {any} */ field) => (field.kind === 'credential' || field.kind === 'setting') && field.key !== defaultIdentityKey(entry))
    .map((/** @type {any} */ field) => [field.key, options[field.key] || field.resolve?.(env) || field.configDefault || '']));
}
/** @param {any} values */
function accountValuesFingerprint(values) { return hashKey(JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))); }
/** @param {any[]} entries @param {any} options @param {any} env */
function configuredMultiAccountProviders(entries, options, env) {
  return entries.filter(entry => entry.accountSlots && normalizeAccountSlots(entry, options[accountSlotKey(entry)]).filter(slot => slot.enabled).length
    + (defaultAccountValues(entry, options, env)[entry.status?.credential] ? 1 : 0) > 1).map(entry => entry.id);
}
module.exports = { defaultIdentityKey, defaultAccountValues, accountValuesFingerprint, configuredMultiAccountProviders, accountSlotKey, accountSlotField, normalizeAccountSlots };
