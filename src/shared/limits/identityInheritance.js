'use strict';

// An account can be renamed without becoming a different account: a provider
// derives `accountKey` from a credential that rotates (a cookie, a token), so
// every re-login lands a new key. Everything downstream reads `accountKey` as
// the account itself — the renderer draws a second card and the quota history
// starts a second timeline — so a rename has to be recognized as the same
// account before either sees it.
//
// The one signal a provider repeats across such a rename is the account's own
// label (its email or login). A key that arrives under a label this device has
// already recorded inherits the keys that label used before, and the history
// store adopts the streams recorded under them. A row without a label inherits
// nothing: an unidentified account cannot be told apart from a different one,
// and merging two accounts is worse than forking one.

const MAX_INHERITED_KEYS = 8;

function normalizedKey(value) {
  return String(value ?? '').trim();
}

// Email first, then the login name. `accountLabel` is deliberately not a
// candidate: it carries display text such as a plan name or workspace alias,
// which two different accounts can share, and this function decides whether two
// identities are one account.
function accountLabel(row) {
  for (const value of [row?.accountEmail, row?.accountName]) {
    const label = String(value ?? '').trim().toLowerCase();
    if (label) return label;
  }
  return '';
}

// Region and workspace pick a different quota pool, so the same account named
// in two of them is two histories rather than one rename.
function identityScope(row) {
  return JSON.stringify([
    String(row?.provider ?? '').trim().toLowerCase(),
    String(row?.region ?? ''),
    String(row?.workspaceKind ?? '')
  ]);
}

function accountKeys(row) {
  const keys = new Set();
  for (const value of [row?.accountKey, ...(Array.isArray(row?.accountKeyAliases) ? row.accountKeyAliases : [])]) {
    const key = normalizedKey(value);
    if (key) keys.add(key);
  }
  return keys;
}

// The keys this account was already recorded under, minus the one the row
// reports now. `previousRows` are the runtime's committed rows, which carry the
// chain inside one process; `ledgerKeys` come from the on-disk ledger and cover
// a rotation that happened while the app was closed.
function inheritedAccountKeys(row, previousRows = [], ledgerKeys = []) {
  const key = normalizedKey(row?.accountKey);
  const label = accountLabel(row);
  if (!key || !label) return [];
  const scope = identityScope(row);
  const inherited = new Set();
  for (const previous of previousRows) {
    if (!previous || accountLabel(previous) !== label || identityScope(previous) !== scope) continue;
    for (const previousKey of accountKeys(previous)) inherited.add(previousKey);
  }
  for (const ledgerKey of ledgerKeys) {
    const candidate = normalizedKey(ledgerKey);
    if (candidate) inherited.add(candidate);
  }
  inherited.delete(key);
  return [...inherited].slice(0, MAX_INHERITED_KEYS);
}

module.exports = {
  MAX_INHERITED_KEYS,
  accountLabel,
  identityScope,
  inheritedAccountKeys
};
