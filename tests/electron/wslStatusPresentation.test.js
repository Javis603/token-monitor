'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { sqliteHelpClients } = require('../../src/electron/renderer/wslStatusPresentation');

test('WSL SQLite help targets detected OpenCode and Hermes without usage', () => {
  assert.deepEqual(sqliteHelpClients({
    detected: ['codex', 'opencode', 'hermes'],
    withData: ['codex']
  }), ['opencode', 'hermes']);
});

test('WSL SQLite help does not flag clients that returned usage', () => {
  assert.deepEqual(sqliteHelpClients({
    detected: ['opencode', 'hermes'],
    withData: ['opencode', 'hermes']
  }), []);
});

test('WSL SQLite help normalizes and deduplicates client ids', () => {
  assert.deepEqual(sqliteHelpClients({
    detected: ['OpenCode', 'opencode', 'HERMES'],
    withData: ['hermes']
  }), ['opencode']);
  assert.deepEqual(sqliteHelpClients(null), []);
});

test('renderer loads WSL status presentation before app.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/index.html'), 'utf8');
  assert.ok(html.indexOf('<script src="wslStatusPresentation.js"></script>') < html.indexOf('<script src="app.js"></script>'));
});

test('WSL SQLite advisory links to the allowlisted repository guide', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  assert.match(app, /TOKEN_MONITOR_WSL_SQLITE_GUIDE_URL = `\$\{TOKEN_MONITOR_REPOSITORY_URL\}\/blob\/main\/docs\/wsl-sqlite-setup\.md`/);
  assert.match(app, /sqliteHelpClients\(status\)[\s\S]*settings\.collection\.wslPanel\.sqliteHelp[\s\S]*TOKEN_MONITOR_WSL_SQLITE_GUIDE_URL/);
});
