'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const electronDir = path.join(__dirname, '..', '..', 'src', 'electron');
const rendererDir = path.join(electronDir, 'renderer');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('Codex account login exposes browser, copy, and cancel controls', () => {
  const html = read(path.join(rendererDir, 'index.html'));
  const details = html.match(/<div id="codexSettingsDetails"[\s\S]*?<div id="codexAccountErrorMessage" class="settings-note error hidden"><\/div>/)?.[0] || '';

  assert.match(details, /<button id="codexCancelLoginButton"[\s\S]*class="hidden"[\s\S]*data-i18n="settings\.common\.cancel">/);
  assert.match(details, /<div id="codexLoginUrlActions" class="settings-actions hidden">[\s\S]*codexOpenLoginUrlButton[\s\S]*codexCopyLoginUrlButton[\s\S]*codexCancelLoginButton/);
  assert.match(details, /<button id="codexOpenLoginUrlButton"[\s\S]*data-i18n="settings\.codex\.openLoginUrl">/);
  assert.match(details, /<button id="codexCopyLoginUrlButton"[\s\S]*data-i18n="settings\.codex\.copyLoginUrl">/);
  assert.match(details, /<div id="codexLoginStatus" class="settings-note hidden" role="status" aria-live="polite"><\/div>/);
  assert.match(details, /<details id="codexLoginDetails" class="codex-login-details hidden">/);
});

test('Codex login IPC owns cancellation per flow and sends an allowlisted URL', () => {
  const main = read(path.join(electronDir, 'main.js'));
  const preload = read(path.join(electronDir, 'preload.js'));
  const addHandler = main.slice(
    main.indexOf("ipcMain.handle('codex:addAccount'"),
    main.indexOf("ipcMain.handle('codex:cancelLogin'")
  );
  const cancelHandler = main.slice(
    main.indexOf("ipcMain.handle('codex:cancelLogin'"),
    main.indexOf("ipcMain.handle('codex:removeAccount'")
  );

  assert.match(main, /let codexLoginController = null;/);
  assert.match(main, /let codexLoginFlowId = '';/);
  assert.match(main, /let codexLoginCanCancel = false;/);
  assert.ok(
    addHandler.indexOf("const flowId = String(request?.flowId || '').trim();")
      < addHandler.indexOf('if (codexLoginController)'),
    'the request flow id should be captured before rejecting a duplicate request'
  );
  assert.match(addHandler, /if \(codexLoginController\) return \{ ok: false, error: '[^']+', flowId \};/);
  assert.match(addHandler, /const controller = new AbortController\(\);/);
  assert.match(addHandler, /codexLoginController = controller;/);
  assert.match(addHandler, /codexLoginFlowId = flowId;/);
  assert.match(addHandler, /signal: controller\.signal/);
  assert.match(addHandler, /onCommit: \(\) => \{[\s\S]*codexLoginCanCancel = false;/);
  assert.match(addHandler, /codexLoginUrlFromOutput\(streamed\)/);
  assert.match(addHandler, /event\.sender\.send\('codex:loginStatus', \{[\s\S]*flowId/);
  assert.match(cancelHandler, /controller\?\.abort\(\);/);
  assert.match(cancelHandler, /if \(!codexLoginCanCancel\) return \{ ok: false, cancelled: false, tooLate: true \};/);
  assert.doesNotMatch(cancelHandler, /codexLoginController = null/);
  assert.match(preload, /addAccount: \(options = \{\}\) => ipcRenderer\.invoke\('codex:addAccount', options\)/);
  assert.match(preload, /cancelLogin: \(options = \{\}\) => ipcRenderer\.invoke\('codex:cancelLogin', options\)/);
  assert.match(preload, /ipcRenderer\.on\('codex:loginStatus', handler\)/);
});

test('Codex account persistence remains cancellable until settings commit', () => {
  const main = read(path.join(electronDir, 'main.js'));
  const addAccount = main.slice(
    main.indexOf('async function addCodexManagedAccount'),
    main.indexOf('async function removeCodexManagedAccount')
  );
  const abortChecks = addAccount.match(/options\.signal\?\.aborted/g) || [];

  assert.ok(abortChecks.length >= 3, 'expected cancellation checks across post-login persistence');
  assert.match(addAccount, /backupHomePath/);
  assert.match(addAccount, /rollbackCodexManagedHome/);
  assert.match(addAccount, /options\.onCommit\?\.\(\);/);
  assert.match(addAccount, /commitCodexManagedAccount\([\s\S]*\{ restart: false \}\)/);
  assert.match(addAccount, /await removeManagedHomeIfSafe\(backupHomePath\);[\s\S]*accountCommitted = true;/);
  assert.match(addAccount, /catch \(error\) \{[\s\S]*settings\.codexManagedAccounts = previousAccounts;[\s\S]*rollbackCodexManagedHome/);
  assert.match(addAccount, /accountCommitted = true;[\s\S]*if \(!accountCommitted\) await removeManagedHomeIfSafe\(tempHome\)/);
  assert.ok(
    addAccount.lastIndexOf('options.signal?.aborted') < addAccount.indexOf('commitCodexManagedAccount'),
    'the final cancellation check should happen before committing settings'
  );
});

test('Codex managed home paths reject traversal outside the managed root', () => {
  const main = read(path.join(electronDir, 'main.js'));
  const helper = main.slice(
    main.indexOf('function codexManagedHomePath'),
    main.indexOf('function codexEmailDerivedAccountKey')
  );
  const addAccount = main.slice(
    main.indexOf('async function addCodexManagedAccount'),
    main.indexOf('async function removeCodexManagedAccount')
  );

  assert.match(helper, /path\.resolve\(resolvedRoot, String\(accountId \|\| ''\)\)/);
  assert.match(helper, /resolvedHome === resolvedRoot/);
  assert.match(helper, /resolvedHome\.startsWith\(`\$\{resolvedRoot\}\$\{path\.sep\}`\)/);
  assert.match(addAccount, /const homePath = codexManagedHomePath\(codexAccountId\(identity, existing\)\);/);
  assert.match(addAccount, /if \(!homePath\) return \{ ok: false, error:/);
});

test('Codex login renderer ignores stale flows and exposes explicit URL actions', () => {
  const app = read(path.join(rendererDir, 'app.js'));
  const setup = app.slice(
    app.indexOf('function setupCursorAccountUI()'),
    app.indexOf('\nsetupCursorAccountUI();')
  );

  assert.match(setup, /const flowId = nextCodexSignInFlowId\(\);/);
  assert.match(setup, /window\.tokenMonitor\.codex\.addAccount\(\{ flowId \}\)/);
  assert.match(setup, /window\.tokenMonitor\.codex\.cancelLogin\(\{ flowId \}\)/);
  assert.match(setup, /const result = await window\.tokenMonitor\.codex\.cancelLogin\(\{ flowId \}\);[\s\S]*if \(!result\?\.cancelled \|\| !isCurrentCodexSignInFlow\(flowId\)\) return;[\s\S]*state\.codexSignInFlowId = '';/);
  assert.match(setup, /isCurrentCodexSignInFlow\(status\.flowId\)/);
  assert.match(setup, /window\.tokenMonitor\.openExternal\(state\.codexLoginUrl\)/);
  assert.match(setup, /copyToClipboard\(state\.codexLoginUrl, codexCopyUrlButton\)/);
});
