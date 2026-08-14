'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  credentialKinds,
  ambientKeyFor,
  ambientKeyClaimed,
  saveCredential,
  moveCredential,
  renameProfile,
  removeCredential
} = require('../../src/shared/opencodeProfiles');

const AMBIENT = { useAmbientKey: true, enabled: true };
const cookie = (value = 'auth=a') => ({ cookie: value, enabled: true });
const key = (value = 'sk-a') => ({ apiKey: value, enabled: true });

test('credentialKinds reports only the kinds an account actually holds', () => {
  assert.deepEqual(credentialKinds({ enabled: true }), []);
  assert.deepEqual(credentialKinds({ cookie: 'auth=a', apiKey: '', enabled: true }), ['cookie']);
  assert.deepEqual(
    credentialKinds({ apiKey: 'sk-a', cookie: 'auth=a', useAmbientKey: true }).sort(),
    ['ambient', 'api', 'cookie']
  );
});

test('saving a credential under a fresh name needs no confirmation', () => {
  const result = saveCredential({}, 'work', { apiKey: 'sk-a' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profiles, { work: { enabled: true, apiKey: 'sk-a' } });
});

// The invariant this module exists for: two credentials under one name is the
// user's assertion that they are the same OpenCode account, and nothing may
// make that assertion on their behalf.
test('binding a second credential kind onto an existing account is refused without merge', () => {
  const profiles = { work: cookie() };
  const refused = saveCredential(profiles, 'work', { apiKey: 'sk-a' });
  assert.equal(refused.ok, false);
  assert.equal(refused.nameTaken, true);
  // The refusal must not have written anything.
  assert.deepEqual(profiles, { work: cookie() });

  const confirmed = saveCredential(profiles, 'work', { apiKey: 'sk-a' }, { merge: true });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(confirmed.profiles.work, { cookie: 'auth=a', enabled: true, apiKey: 'sk-a' });
});

test('naming the auto-detected key onto an existing account is the same binding', () => {
  const profiles = { work: cookie() };
  assert.equal(saveCredential(profiles, 'work', { useAmbientKey: true }).nameTaken, true);
  const confirmed = saveCredential(profiles, 'work', { useAmbientKey: true }, { merge: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.profiles.work.useAmbientKey, true);
  assert.equal(confirmed.profiles.work.cookie, 'auth=a');
});

// Refreshing an expired cookie under an account that holds nothing else changes
// nothing about which account is which, so it must not demand confirmation.
test('replacing the same credential kind on a single-credential account is not a binding', () => {
  const result = saveCredential({ work: cookie('auth=old') }, 'work', { cookie: 'auth=new' });
  assert.equal(result.ok, true);
  assert.equal(result.profiles.work.cookie, 'auth=new');
});

// The exemption must not become a hole in the binding rule. On an account whose
// cookie already identifies a workspace, storing a *different* key asserts that
// the new key belongs to that workspace too, which is the same unverifiable
// claim as the original binding and carries the same consequence: publishing one
// account's quota under another's identity.
test('replacing a credential on an account that holds another kind still needs merge', () => {
  const profiles = { work: { cookie: 'auth=b', apiKey: 'sk-a', enabled: true } };
  const refused = saveCredential(profiles, 'work', { apiKey: 'sk-c' });
  assert.equal(refused.ok, false);
  assert.equal(refused.nameTaken, true);
  assert.equal(profiles.work.apiKey, 'sk-a');

  const confirmed = saveCredential(profiles, 'work', { apiKey: 'sk-c' }, { merge: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.profiles.work.apiKey, 'sk-c');
  assert.equal(confirmed.profiles.work.cookie, 'auth=b');
});

test('re-pointing the auto-detected reference on a bound account also needs merge', () => {
  const profiles = { work: { ...AMBIENT, cookie: 'auth=b' } };
  assert.equal(saveCredential(profiles, 'work', { useAmbientKey: true }).nameTaken, true);
});

test('saving into a name that exists but holds nothing is not a binding', () => {
  const result = saveCredential({ work: { enabled: false } }, 'work', { apiKey: 'sk-a' });
  assert.equal(result.ok, true);
  assert.equal(result.profiles.work.apiKey, 'sk-a');
  // An existing account keeps its own enabled state rather than being switched
  // back on by a credential write.
  assert.equal(result.profiles.work.enabled, false);
});

test('saveCredential rejects an empty name and anything that is not one credential', () => {
  assert.equal(saveCredential({}, '  ', { apiKey: 'sk-a' }).ok, false);
  assert.equal(saveCredential({}, 'work', {}).ok, false);
  assert.equal(saveCredential({}, 'work', { apiKey: 'sk-a', cookie: 'auth=a' }).ok, false);
  assert.equal(saveCredential({}, 'work', { nonsense: 1 }).ok, false);
});

test('moving a credential to a fresh name splits it off and drops an emptied account', () => {
  const profiles = { work: { apiKey: 'sk-a', enabled: true } };
  const result = moveCredential(profiles, 'work', 'api', 'personal');
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.profiles), ['personal']);
  assert.equal(result.profiles.personal.apiKey, 'sk-a');
});

test('moving a credential leaves the rest of the account behind', () => {
  const profiles = { work: { apiKey: 'sk-a', cookie: 'auth=a', enabled: true } };
  const result = moveCredential(profiles, 'work', 'api', 'personal');
  assert.equal(result.ok, true);
  assert.deepEqual(result.profiles.work, { cookie: 'auth=a', enabled: true });
  assert.equal(result.profiles.personal.apiKey, 'sk-a');
});

test('moving onto an existing account is refused without merge', () => {
  const profiles = { work: key(), personal: cookie() };
  const refused = moveCredential(profiles, 'work', 'api', 'personal');
  assert.equal(refused.ok, false);
  assert.equal(refused.nameTaken, true);
  assert.deepEqual(profiles, { work: key(), personal: cookie() });

  const confirmed = moveCredential(profiles, 'work', 'api', 'personal', { merge: true });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(Object.keys(confirmed.profiles), ['personal']);
  assert.equal(confirmed.profiles.personal.apiKey, 'sk-a');
  assert.equal(confirmed.profiles.personal.cookie, 'auth=a');
});

// Confirming that two accounts are the same is a different question from
// choosing which of two cookies to keep, so a merge that would overwrite is
// refused rather than silently resolved.
test('a merge that would overwrite the same credential kind is refused even with merge', () => {
  const profiles = { work: cookie('auth=a'), personal: cookie('auth=b') };
  const result = moveCredential(profiles, 'work', 'cookie', 'personal', { merge: true });
  assert.equal(result.ok, false);
  assert.equal(result.credentialConflict, true);
  assert.equal(result.kind, 'cookie');
  assert.deepEqual(profiles, { work: cookie('auth=a'), personal: cookie('auth=b') });
});

test('moving a credential onto its own account is a no-op', () => {
  const result = moveCredential({ work: key() }, 'work', 'api', 'work');
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.profiles.work.apiKey, 'sk-a');
});

