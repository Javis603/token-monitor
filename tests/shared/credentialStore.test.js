'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CredentialStore,
  credentialSettingsForRenderer,
  hasCredentialSettings,
  stripCredentialSettings,
  writePrivateJsonAtomic
} = require('../../src/shared/credentialStore');

function tempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-credentials-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('stores credential settings in a versioned provider document', (t) => {
  const dataDir = tempDataDir(t);
  const store = new CredentialStore(dataDir);
  store.replaceSettingsCredentials({
    hubHostSecret: 'host-secret',
    secret: 'client-secret',
    deepseekApiKey: 'deepseek-key',
    opencodeProfiles: { work: { cookie: 'auth=secret', enabled: true } },
    zaiTeamOrganizationId: 'organization-id',
    qoderCookie: ''
  });

  const document = JSON.parse(fs.readFileSync(path.join(dataDir, 'credentials.json'), 'utf8'));
  assert.equal(document.version, 1);
  assert.equal(document.credentials.hub.hostSecret, 'host-secret');
  assert.equal(document.credentials.hub.clientSecret, 'client-secret');
  assert.equal(document.credentials.providers.deepseek.apiKey, 'deepseek-key');
  assert.equal(document.credentials.providers.opencode.profiles.work.cookie, 'auth=secret');
  assert.equal(document.credentials.providers.zaiTeam.organizationId, 'organization-id');
  assert.equal(document.credentials.providers.qoder, undefined);
  assert.equal(document.migrations.settings, 1);

  assert.deepEqual(store.settingsCredentials(), {
    hubHostSecret: 'host-secret',
    secret: 'client-secret',
    opencodeProfiles: { work: { cookie: 'auth=secret', enabled: true } },
    deepseekApiKey: 'deepseek-key',
    zaiTeamOrganizationId: 'organization-id'
  });
});

test('removes credential fields from settings without mutating runtime state', () => {
  const settings = { language: 'auto', deepseekApiKey: 'secret', opencodeProfiles: { a: { cookie: 'secret' } } };
  const clean = stripCredentialSettings(settings);
  assert.deepEqual(clean, { language: 'auto' });
  assert.equal(settings.deepseekApiKey, 'secret');
  assert.equal(settings.opencodeProfiles.a.cookie, 'secret');
  assert.equal(hasCredentialSettings(settings), true);
  assert.equal(hasCredentialSettings(clean), false);
});

test('renderer redaction defaults new credential fields to hidden with explicit exceptions', () => {
  const settings = {
    hubHostSecret: 'host-secret',
    secret: 'client-secret',
    deepseekApiKey: 'provider-secret',
    opencodeProfiles: { work: { cookie: 'auth=secret' } }
  };
  const redacted = credentialSettingsForRenderer(settings, { expose: ['hubHostSecret', 'secret'] });
  assert.equal(redacted.hubHostSecret, 'host-secret');
  assert.equal(redacted.secret, 'client-secret');
  assert.equal(redacted.deepseekApiKey, '');
  assert.equal(redacted.opencodeProfiles, '');
  assert.equal(redacted.kimiApiKey, '');
});

test('migrates legacy settings once and keeps an existing credential authoritative', (t) => {
  const store = new CredentialStore(tempDataDir(t));
  store.writeDocument({
    version: 1,
    credentials: { providers: { deepseek: { apiKey: 'current-key' } } },
    migrations: {}
  });

  const first = store.migrateLegacySettings({ deepseekApiKey: 'legacy-key', kimiApiKey: 'legacy-kimi' });
  assert.equal(first.migrated, true);
  assert.equal(store.settingsCredentials().deepseekApiKey, 'current-key');
  assert.equal(store.settingsCredentials().kimiApiKey, 'legacy-kimi');

  const second = store.migrateLegacySettings({ kimiApiKey: 'stale-kimi' });
  assert.equal(second.migrated, false);
  assert.equal(store.settingsCredentials().kimiApiKey, 'legacy-kimi');
});

test('clearing a runtime credential removes it without resurrecting legacy data', (t) => {
  const store = new CredentialStore(tempDataDir(t));
  store.migrateLegacySettings({ kimiApiKey: 'legacy-kimi' });
  store.replaceSettingsCredentials({ kimiApiKey: '' });
  assert.equal(store.settingsCredentials().kimiApiKey, undefined);
  assert.equal(store.migrateLegacySettings({ kimiApiKey: 'legacy-kimi' }).migrated, false);
  assert.equal(store.settingsCredentials().kimiApiKey, undefined);
});

test('writes private JSON atomically with owner-only permissions', (t) => {
  const dataDir = tempDataDir(t);
  const filePath = path.join(dataDir, 'private.json');
  writePrivateJsonAtomic(filePath, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { ok: true });
  assert.equal(fs.readdirSync(dataDir).some((name) => name.endsWith('.tmp')), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
});

test('does not overwrite a corrupt credential store', (t) => {
  const dataDir = tempDataDir(t);
  const filePath = path.join(dataDir, 'credentials.json');
  fs.writeFileSync(filePath, '{broken', 'utf8');
  const store = new CredentialStore(dataDir);
  assert.throws(() => store.replaceSettingsCredentials({ kimiApiKey: 'new-key' }), SyntaxError);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
});

test('refuses to follow a credential-store symlink', { skip: process.platform === 'win32' }, (t) => {
  const dataDir = tempDataDir(t);
  const target = path.join(dataDir, 'target.json');
  const filePath = path.join(dataDir, 'credentials.json');
  fs.writeFileSync(target, JSON.stringify({ version: 1, credentials: {}, migrations: {} }), 'utf8');
  fs.symlinkSync(target, filePath);
  const store = new CredentialStore(dataDir);
  assert.throws(() => store.readDocument(), /regular file/);
});

test('stores, migrates, and removes MiMo account cookies in the unified store', (t) => {
  const store = new CredentialStore(tempDataDir(t));
  const migration = store.migrateLegacyMimoCredentials([
    { id: 'account-1', cookieHeader: 'serviceToken=legacy' }
  ]);
  assert.deepEqual(migration.migratedIds, ['account-1']);
  assert.equal(store.readMimoCredential('account-1'), 'serviceToken=legacy');

  assert.equal(store.writeMimoCredential('account-2', 'serviceToken=current'), true);
  assert.equal(store.readMimoCredential('account-2'), 'serviceToken=current');
  assert.equal(store.removeMimoCredential('account-1'), true);
  assert.equal(store.readMimoCredential('account-1'), '');
  assert.equal(store.writeMimoCredential('__proto__', 'serviceToken=unsafe'), false);
});
