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
    // A collector knows which app accounts it still holds; one already retired
    // on sign-out is not brought back by a later read failure.
    const held = options.previousLimits ? new Set((options.previousLimits.providers || [])
      .filter((/** @type {any} */ row) => row.provider === entry.id && row.accountKey).map((/** @type {any} */ row) => row.accountKey)) : null;
    const known = Object.entries(metadata).filter(([, item]) => !held || held.has(item.accountKey)
      || (item.accountKeyAliases || []).some((/** @type {string} */ key) => held.has(key))).map(([fingerprint, item]) => ({ ...item,
      id: `discovered-${fingerprint}`, source: 'discovered', fingerprint, values: {},
      discoveryStatus: 'unavailable', enabled: item.enabled !== false, order: item.order ?? -1 }));
    // A headless collector has no persisted metadata; the flag lets it keep the
    // app readings it already holds rather than retiring them.
    return Object.assign(known, { discoveryFailed: true });
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
    // For an unchanged credential, the identity a fetch resolved (a server user
    // id) wins over the key discovery derives; that key stays an alias.
    const accountKey = remembered.accountKey || record.accountKey || hashKey(entry.id, 'discovered', fingerprint);
    const aliases = [...new Set([...(remembered.accountKeyAliases || []), ...(record.accountKeyAliases || []), ...(record.accountKey && record.accountKey !== accountKey ? [record.accountKey] : [])])].slice(-8);
    // The current fingerprint's record is authoritative; an older record of the
    // same account (before a token rotation) only seeds it.
    const controls = metadata[fingerprint] || Object.values(metadata).find((/** @type {any} */ item) => (item.accountKey === accountKey || item.accountKeyAliases.includes(accountKey))) || {};
    return { ...record, id: `discovered-${fingerprint}`, source: 'discovered', fingerprint,
      accountName: record.accountName || remembered.accountName || '', accountEmail: record.accountEmail || remembered.accountEmail || '',
      accountKey, accountKeyAliases: aliases, label: controls.label || '',
      enabled: controls.enabled !== false, order: controls.order ?? -1 };
  });
}
module.exports = { ambientAccounts };