test('moveCredential rejects unknown kinds, missing profiles and absent credentials', () => {
  assert.equal(moveCredential({ work: key() }, 'work', 'nope', 'x').ok, false);
  assert.equal(moveCredential({}, 'work', 'api', 'x').ok, false);
  assert.equal(moveCredential({ work: cookie() }, 'work', 'api', 'x').ok, false);
  assert.equal(moveCredential({ work: key() }, 'work', 'api', '   ').ok, false);
});

test('renaming onto an existing account is refused without merge', () => {
  const profiles = { work: key(), personal: cookie() };
  assert.equal(renameProfile(profiles, 'work', 'personal').nameTaken, true);
  assert.deepEqual(profiles, { work: key(), personal: cookie() });

  const confirmed = renameProfile(profiles, 'work', 'personal', { merge: true });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(Object.keys(confirmed.profiles), ['personal']);
  assert.equal(confirmed.profiles.personal.apiKey, 'sk-a');
  assert.equal(confirmed.profiles.personal.cookie, 'auth=a');
});

test('a rename merge that would overwrite a credential is refused', () => {
  const profiles = { work: { apiKey: 'sk-a', cookie: 'auth=a' }, personal: cookie('auth=b') };
  const result = renameProfile(profiles, 'work', 'personal', { merge: true });
  assert.equal(result.ok, false);
  assert.equal(result.credentialConflict, true);
  assert.equal(result.kind, 'cookie');
  assert.equal(profiles.personal.cookie, 'auth=b');
});

