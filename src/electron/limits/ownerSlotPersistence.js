// @ts-check
'use strict';
const { isDeepStrictEqual } = require('node:util');
const { normalizeManagedAccounts: normalizeAntigravity } = require('../../shared/providers/antigravity/oauth');
const { normalizeClaudeManagedAccounts } = require('../../shared/providers/claude/webAccounts');
const { normalizeManagedAccounts: normalizeWorkbuddy } = require('../../shared/providers/workbuddy/oauth');
const { ownerSlotAccounts } = require('../../shared/limits/ownerAccountSlots');

/** @param {string} provider @param {() => any} getSettings @param {() => any} service @param {(id: string) => any} [legacyRead] */
function createOwnerSlotPersistence(provider, getSettings, service, legacyRead = () => null) {
  const slots = () => getSettings()[`${provider}AccountSlots`] || [];
  const accounts = () => {
    const saved = ownerSlotAccounts(getSettings(), provider).map((/** @type {any} */ { credentials, ...metadata }) => metadata);
    const sourceIds = new Set(slots().map((/** @type {any} */ slot) => slot.owner?.metadata?.id));
    return [...saved, ...(getSettings()[`${provider}ManagedAccounts`] || []).filter((/** @type {any} */ account) => !sourceIds.has(account.id))];
  };
  const read = (/** @type {string} */ id) => structuredClone(slots().find((/** @type {any} */ slot) => slot.id === id)?.owner?.credential ?? legacyRead(id));
  /** @param {any[]} next @param {any[]} writes @param {() => void} [validate] @param {any} [preferences] */
  function commit(next, writes, validate = () => {}, preferences = {}) {
    const before = accounts();
    const expected = JSON.stringify(before);
    const normalize = provider === 'claude' ? normalizeClaudeManagedAccounts
      : provider === 'antigravity' ? normalizeAntigravity : provider === 'workbuddy' ? normalizeWorkbuddy : (/** @type {any[]} */ value) => value;
    const projected = normalize(before);
    // Owner lists are projections, not replacement authority. Claude/WorkBuddy
    // issue explicit credential deletions, including Antigravity removals.
    // MiniMax's key editor supplies its complete profile map.
    const removed = new Set([...writes.filter(write => write.credential === null || write.credential === '').map(write => write.id),
      ...(provider === 'minimax' ? before.filter(account => !next.some(item => item.id === account.id)).map(account => account.id) : [])]);
    return service().ownerTransaction(provider, (/** @type {any[]} */ current) => {
      validate();
      if (JSON.stringify(accounts()) !== expected) throw new Error('superseded');
      const legacy = provider === 'minimax'
        ? Object.entries(getSettings().minimaxApiProfiles || {}).map(([id, profile]) => ({ id, ...profile }))
        : getSettings()[`${provider}ManagedAccounts`] || [];
      const legacyIds = new Set(legacy.filter((/** @type {any} */ account) => !current.some(slot => slot.id === account.id)).map((/** @type {any} */ account) => account.id));
      const saved = next.filter(account => !legacyIds.has(account.id) && !removed.has(account.id));
      const retained = current.filter(slot => !removed.has(slot.id) && !saved.some(account => account.id === slot.id));
      if (saved.length + retained.length > 21) throw new Error('slotLimit');
      const updated = saved.map(account => {
        const previous = current.find(slot => slot.id === account.id);
        const update = writes.find(write => write.id === account.id);
        if (previous && (isDeepStrictEqual(account, before.find(item => item.id === account.id))
          || isDeepStrictEqual(account, projected.find(item => item.id === account.id)))) {
          return update ? { ...previous, owner: { ...previous.owner, credential: update.credential } } : previous;
        }
        // Owner `accountLabel` is provider-reported (a plan or profile name),
        // never a rename, so it must not seed the user's display label.
        return { ...previous, id: account.id, label: previous?.label || '',
          enabled: account.enabled !== false, values: {}, accountKey: account.accountKey || '',
          accountKeyAliases: account.accountKeyAliases || previous?.accountKeyAliases || [], serverIdentity: Boolean(account.accountKey),
          createdAt: previous?.createdAt || account.addedAt || new Date().toISOString(), updatedAt: account.updatedAt || new Date().toISOString(),
          owner: { metadata: { ...previous?.owner?.metadata, ...account }, credential: update ? update.credential : previous?.owner?.credential ?? legacyRead(account.id) } };
      });
      // Keep the shared saved order; owner projections may omit siblings.
      const result = current.filter(slot => !removed.has(slot.id)).map(slot => updated.find(item => item.id === slot.id) || slot);
      result.push(...updated.filter(item => !current.some(slot => slot.id === item.id)));
      if (!legacyIds.size) return result;
      const remaining = legacy.filter((/** @type {any} */ account) => legacyIds.has(account.id) && !removed.has(account.id)).map((/** @type {any} */ account) => {
        const updated = next.find(item => item.id === account.id);
        return updated ? { ...account, ...updated } : account;
      });
      const legacyWrites = writes.filter(write => legacyIds.has(write.id));
      for (const id of legacyIds) if (!remaining.some((/** @type {any} */ account) => account.id === id)) legacyWrites.push({ id, credential: null });
      const legacyMetadata = provider === 'minimax' ? Object.fromEntries(remaining.map((/** @type {any} */ account) => [account.id, {
        apiKey: writes.find(write => write.id === account.id)?.credential || legacy.find((/** @type {any} */ item) => item.id === account.id)?.apiKey,
        billingMode: account.billingMode, apiRegion: account.apiRegion, enabled: account.enabled !== false
      }])) : remaining;
      return { slots: result, legacyMetadata, legacyWrites };
    }, preferences);
  }
  return { accounts, read, commit, has: (/** @type {string} */ id) => slots().some((/** @type {any} */ slot) => slot.id === id) };
}
module.exports = { createOwnerSlotPersistence };
