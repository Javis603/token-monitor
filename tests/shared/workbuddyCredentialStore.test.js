'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CredentialStore } = require('../../src/shared/credentialStore');

test('WorkBuddy credentials use existing private nested store and survive settings credential replacement', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-credentials-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  const credential = { accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresAt: 1234,
    refreshExpiresAt: 5678, domain: 'www.codebuddy.cn' };
  assert.equal(store.readWorkbuddyCredential('a'), null);
  assert.equal(store.writeWorkbuddyCredential('a', credential), true);
  const read = store.readWorkbuddyCredential('a');
  read.accessToken = 'mutated';
  assert.deepEqual(store.readWorkbuddyCredential('a'), credential);
  store.writeAntigravityCredential('a', { accessToken: 'unrelated' });
  store.replaceSettingsCredentials({ secret: 'hub-secret' });
  assert.deepEqual(new CredentialStore(dir).readWorkbuddyCredential('a'), credential);
  assert.deepEqual(store.readDocument().credentials.providers.workbuddy.accounts.a.credentials, credential);
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
  assert.equal(store.removeWorkbuddyCredential('a'), true);
  assert.equal(store.readWorkbuddyCredential('a'), null);
  assert.equal(store.readAntigravityCredential('a').accessToken, 'unrelated');
});

test('WorkBuddy dynamic ids reject prototype keys and failed atomic writes preserve old credentials', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-credentials-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  for (const id of ['__proto__', 'constructor', 'prototype', '']) {
    assert.equal(store.writeWorkbuddyCredential(id, { accessToken: 'secret' }), false);
    assert.equal(store.removeWorkbuddyCredential(id), false);
    assert.equal(store.readWorkbuddyCredential(id), null);
  }
  store.writeWorkbuddyCredential('a', { accessToken: 'old' });
  const failing = new CredentialStore(dir, { fs: { ...fs,
    renameSync: () => { throw new Error('write failure'); } } });
  assert.throws(() => failing.writeWorkbuddyCredential('a', { accessToken: 'new' }));
  assert.equal(store.readWorkbuddyCredential('a').accessToken, 'old');
  assert.deepEqual(fs.readdirSync(dir), ['credentials.json']);
});
