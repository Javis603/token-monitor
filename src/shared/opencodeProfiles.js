'use strict';

// Pure profile-map algebra for OpenCode accounts.
//
// An account is a name, and credentials belong to a name. Two credentials under
// one name is the user's assertion that they are the same OpenCode account, and
// that assertion is the only thing that licenses reading Go quota from one while
// identity and the Zen balance come from another — nothing can verify it, since
// the usage API returns no workspace id to compare against the cookie's.
//
// That makes "these are one account" a decision, not a side effect, so the rule
// lives here rather than in whichever UI path happens to ask for confirmation.
// Every operation that could bind two credentials refuses until the caller
// passes `merge: true`, and every operation that could destroy a credential the
// user still holds refuses outright. The functions are pure so the invariant is
// testable on its own, without an Electron main process around it.

const CREDENTIAL_FIELDS = { api: 'apiKey', cookie: 'cookie', ambient: 'useAmbientKey' };

function credentialField(kind) {
  return Object.prototype.hasOwnProperty.call(CREDENTIAL_FIELDS, kind) ? CREDENTIAL_FIELDS[kind] : '';
}

function credentialKind(field) {
  return Object.keys(CREDENTIAL_FIELDS).find((kind) => CREDENTIAL_FIELDS[kind] === field) || '';
}

// Which credential kinds an account actually holds. `useAmbientKey` is a
// reference rather than a value, so presence is truthiness in every case.
function credentialKinds(profile) {
  if (!profile || typeof profile !== 'object') return [];
  return Object.keys(CREDENTIAL_FIELDS).filter((kind) => Boolean(profile[CREDENTIAL_FIELDS[kind]]));
}

function hasAnyCredential(profile) {
  return credentialKinds(profile).length > 0;
}

function cloneProfiles(profiles) {
  const next = {};
  for (const [name, profile] of Object.entries(profiles || {})) {
    if (profile && typeof profile === 'object') next[name] = { ...profile };
  }
  return next;
}

// Stores one credential under `name`, replacing only that kind.
//
// Landing on an account that already holds a *different* kind is a binding, so
// it needs `merge: true`. Replacing the same kind is not: refreshing an expired
// cookie or rotating a key under the account that already owns it changes
// nothing about which account is which.
function saveCredential(profiles, name, credential, options = {}) {
  const accountName = String(name || '').trim();
  if (!accountName) return { ok: false, error: 'Empty name' };
  if (!credential || typeof credential !== 'object') return { ok: false, error: 'Empty credential' };
  const fields = Object.keys(credential).filter((key) => credentialKind(key));
  if (fields.length !== 1) return { ok: false, error: 'Expected exactly one credential' };
  const [field] = fields;

  const next = cloneProfiles(profiles);
  const existing = next[accountName];
  if (existing && hasAnyCredential(existing) && !existing[field] && options.merge !== true) {
    return { ok: false, error: 'Profile name already exists', nameTaken: true };
  }
  next[accountName] = { enabled: true, ...(existing || {}), ...credential };
  return { ok: true, profiles: next };
}

// Moves one credential to another account name, creating it when needed. Moving
// to a fresh name splits the credential off; moving onto an existing name binds
// it there, which is the same assertion `saveCredential` gates.
function moveCredential(profiles, name, kind, targetName, options = {}) {
  const field = credentialField(kind);
  if (!field) return { ok: false, error: `Unknown credential kind: ${kind}` };
  const source = (profiles || {})[name];
  if (!source) return { ok: false, error: 'Profile not found' };
  if (!source[field]) return { ok: false, error: 'Credential not found' };

  const target = String(targetName || '').trim();
  if (!target) return { ok: false, error: 'Empty name' };
  if (target === name) return { ok: true, profiles: cloneProfiles(profiles), unchanged: true };

  const next = cloneProfiles(profiles);
  const destination = next[target];
  if (destination && options.merge !== true) {
    return { ok: false, error: 'Profile name already exists', nameTaken: true };
  }
  // A merge combines two accounts; it must not quietly discard one of their
  // credentials. Confirming that two accounts are the same is a different
  // question from choosing which of two cookies to keep, so this refuses rather
  // than asking, and the user removes the one they do not want first.
  if (destination && destination[field]) {
    return { ok: false, error: 'Credential already exists', credentialConflict: true, kind };
  }

  const remaining = { ...source };
  const value = remaining[field];
  delete remaining[field];
  if (hasAnyCredential(remaining)) next[name] = remaining;
  else delete next[name];
  next[target] = { enabled: true, ...(destination || {}), [field]: value };
  // No `removedCookie`: a move keeps the credential, so the legacy single-cookie
  // mirror in settings still points at something that exists.
  return { ok: true, profiles: next };
}

// Renames an account, merging into an existing name when the caller confirms.
function renameProfile(profiles, oldName, newName, options = {}) {
  const target = String(newName || '').trim();
  if (!target || oldName === target) return { ok: false, error: 'Invalid name' };
  const source = (profiles || {})[oldName];
  if (!source) return { ok: false, error: 'Profile not found' };

  const next = cloneProfiles(profiles);
  const destination = next[target];
  if (destination && options.merge !== true) {
    return { ok: false, error: 'Profile name already exists', nameTaken: true };
  }
  if (destination) {
    const conflict = credentialKinds(source).find((kind) => Boolean(destination[CREDENTIAL_FIELDS[kind]]));
    if (conflict) {
      return { ok: false, error: 'Credential already exists', credentialConflict: true, kind: conflict };
    }
  }
  next[target] = { enabled: true, ...(destination || {}), ...source };
  delete next[oldName];
  return { ok: true, profiles: next };
}

// Removes one credential and leaves the others. An account with none left is a
// name, not an account, so it goes too.
function removeCredential(profiles, name, kind) {
  const field = credentialField(kind);
  if (!field) return { ok: false, error: `Unknown credential kind: ${kind}` };
  const profile = (profiles || {})[name];
  if (!profile) return { ok: false, error: 'Profile not found' };
  if (!profile[field]) return { ok: false, error: 'Credential not found' };

  const next = cloneProfiles(profiles);
  const remaining = { ...profile };
  const removed = remaining[field];
  delete remaining[field];
  if (hasAnyCredential(remaining)) next[name] = remaining;
  else delete next[name];
  return { ok: true, profiles: next, removedCookie: field === 'cookie' ? removed : '' };
}

module.exports = {
  CREDENTIAL_FIELDS,
  credentialField,
  credentialKinds,
  hasAnyCredential,
  saveCredential,
  moveCredential,
  renameProfile,
  removeCredential
};
