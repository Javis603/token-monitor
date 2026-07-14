'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  codexAccountMatchesProvider,
  maskEmailAddress
} = require('../../src/electron/renderer/accountIdentity');

test('Codex account email masking uses the final separator in quoted local parts', () => {
  assert.equal(maskEmailAddress('javis603@gmail.com'), 'j***3@gmail.com');
  assert.equal(maskEmailAddress('ab@example.com'), 'a***b@example.com');
  assert.equal(maskEmailAddress('"user@name"@example.com'), '"***"@example.com');
});

test('Codex account identity matches by key or normalized email fields', () => {
  assert.equal(codexAccountMatchesProvider(
    { accountKey: 'account-1' },
    { provider: 'codex', accountKey: 'account-1' }
  ), true);
  assert.equal(codexAccountMatchesProvider(
    { accountEmail: 'User@Example.com' },
    { provider: 'codex', accountEmail: 'user@example.com' }
  ), true);
  assert.equal(codexAccountMatchesProvider(
    { email: 'user@example.com' },
    { provider: 'claude', accountEmail: 'user@example.com' }
  ), false);
});

test('renderer loads the shared Codex identity API before app.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/index.html'), 'utf8');
  assert.ok(html.indexOf('<script src="accountIdentity.js"></script>') < html.indexOf('<script src="app.js"></script>'));
});
