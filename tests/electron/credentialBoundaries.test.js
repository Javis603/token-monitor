'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { CREDENTIAL_SETTING_PATHS, credentialSettingsForRenderer } = require('../../src/shared/credentialStore');
const {
  accountFieldProjection,
  accountStatusProjection,
  limitAccountFormsForRenderer,
  rendererOmittedAccountKeys
} = require('../../src/electron/limits/accountSettings');

test('the main settings IPC projection hides provider secrets while retaining configured state', () => {
  const secrets = [];
  const settings = { language: 'en', hubHostSecret: 'allowed-host-secret', secret: 'allowed-client-secret' };
  for (const key of Object.keys(CREDENTIAL_SETTING_PATHS)) {
    if (key === 'hubHostSecret' || key === 'secret') continue;
    const value = `private-${key}-sentinel`;
    secrets.push(value);
    settings[key] = key.endsWith('Profiles')
      ? { work: { enabled: true, cookie: value, apiKey: value, accessToken: value, futureSecret: value } }
      : value;
  }
  for (const key of rendererOmittedAccountKeys()) {
    const value = `private-${key}-sentinel`;
    secrets.push(value);
    settings[key] = value;
  }
  settings.icloudWriterId = 'private-writer-id';
  settings.icloudRetiredDeviceIds = ['private-retired-device'];
  settings.syncContentState = { privateCleanupState: true };
  const snapshot = structuredClone(settings);
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = main.indexOf('function settingsForRenderer(');
  const end = main.indexOf('function systemDarkTrayUi(', start);
  assert.ok(start >= 0 && end > start);

  // Execute the production projection with real registry redactors. App services
  // are fixtures; this is not an Electron runtime test. The extracted source has
  // no source map and deliberately receives no credit against main.js coverage.
  const project = vm.runInNewContext(`${main.slice(start, end)}; settingsForRenderer`, {
    settings, credentialSettingsForRenderer, accountFieldProjection, accountStatusProjection,
    limitAccountFormsForRenderer, rendererOmittedAccountKeys, process: { env: {} },
    getSyncContentRuntime: () => ({ status: () => ({ enabled: {} }) }),
    trayMenuLocale: () => 'en', effectiveSubscriptions: () => [], subscriptionsAreShared: () => false,
    currentHubIdentity: () => 'local', subscriptionDocumentVersion: () => 0,
    subscriptionsDocumentFor: () => null, pendingOrphanedSubscriptions: () => [],
    codexAccountsForRenderer: () => [], antigravityAccountsForRenderer: () => [],
    workbuddyAccountsForRenderer: () => [], mimoAccountsForRenderer: () => [],
    claudeAccountService: () => ({ legacyAccount: () => null, loginStatuses: () => [] }),
    effectiveRates: {}, rateCache: null, currentWindowToggleShortcutStatus: () => ({})
  });
  const projected = structuredClone(project());
  const encoded = JSON.stringify(projected);
  for (const secret of secrets) assert.ok(!encoded.includes(secret), secret);
  assert.equal(projected.hubHostSecret, settings.hubHostSecret);
  assert.equal(projected.secret, settings.secret);
  assert.equal(projected.deepseekApiKeyConfigured, true);
  assert.equal(projected.deepseekApiKey, '');
  assert.equal(projected.opencodeProfiles.work.cookie, 'set');
  assert.equal(projected.opencodeProfiles.work.apiKey, 'set');
  assert.equal(projected.opencodeProfiles.work.futureSecret, undefined);
  assert.equal(projected.icloudWriterId, undefined);
  assert.equal(projected.icloudRetiredDeviceIds, undefined);
  assert.equal(projected.syncContentState, undefined);
  for (const form of Object.values(projected.limitAccountForms)) {
    for (const field of form.fields || []) {
      assert.equal(field.storePath, undefined);
      assert.equal(field.resolve, undefined);
    }
  }
  assert.equal(projected.language, 'en');
  assert.deepEqual(settings, snapshot);
});