test('renaming to a fresh name keeps every credential', () => {
  const result = renameProfile({ work: { ...AMBIENT, cookie: 'auth=a' } }, 'work', 'personal');
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.profiles), ['personal']);
  assert.equal(result.profiles.personal.useAmbientKey, true);
  assert.equal(result.profiles.personal.cookie, 'auth=a');
});

test('renameProfile rejects a blank or unchanged name and a missing profile', () => {
  assert.equal(renameProfile({ work: key() }, 'work', '  ').ok, false);
  assert.equal(renameProfile({ work: key() }, 'work', 'work').ok, false);
  assert.equal(renameProfile({}, 'work', 'personal').ok, false);
});

test('removing one credential leaves the others and reports a removed cookie', () => {
  const result = removeCredential({ work: { apiKey: 'sk-a', cookie: 'auth=a', enabled: true } }, 'work', 'cookie');
  assert.equal(result.ok, true);
  assert.deepEqual(result.profiles.work, { apiKey: 'sk-a', enabled: true });
  assert.equal(result.removedCookie, 'auth=a');
});

test('an account with no credentials left is deleted rather than kept as a name', () => {
  const result = removeCredential({ work: AMBIENT }, 'work', 'ambient');
  assert.equal(result.ok, true);
  assert.deepEqual(result.profiles, {});
});

test('removeCredential rejects unknown kinds and credentials that are not there', () => {
  assert.equal(removeCredential({ work: key() }, 'work', 'nope').ok, false);
  assert.equal(removeCredential({ work: key() }, 'work', 'cookie').ok, false);
  assert.equal(removeCredential({}, 'work', 'api').ok, false);
});

// The usage API returns no workspace id, so "same account, rotated key" and
// "signed into a different account" are indistinguishable. A reference that was
// bound to one account must not silently start resolving to another's key while
// still paired with this account's cookie.
test('a bound auto-detected reference stops resolving once the key changes', () => {
  const bound = { useAmbientKey: true, ambientKeyIdentity: 'go-api:aaa', cookie: 'auth=b' };
  assert.equal(ambientKeyFor(bound, 'sk-current', 'go-api:aaa'), 'sk-current');
  assert.equal(ambientKeyFor(bound, 'sk-other', 'go-api:bbb'), '');
});

// `useAmbientKey` ships with this feature, so there is no released state that
// stores an unpinned reference. Accepting one would not be compatibility with
// anything; it would be a standing bypass of the rule above.
test('a reference with no pin resolves nothing', () => {
  assert.equal(ambientKeyFor({ useAmbientKey: true }, 'sk-current', 'go-api:aaa'), '');
  assert.equal(ambientKeyFor({ useAmbientKey: true, cookie: 'auth=b' }, 'sk-current', 'go-api:aaa'), '');
});

test('ambientKeyFor resolves nothing without a reference or without a key', () => {
  assert.equal(ambientKeyFor({ cookie: 'auth=b' }, 'sk-current', 'go-api:aaa'), '');
  assert.equal(ambientKeyFor({ useAmbientKey: true }, '', ''), '');
  assert.equal(ambientKeyFor(null, 'sk-current', 'go-api:aaa'), '');
});

