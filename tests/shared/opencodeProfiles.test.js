'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  credentialKinds,
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

// Refreshing an expired cookie under the account that already owns it changes
// nothing about which account is which, so it must not demand confirmation.
test('replacing the same credential kind is not a binding', () => {
  const result = saveCredential({ work: cookie('auth=old') }, 'work', { cookie: 'auth=new' });
  assert.equal(result.ok, true);
  assert.equal(result.profiles.work.cookie, 'auth=new');
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

test('every operation leaves the caller a fresh map instead of mutating theirs', () => {
  const profiles = { work: { apiKey: 'sk-a', cookie: 'auth=a', enabled: true } };
  const snapshot = JSON.stringify(profiles);
  saveCredential(profiles, 'other', { apiKey: 'sk-b' });
  moveCredential(profiles, 'work', 'api', 'other');
  renameProfile(profiles, 'work', 'other');
  removeCredential(profiles, 'work', 'cookie');
  assert.equal(JSON.stringify(profiles), snapshot);
});
