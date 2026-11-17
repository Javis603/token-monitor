// @ts-check
'use strict';
const { hashKey } = require('../hashKey');
const { normalizeAmbientAccounts, normalizeAccountSlots, accountSlotKey, defaultAccountValues, accountValuesFingerprint } = require('./accountSlots');

// Descriptors contain credentials and are main/collector-only. Persist only the
// identity and user controls, never the values or provider-specific fetch deps.
/** @param {any} entry @param {any} options @param {any} deps */
function ambientAccounts(entry, options, deps) {
  const metadata = normalizeAmbientAccounts(entry, options[`${entry.id}AmbientAccounts`]);
  let discovered;
  try { discovered = entry.discoveredAccounts?.(deps.env || process.env, entry.limits, deps) || []; }
  catch (_) {
    // An unreadable app store does not prove sign-out. Keep only public identity
    // metadata as unavailable; there is no retained credential to retry here.
    return Object.entries(metadata).map(([fingerprint, item]) => ({ ...item,
      id: `discovered-${fingerprint}`, source: 'discovered', fingerprint, values: {},
      discoveryStatus: 'unavailable', enabled: item.enabled !== false, order: item.order ?? -1 }));
  }
  const saved = normalizeAccountSlots(entry, options[accountSlotKey(entry)]).filter(slot => slot.enabled);
  return discovered.map((/** @type {any} */ record) => {
    // An exact ZCode coding key at the same endpoint is the existing combined
    // console/quota/billing lane. Preserve finance and query quota only once.
    if (record.combineMatchingCredential) {
      const values = [...saved.map(slot => slot.values), defaultAccountValues(entry, options, deps.env || process.env)];
      if (values.some(value => accountValuesFingerprint(value) === accountValuesFingerprint(record.values))) {
        record.fetchDeps = record.combinedFetchDeps;
      }
    }
    const fingerprint = accountValuesFingerprint(record.values);
    const remembered = metadata[fingerprint] || {};
    const accountKey = record.accountKey || remembered.accountKey || hashKey(entry.id, 'discovered', fingerprint);
    const controls = Object.values(metadata).find((/** @type {any} */ item) => item.accountKey === accountKey) || remembered;
    return { ...record, id: `discovered-${fingerprint}`, source: 'discovered', fingerprint,
      accountName: record.accountName || remembered.accountName || '', accountEmail: record.accountEmail || remembered.accountEmail || '',
      accountKey, accountKeyAliases: remembered.accountKeyAliases || [], label: controls.label || '',
      enabled: controls.enabled !== false, order: controls.order ?? -1 };
  });
}
module.exports = { ambientAccounts };
