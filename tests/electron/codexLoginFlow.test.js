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
  assert.match(addHandler, /const controller = new AbortController\(\);/);
  assert.match(addHandler, /codexLoginController = controller;/);
  assert.match(addHandler, /codexLoginFlowId = flowId;/);
  assert.match(addHandler, /signal: controller\.signal/);
  assert.match(addHandler, /codexLoginUrlFromOutput\(streamed\)/);
  assert.match(addHandler, /event\.sender\.send\('codex:loginStatus', \{[\s\S]*flowId/);
  assert.match(cancelHandler, /controller\?\.abort\(\);/);
  assert.match(preload, /addAccount: \(options = \{\}\) => ipcRenderer\.invoke\('codex:addAccount', options\)/);
  assert.match(preload, /cancelLogin: \(options = \{\}\) => ipcRenderer\.invoke\('codex:cancelLogin', options\)/);
  assert.match(preload, /ipcRenderer\.on\('codex:loginStatus', handler\)/);
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
  assert.match(setup, /const cancelRequest = window\.tokenMonitor\.codex\.cancelLogin\(\{ flowId \}\);[\s\S]*state\.codexSignInFlowId = '';[\s\S]*await cancelRequest;/);
  assert.match(setup, /isCurrentCodexSignInFlow\(status\.flowId\)/);
  assert.match(setup, /window\.tokenMonitor\.openExternal\(state\.codexLoginUrl\)/);
  assert.match(setup, /copyToClipboard\(state\.codexLoginUrl, codexCopyUrlButton\)/);
});
