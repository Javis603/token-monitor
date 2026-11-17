// @ts-check
'use strict';
/** @param {{region?: string}} value */
function alibabaVariantIdentityPart(value) {
  const region = String(value?.region || '').trim().toLowerCase();
  return region ? `:region:${region}` : '';
}
/**
 * @template {{accountKey?: string, accountKeyAliases: string[], values?: Record<string, string> | null}} T
 * @param {T[]} accounts @param {{accountKey?: string, region?: string}} scope
 * @param {string} [environmentVariant]
 * @returns {T[] | null}
 */
function alibabaAccountSlotsForScope(accounts, scope, environmentVariant = 'cn') {
  const matching = accounts.filter(account => account.accountKey === scope.accountKey
    || account.accountKeyAliases.includes(String(scope.accountKey)));
  if (!matching.length) return null;
  const region = String(scope.region || '').trim().toLowerCase();
  return region ? matching.filter(account => (account.values ? account.values.alibabaVariant || 'cn' : environmentVariant) === region) : matching;
}
/**
 * @typedef {{accountKey: string, enabled: boolean, values: Record<string, string>}} VariantSlot
 * @param {VariantSlot[]} previous @param {VariantSlot[]} next
 * @param {{accountKey: string, region: string} | null} environment
 */
function alibabaRetiredVariantScopes(previous, next, environment) {
  const variant = (/** @type {VariantSlot} */ slot) => slot.values.alibabaVariant || 'cn';
  return previous.filter(slot => slot.enabled && slot.accountKey
    && !next.some(current => current.enabled && current.accountKey === slot.accountKey && variant(current) === variant(slot))
    && !(environment?.accountKey === slot.accountKey && environment.region === variant(slot)))
    .map(slot => ({ provider: 'alibaba', accountKey: slot.accountKey, region: variant(slot) }));
}
module.exports = { alibabaVariantIdentityPart, alibabaAccountSlotsForScope, alibabaRetiredVariantScopes };
