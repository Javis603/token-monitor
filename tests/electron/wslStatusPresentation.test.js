'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { shouldShowSqliteHelp } = require('../../src/electron/renderer/wslStatusPresentation');

test('WSL SQLite guidance appears when a detected client has no usage', () => {
  assert.equal(shouldShowSqliteHelp({
    state: 'active',
    detected: ['codex', 'future-sqlite-client'],
    withData: ['codex']
  }), true);
  assert.equal(shouldShowSqliteHelp({
    state: 'no-data',
    detected: ['future-sqlite-client'],
    withData: []
  }), true);
});

test('WSL SQLite guidance stays hidden when all detected clients have usage or no clients are detected', () => {
  assert.equal(shouldShowSqliteHelp({
    state: 'active',
    detected: ['codex', 'opencode'],
    withData: ['codex', 'opencode']
  }), false);
  assert.equal(shouldShowSqliteHelp({ state: 'active', detected: [], withData: [] }), false);
  assert.equal(shouldShowSqliteHelp({ state: 'no-data', detected: [], withData: [] }), false);
});

test('WSL SQLite guidance stays hidden when WSL is not running, unavailable, or disabled', () => {
  assert.equal(shouldShowSqliteHelp({ state: 'not-running', detected: ['opencode'], withData: [] }), false);
  assert.equal(shouldShowSqliteHelp({ state: 'not-installed' }), false);
  assert.equal(shouldShowSqliteHelp({ state: 'disabled' }), false);
  assert.equal(shouldShowSqliteHelp(null), false);
});

test('renderer loads WSL status presentation before app.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/index.html'), 'utf8');
  assert.ok(html.indexOf('<script src="wslStatusPresentation.js"></script>') < html.indexOf('<script src="app.js"></script>'));
});

test('WSL SQLite advisory links to the allowlisted repository guide', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  assert.match(app, /TOKEN_MONITOR_WSL_SQLITE_GUIDE_URL = `\$\{TOKEN_MONITOR_REPOSITORY_URL\}\/blob\/main\/docs\/wsl-sqlite-setup\.md`/);
  assert.match(app, /shouldShowSqliteHelp\(status\)[\s\S]*settings\.collection\.wslPanel\.sqliteHelp[\s\S]*TOKEN_MONITOR_WSL_SQLITE_GUIDE_URL/);
});