// The pin is part of the credential, not metadata sitting beside it. Moving the
// reference without it would leave an unpinned reference on the destination,
// which is exactly the state `ambientKeyFor` refuses to resolve, and would put
// the rotation protection back where it was before it existed.
test('moving the auto-detected reference carries its pin with it', () => {
  const profiles = {
    work: { cookie: 'auth=b', useAmbientKey: true, ambientKeyIdentity: 'go-api:aaa', enabled: true }
  };
  const result = moveCredential(profiles, 'work', 'ambient', 'personal');
  assert.equal(result.ok, true);
  assert.deepEqual(result.profiles.work, { cookie: 'auth=b', enabled: true });
  assert.equal(result.profiles.personal.useAmbientKey, true);
  assert.equal(result.profiles.personal.ambientKeyIdentity, 'go-api:aaa');
  // And the moved credential still resolves only for the key it was bound to.
  assert.equal(ambientKeyFor(result.profiles.personal, 'sk-a', 'go-api:aaa'), 'sk-a');
  assert.equal(ambientKeyFor(result.profiles.personal, 'sk-c', 'go-api:ccc'), '');
});

// An orphaned pin is not litter: a later merge spreads the source over the
// destination, so it would overwrite the pin of a real reference it merges into.
test('removing the auto-detected reference removes its pin too', () => {
  const profiles = {
    work: { cookie: 'auth=b', useAmbientKey: true, ambientKeyIdentity: 'go-api:aaa', enabled: true }
  };
  const result = removeCredential(profiles, 'work', 'ambient');
  assert.equal(result.ok, true);
  assert.deepEqual(result.profiles.work, { cookie: 'auth=b', enabled: true });
});

test('a merge cannot carry an orphaned pin onto a real reference', () => {
  // Constructed directly rather than through removeCredential, which no longer
  // produces it: the merge must not depend on that being the only source.
  const profiles = {
    stale: { cookie: 'auth=b', ambientKeyIdentity: 'go-api:aaa', enabled: true },
    live: { useAmbientKey: true, ambientKeyIdentity: 'go-api:bbb', enabled: true }
  };
  const result = renameProfile(profiles, 'stale', 'live', { merge: true });
  assert.equal(result.ok, true);
  assert.equal(result.profiles.live.ambientKeyIdentity, 'go-api:bbb');
  assert.equal(ambientKeyFor(result.profiles.live, 'sk-b', 'go-api:bbb'), 'sk-b');
});

test('the auto-detected key is claimed by a resolving reference or a stored copy', () => {
  const claimed = (profiles) => ambientKeyClaimed(profiles, 'sk-a', 'go-api:aaa');
  assert.equal(claimed({}), false);
  assert.equal(claimed({ work: cookie() }), false);
  assert.equal(claimed({ work: { useAmbientKey: true, ambientKeyIdentity: 'go-api:aaa' } }), true);
  assert.equal(claimed({ work: { apiKey: 'sk-a' } }), true);
  // A reference whose key has changed owns nothing: the key on the machine now
  // belongs to whoever is signed in, not to the account that stored it.
  assert.equal(claimed({ work: { useAmbientKey: true, ambientKeyIdentity: 'go-api:bbb' } }), false);
  assert.equal(ambientKeyClaimed({ work: { apiKey: 'sk-a' } }, '', ''), false);
});

// Both reviews of this design landed on the same answer and it is easy to
// reverse by accident: credentials belong to the account holding them, so
// disabling an account turns off its key as well. Handing the same key back as
// an unnamed row would resurrect, under another name, the account the user just
// switched off.
test('a disabled account still owns the auto-detected key', () => {
  const profiles = { work: { useAmbientKey: true, ambientKeyIdentity: 'go-api:aaa', enabled: false } };
  assert.equal(ambientKeyClaimed(profiles, 'sk-a', 'go-api:aaa'), true);
});

