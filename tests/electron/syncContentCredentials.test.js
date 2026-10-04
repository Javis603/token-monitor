'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { destinationIdentity } = require('../../src/electron/syncContentRuntime');
const { createSyncContentCredentialQueue } = require('../../src/electron/syncContentCredentials');

test('pending title cleanup stores old connection credentials only in the existing private store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-content-credentials-'));
  try {
    const store = new CredentialStore(dir);
    store.replaceSettingsCredentials({ secret: 'current-hub-secret' });
    const context = { mode: 'client', url: 'https://old.example', secret: 'old-hub-secret', deviceId: 'one' };
    context.identity = destinationIdentity(context);
    const queue = createSyncContentCredentialQueue(() => store);
    queue.save(context);
    assert.equal(new CredentialStore(dir).settingsCredentials().secret, 'current-hub-secret');
    assert.deepEqual(new Map(createSyncContentCredentialQueue(() => new CredentialStore(dir)).read()).get(context.identity), context);
    assert.equal(Object.values(store.settingsCredentials()).includes('old-hub-secret'), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
    queue.remove(context.identity);
    assert.deepEqual(queue.read(), []);
    assert.doesNotMatch(fs.readFileSync(store.filePath, 'utf8'), /old-hub-secret/);
    assert.equal(store.settingsCredentials().secret, 'current-hub-secret');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an invalid cleanup identity cannot substitute another server context', () => {
  let document = { version: 1, credentials: { hub: { syncTitleCleanup: { forged: {
    mode: 'client', url: 'https://other.example', secret: 'secret', deviceId: 'one'
  } } } }, migrations: {} };
  const queue = createSyncContentCredentialQueue(() => ({ readDocument: () => structuredClone(document),
    writeDocument: next => { document = next; } }));
  assert.deepEqual(queue.read(), []);
});
