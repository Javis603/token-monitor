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

// A credential is a set of properties, not always a single field. The
// auto-detected reference carries the identity of the key it was bound to, and
// that pin is the whole of its rotation protection: separating the two leaves an
// unpinned reference, which is a state nothing is allowed to create. Declared as
// a table so a credential that grows another property later is one entry here
// rather than a third place that has to remember.
const CREDENTIAL_COMPANIONS = { ambient: ['ambientKeyIdentity'] };

function credentialField(kind) {
  return Object.prototype.hasOwnProperty.call(CREDENTIAL_FIELDS, kind) ? CREDENTIAL_FIELDS[kind] : '';
}

// Every property belonging to one credential. They move, and are removed,
// together or not at all.
function credentialProperties(kind) {
  const field = credentialField(kind);
  if (!field) return [];
  return [field, ...(CREDENTIAL_COMPANIONS[kind] || [])];
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

// A companion without its credential is meaningless, and worse than meaningless
// in a merge: the source is spread over the destination, so a stray pin would
// land on top of the pin of a real reference. Dropping them keeps the rule
// "a companion only ever travels with its credential" true in both directions.
function withoutOrphanCompanions(profile) {
  const clean = { ...profile };
  for (const [kind, companions] of Object.entries(CREDENTIAL_COMPANIONS)) {
    if (clean[CREDENTIAL_FIELDS[kind]]) continue;
    for (const property of companions) delete clean[property];
  }
  return clean;
}

// Account names are typed by the user, and this map is keyed on them. On a
// normal object `next['__proto__'] = {…}` sets the prototype instead of adding
// an entry, so saving an account named `__proto__` reported success and stored
// nothing, and a later `profiles[name].enabled = …` wrote through to a shared
// prototype. A null-prototype map has no inherited key to collide with, which
// is the fix for the whole class rather than for the one name that names it.
// It survives the JSON round trip through settings.json: `JSON.parse` creates
// an own property for `__proto__`, and spreading copies own properties without
// invoking the setter.
function emptyProfiles() {
  return Object.create(null);
}

// Reads must not fall through to the prototype either, or `__proto__` resolves
// to an inherited object and reads as an account that exists.
function readProfile(profiles, name) {
  if (!profiles || typeof profiles !== 'object') return undefined;
  return Object.hasOwn(profiles, name) ? profiles[name] : undefined;
}

function cloneProfiles(profiles) {
  const next = emptyProfiles();
  for (const [name, profile] of Object.entries(profiles || {})) {
    if (profile && typeof profile === 'object') next[name] = { ...profile };
  }
  return next;
}

// `enabled` describes the account, not the credential, which settles both
// directions of a move. Merging into an existing account keeps that account's
// own state: absorbing a credential is not a request to flip its switch.
// Splitting a credential onto a new name carries the source account's state,
// because a credential taken out of a switched-off account must not start
// reporting the moment it gets a name of its own. Resolved explicitly rather
// than by spread order, which had merges take the source and splits take
// neither — the same operation reading two different ways depending on which
// function reached it.
function accountEnabled(profile) {
  return !profile || profile.enabled !== false;
}

// Stores one credential under `name`, replacing only that kind.
//
// Confirmation is required whenever the write would state something new about
// which credentials belong together. On an account that holds nothing else,
// replacing the same kind states nothing: refreshing an expired cookie under
// the account that already owns it leaves the pairing exactly as it was, and
// making that ask would be noise.
//
// On an account that already holds another kind it is not a replacement in that
// sense. Storing a different API key under an account whose cookie identifies
// workspace B asserts that the new key also belongs to B, which is the same
// unverifiable claim as binding it there in the first place — and the one whose
// consequence is publishing one account's quota under another's identity. So
// the exemption is narrow: no other credential present.
function saveCredential(profiles, name, credential, options = {}) {
  const accountName = String(name || '').trim();
  if (!accountName) return { ok: false, error: 'Empty name' };
  if (!credential || typeof credential !== 'object') return { ok: false, error: 'Empty credential' };
  const fields = Object.keys(credential).filter((key) => credentialKind(key));
  if (fields.length !== 1) return { ok: false, error: 'Expected exactly one credential' };
  const [field] = fields;

  const next = cloneProfiles(profiles);
  const existing = readProfile(next, accountName);
  const otherKinds = credentialKinds(existing).filter((kind) => CREDENTIAL_FIELDS[kind] !== field);
  const changesPairing = existing && (otherKinds.length > 0 || (hasAnyCredential(existing) && !existing[field]));
  if (changesPairing && options.merge !== true) {
    return { ok: false, error: 'Profile name already exists', nameTaken: true };
  }
  next[accountName] = { ...(existing || {}), ...credential, enabled: accountEnabled(existing) };
  return { ok: true, profiles: next };
}

// The account the auto-detected key belongs to is the one that was signed in
// when the reference was stored. The usage API returns no workspace id, so a key
// that has since changed cannot be told apart from a different account's key:
// "same account, rotated key" and "signed into another account" look identical.
// Pairing the new key with this account's cookie would publish that account's
// quota under this one's workspace identity, which is precisely what nothing is
// allowed to assert automatically.
//
// A reference with no pin resolves nothing. There is no released version that
// stores one — `useAmbientKey` arrives with this feature — so treating a missing
// pin as "trust whatever key is here now" would not be compatibility with
// anything, it would be shipping the bypass on purpose. The account falls back
// to its other credentials and the key returns as its own auto-detected row,
// which the user can re-attach; that write records a pin.
function ambientKeyFor(profile, ambientKey, ambientIdentity) {
  if (!profile?.useAmbientKey || !ambientKey) return '';
  if (!profile.ambientKeyIdentity || profile.ambientKeyIdentity !== ambientIdentity) return '';
  return ambientKey;
}

// Whether a stored account owns the auto-detected key: by holding a reference
// that still resolves to it, or by having stored the same key verbatim. While
// nothing claims it, it is tracked as an account of its own, which is what keeps
// the zero-config path alive.
//
// Deliberately looks at every account, enabled or not. Credentials belong to the
// account holding them, so disabling one turns off its key too; handing that
// same key back as an unnamed row would resurrect, under another name, the
// account the user just switched off.
//
// Shared rather than reimplemented per caller: the collector decides whether to
// scan it and the settings panel decides whether to show it, and a disagreement
// between those two is a row the panel reports on and nothing is reading.
function ambientKeyClaimed(profiles, ambientKey, ambientIdentity) {
  if (!ambientKey) return false;
  return Object.values(profiles || {}).some((profile) => (
    Boolean(ambientKeyFor(profile, ambientKey, ambientIdentity)) || profile?.apiKey === ambientKey
  ));
}

// Moves one credential to another account name, creating it when needed. Moving
// to a fresh name splits the credential off; moving onto an existing name binds
// it there, which is the same assertion `saveCredential` gates.
function moveCredential(profiles, name, kind, targetName, options = {}) {
  const field = credentialField(kind);
  if (!field) return { ok: false, error: `Unknown credential kind: ${kind}` };
  const source = readProfile(profiles, name);
  if (!source) return { ok: false, error: 'Profile not found' };
  if (!source[field]) return { ok: false, error: 'Credential not found' };

  const target = String(targetName || '').trim();
  if (!target) return { ok: false, error: 'Empty name' };
  if (target === name) return { ok: true, profiles: cloneProfiles(profiles), unchanged: true };

  const next = cloneProfiles(profiles);
  const destination = readProfile(next, target);
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
  const moved = {};
  for (const property of credentialProperties(kind)) {
    if (property in remaining) moved[property] = remaining[property];
    delete remaining[property];
  }
  if (hasAnyCredential(remaining)) next[name] = remaining;
  else delete next[name];
  next[target] = {
    ...(destination || {}),
    ...moved,
    enabled: accountEnabled(destination || source)
  };
  // No `removedCookie`: a move keeps the credential, so the legacy single-cookie
  // mirror in settings still points at something that exists.
  return { ok: true, profiles: next };
}

// Renames an account, merging into an existing name when the caller confirms.
function renameProfile(profiles, oldName, newName, options = {}) {
  const target = String(newName || '').trim();
  if (!target || oldName === target) return { ok: false, error: 'Invalid name' };
  const source = readProfile(profiles, oldName);
  if (!source) return { ok: false, error: 'Profile not found' };

  const next = cloneProfiles(profiles);
  const destination = readProfile(next, target);
  if (destination && options.merge !== true) {
    return { ok: false, error: 'Profile name already exists', nameTaken: true };
  }
  if (destination) {
    const conflict = credentialKinds(source).find((kind) => Boolean(destination[CREDENTIAL_FIELDS[kind]]));
    if (conflict) {
      return { ok: false, error: 'Credential already exists', credentialConflict: true, kind: conflict };
    }
  }
  next[target] = {
    ...withoutOrphanCompanions(destination || {}),
    ...withoutOrphanCompanions(source),
    enabled: accountEnabled(destination || source)
  };
  delete next[oldName];
  return { ok: true, profiles: next };
}

// Removes one credential and leaves the others. An account with none left is a
// name, not an account, so it goes too.
function removeCredential(profiles, name, kind) {
  const field = credentialField(kind);
  if (!field) return { ok: false, error: `Unknown credential kind: ${kind}` };
  const profile = readProfile(profiles, name);
  if (!profile) return { ok: false, error: 'Profile not found' };
  if (!profile[field]) return { ok: false, error: 'Credential not found' };

  const next = cloneProfiles(profiles);
  const remaining = { ...profile };
  const removed = remaining[field];
  // Companions go too. An orphaned `ambientKeyIdentity` is not merely litter: a
  // later merge spreads the source over the destination, so it would overwrite
  // the pin of a real reference on the account being merged into.
  for (const property of credentialProperties(kind)) delete remaining[property];
  if (hasAnyCredential(remaining)) next[name] = remaining;
  else delete next[name];
  return { ok: true, profiles: next, removedCookie: field === 'cookie' ? removed : '' };
}

module.exports = {
  CREDENTIAL_FIELDS,
  accountEnabled,
  readProfile,
  credentialField,
  credentialProperties,
  credentialKinds,
  hasAnyCredential,
  ambientKeyFor,
  ambientKeyClaimed,
  saveCredential,
  moveCredential,
  renameProfile,
  removeCredential
};