test('every operation leaves the caller a fresh map instead of mutating theirs', () => {
  const profiles = { work: { apiKey: 'sk-a', cookie: 'auth=a', enabled: true } };
  const snapshot = JSON.stringify(profiles);
  saveCredential(profiles, 'other', { apiKey: 'sk-b' });
  moveCredential(profiles, 'work', 'api', 'other');
  renameProfile(profiles, 'work', 'other');
  removeCredential(profiles, 'work', 'cookie');
  assert.equal(JSON.stringify(profiles), snapshot);
});

// `enabled` describes the account, not the credential, and the two directions
// of a move answer differently. The bug these pin was one operation reading two
// ways depending on which function reached it: a merge took the source's state
// (so absorbing a switched-off account switched off the one it merged into),
// while a split took neither and forced `true` (so a credential pulled out of a
// switched-off account started reporting the moment it got a name).
test('splitting a credential onto a new name carries the account state with it', () => {
  const profiles = { work: { apiKey: 'sk-a', cookie: 'auth=a', enabled: false } };
  const result = moveCredential(profiles, 'work', 'api', 'spare');
  assert.equal(result.ok, true);
  assert.equal(result.profiles.spare.enabled, false);
  assert.equal(result.profiles.work.enabled, false);
});

test('merging a credential into an existing account keeps that account switched on', () => {
  const profiles = {
    work: { apiKey: 'sk-a', enabled: false },
    personal: { cookie: 'auth=b', enabled: true }
  };
  const result = moveCredential(profiles, 'work', 'api', 'personal', { merge: true });
  assert.equal(result.ok, true);
  assert.equal(result.profiles.personal.enabled, true);
});

test('renaming a whole account onto another keeps the destination account state', () => {
  const profiles = {
    work: { apiKey: 'sk-a', enabled: true },
    personal: { cookie: 'auth=b', enabled: false }
  };
  const result = renameProfile(profiles, 'work', 'personal', { merge: true });
  assert.equal(result.ok, true);
  assert.equal(result.profiles.personal.enabled, false);
  assert.equal(result.profiles.personal.apiKey, 'sk-a');
});

test('a plain rename carries the account state to the new name', () => {
  const profiles = { work: { cookie: 'auth=a', enabled: false } };
  const result = renameProfile(profiles, 'work', 'personal');
  assert.equal(result.ok, true);
  assert.equal(result.profiles.personal.enabled, false);
});

test('saving another credential under a switched-off account does not switch it on', () => {
  const profiles = { work: { cookie: 'auth=a', enabled: false } };
  const result = saveCredential(profiles, 'work', { apiKey: 'sk-a' }, { merge: true });
  assert.equal(result.ok, true);
  assert.equal(result.profiles.work.enabled, false);
});

// Account names are typed by the user and this map is keyed on them, so a name
// that collides with an inherited key must behave like any other string. On a
// normal object it did not: the save reported success and stored nothing, and
// the account then read as present through the prototype.
test('an account name that collides with an inherited key is stored like any other', () => {
  const result = saveCredential({}, '__proto__', { apiKey: 'sk-a' });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.profiles), ['__proto__']);
  assert.equal(Object.hasOwn(result.profiles, '__proto__'), true);
  assert.equal(result.profiles['__proto__'].apiKey, 'sk-a');
  assert.equal({}.apiKey, undefined);
});

test('an inherited key is not mistaken for an account that exists', () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.equal(renameProfile({}, name, 'work').ok, false);
    assert.equal(moveCredential({}, name, 'api', 'work').ok, false);
    assert.equal(removeCredential({}, name, 'api').ok, false);
  }
});

test('a collision-prone name round-trips through JSON like a stored setting', () => {
  const saved = saveCredential({}, '__proto__', { cookie: 'auth=a' }).profiles;
  const reloaded = JSON.parse(JSON.stringify(saved));
  const result = removeCredential(reloaded, '__proto__', 'cookie');
  assert.equal(result.ok, true);
  assert.equal(result.removedCookie, 'auth=a');
  assert.deepEqual(Object.keys(result.profiles), []);
});
