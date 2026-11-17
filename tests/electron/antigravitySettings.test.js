'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function readAccountOwnersAndMain() {
  const owners = ['codex', 'antigravity', 'mimo', 'cursor', 'opencode', 'thirdparty'];
  return owners.map(id => fs.readFileSync(path.join(__dirname, '../../src/electron/providers', id, 'accountService.js'), 'utf8')).join('\n')
    + '\n' + fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
}


const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Antigravity settings manage quota accounts without exposing a local account switch', () => {
  const html = read('src/electron/renderer/index.html');
  const app = read('src/electron/renderer/limits/providerOwners/antigravity.js') + '\n' + read('src/electron/renderer/app.js');
  const preload = read('src/electron/preload.js');
  const antigravityRenderer = app.slice(
    app.indexOf('function renderAntigravityStatus()'),
    app.indexOf('function setup()')
  );
  const antigravitySetup = app.slice(
    app.indexOf('async function startAntigravityLogin()'),
    app.indexOf(' return { state')
  );

  assert.match(html, /id="antigravityAccountGroup"/);
  assert.match(html, /id="antigravityAccountList" class="managed-account-list"/);
  assert.doesNotMatch(html, /id="antigravityAccountEmpty"/);
  assert.match(html, /id="antigravityAddAccountButton"/);
  assert.match(html, /id="antigravityCancelLoginButton"/);
  assert.doesNotMatch(html, /settings\.antigravity\.(?:description|localAccountNote)/);
  assert.match(app, /function renderAntigravityStatus\(\)/);
  assert.match(app, /t\('settings\.antigravity\.notConfigured'\)/);
  assert.match(app, /sources.length\) optionsInner.append\(limitProviderConnectionDetail/);
  assert.match(app, /window\.tokenMonitor\.antigravity\.setAccountEnabled/);
  assert.match(app, /window\.tokenMonitor\.antigravity\.removeAccount/);
  // Several Antigravity accounts render as the shared group, by account count
  // rather than by a wrapper of their own — the page has no per-provider group
  // builders left, so the count phrase is the catalog's own.
  assert.match(app, /nodes\.push\(renderLimitProviderGroup\(id, label, visibleProviders, color\)\)/);
  assert.equal(require('../../src/electron/renderer/providers/volcengine/windows')({}).groupCountKey, 'settings.volcengine.nPlans');
  assert.match(antigravityRenderer, /TokenMonitorLegacyAccountList\.create/);
  assert.match(antigravityRenderer, /accountList\.update\(accounts, host\.localProviderStatuses\('antigravity'\)\)/);
  assert.match(antigravityRenderer, /remove: account => window\.tokenMonitor\.antigravity\.removeAccount\(account\.id\)/);
  const panel = read('src/electron/renderer/limits/accountSlotsPanel.js');
  assert.match(panel, /let confirmingRemove = false/);
  assert.match(panel, /if \(!confirmingRemove\)/);
  assert.match(antigravitySetup, /refreshStats\(\{ force: true \}\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(antigravitySetup, /await refreshStats\(\{ force: true \}\);/);
  assert.doesNotMatch(antigravityRenderer, /managed-account-remove-label/);
  assert.doesNotMatch(app, /antigravitySystemSwitch|switchAntigravityAccount/);
  assert.match(preload, /addAccount: \(\) => ipcRenderer\.invoke\('antigravity:addAccount'\)/);
  assert.match(preload, /cancelLogin: \(\) => ipcRenderer\.invoke\('antigravity:cancelLogin'\)/);
});

test('Antigravity OAuth credentials remain in the main-process credential store', () => {
  const main = readAccountOwnersAndMain();
  const credentials = read('src/shared/credentialStore.js');

  assert.match(credentials, /readAntigravityCredential\(id/);
  assert.match(credentials, /\['providers', 'antigravity', 'accounts', accountId, 'credentials'\]/);
  assert.match(main, /antigravityManagedAccountsForCollector\(\)/);
  assert.match(main, /antigravityOAuth\.managedAccountsForCollector/);
  assert.match(main, /antigravityManagedAccounts: antigravityAccountsForRenderer\(\)/);
  assert.match(main, /normalizeAccountPatch\(patch, normalizedPatch\)/);
  const { normalizeAccountPatch } = require('../../src/electron/limits/accountSettings');
  const patch = { antigravityManagedAccounts: [{ id: 'private' }] };
  normalizeAccountPatch(patch, patch);
  assert.equal(Object.hasOwn(patch, 'antigravityManagedAccounts'), false);
  const app = read('src/electron/renderer/limits/providerOwners/antigravity.js') + '\n' + read('src/electron/renderer/app.js');
  const antigravityRenderer = app.slice(
    app.indexOf('function renderAntigravityStatus()'),
    app.indexOf('function setup()')
  );
  assert.doesNotMatch(antigravityRenderer, /accessToken|refreshToken|clientSecret|credentials/);
});

test('Antigravity account mutations rely on centralized settings rollback', () => {
  const main = readAccountOwnersAndMain();
  const antigravityHandlers = main.slice(
    main.indexOf('async function addAntigravityManagedAccount()'),
    main.indexOf('function normalizeMimoManagedAccounts(value)')
  );

  assert.doesNotMatch(antigravityHandlers, /previousAccounts/);
  assert.match(main, /catch \(error\) \{\s+settings = previousSettings;/);
  assert.match(antigravityHandlers, /if \(previousCredential\) writeAntigravityCredential/);
  assert.match(antigravityHandlers, /else removeAntigravityCredential/);
});

test('Antigravity account copy is complete in every locale', () => {
  const i18n = read('src/electron/renderer/i18n.js');
  for (const key of [
    'settings.antigravity.title',
    'settings.antigravity.notConfigured',
    'settings.antigravity.addAccount',
    'settings.antigravity.loginFailed',
    'settings.antigravity.verificationRequired',
    'settings.antigravity.verificationRequiredDetail'
  ]) {
    assert.equal(i18n.split(`'${key}'`).length - 1, 6, `${key} should exist in all bundled locales`);
  }
});
