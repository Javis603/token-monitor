// @ts-check
'use strict';

/** Main-only projection. Never use this as a renderer DTO.
 * Owner metadata keeps provider-reported facts; `slot.label` is the user's
 * rename and reaches surfaces only through account presentation.
 * @param {any} options @param {string} provider */
function ownerSlotAccounts(options, provider) {
  return (options[`${provider}AccountSlots`] || []).filter((/** @type {any} */ slot) => slot.owner).map((/** @type {any} */ slot) => ({
    ...slot.owner.metadata, id: slot.id, enabled: slot.enabled !== false,
    accountKey: slot.accountKey, accountKeyAliases: slot.accountKeyAliases || [],
    credentials: slot.owner.credential
  }));
}
/** @param {any} options @param {string} provider @param {any[]} legacy */
function mergedOwnerAccounts(options, provider, legacy) {
  const saved = ownerSlotAccounts(options, provider);
  return [...saved, ...legacy.filter(account => !saved.some((/** @type {any} */ slot) => slot.id === account.id))];
}
module.exports = { ownerSlotAccounts, mergedOwnerAccounts };
