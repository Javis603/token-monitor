'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Antigravity settings manage quota accounts without exposing a local account switch', () => {
  const html = read('src/electron/renderer/index.html');
  const app = read('src/electron/renderer/app.js');
  const preload = read('src/electron/preload.js');
  const antigravityRenderer = app.slice(
    app.indexOf('function renderAntigravityStatus()'),
    app.indexOf('function renderMimoStatus()')
  );
  const antigravitySetup = app.slice(
    app.indexOf("const antigravityToggle = document.getElementById('antigravitySettingsToggle')"),
    app.indexOf("const mimoToggle = document.getElementById('mimoSettingsToggle')")
  );

  assert.match(html, /id="antigravityAccountGroup"/);
  assert.match(html, /id="antigravityAccountList" class="managed-account-list"/);
  assert.doesNotMatch(html, /id="antigravityAccountEmpty"/);
  assert.match(html, /id="antigravityAddAccountButton"/);
  assert.match(html, /id="antigravityCancelLoginButton"/);
  assert.doesNotMatch(html, /settings\.antigravity\.(?:description|localAccountNote)/);
  assert.match(app, /function renderAntigravityStatus\(\)/);
  assert.match(app, /t\('settings\.antigravity\.notConfigured'\)/);
  assert.match(app, /connectionDetailKey && !accountGroup/);
  assert.match(app, /window\.tokenMonitor\.antigravity\.setAccountEnabled/);
  assert.match(app, /window\.tokenMonitor\.antigravity\.removeAccount/);
  assert.match(app, /renderAntigravityAccountGroup/);
  assert.match(antigravityRenderer, /const planLabel = limitProviderPresentationApi\.limitProviderDisplayLabel\(provider\?\.accountLabel\)/);
  assert.match(antigravityRenderer, /if \(accounts\.length === 0\)[\s\S]*empty\.textContent = t\('settings\.antigravity\.empty'\)/);
  assert.match(antigravityRenderer, /remove\.className = 'managed-account-remove'/);
  assert.match(antigravityRenderer, /remove\.textContent = '✕'/);
  assert.match(antigravitySetup, /refreshStats\(\{ force: true \}\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(antigravitySetup, /await refreshStats\(\{ force: true \}\);/);
  assert.doesNotMatch(antigravityRenderer, /managed-account-remove-label/);
  assert.doesNotMatch(app, /antigravitySystemSwitch|switchAntigravityAccount/);
  assert.match(preload, /addAccount: \(\) => ipcRenderer\.invoke\('antigravity:addAccount'\)/);
  assert.match(preload, /cancelLogin: \(\) => ipcRenderer\.invoke\('antigravity:cancelLogin'\)/);
});

test('Antigravity OAuth credentials remain in the main-process credential store', () => {
  const main = read('src/electron/main.js');
  const credentials = read('src/shared/credentialStore.js');

  assert.match(credentials, /readAntigravityCredential\(id/);
  assert.match(credentials, /\['providers', 'antigravity', 'accounts', accountId, 'credentials'\]/);
  assert.match(main, /antigravityManagedAccountsForCollector\(\)/);
  assert.match(main, /credentials: readAntigravityCredential\(account\.id\)/);
  assert.match(main, /antigravityManagedAccounts: antigravityAccountsForRenderer\(\)/);
  assert.match(main, /delete normalizedPatch\.antigravityManagedAccounts/);
  const app = read('src/electron/renderer/app.js');
  const antigravityRenderer = app.slice(
    app.indexOf('function renderAntigravityStatus()'),
    app.indexOf('function renderMimoStatus()')
  );
  assert.doesNotMatch(antigravityRenderer, /accessToken|refreshToken|clientSecret|credentials/);
});

test('Antigravity account copy is complete in every locale', () => {
  const i18n = read('src/electron/renderer/i18n.js');
  for (const key of [
    'settings.antigravity.title',
    'settings.antigravity.notConfigured',
    'settings.antigravity.addAccount',
    'settings.antigravity.loginFailed'
  ]) {
    assert.equal(i18n.split(`'${key}'`).length - 1, 5, `${key} should exist in all five locales`);
  }
});
