'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  codexAccountIdForProvider,
  codexAccountMatchesProvider,
  isCodexLiveAccount,
  localLiveCodexProvider,
  maskEmailAddress
} = require('../../src/electron/renderer/accountIdentity');

test('Codex account email masking uses the final separator in quoted local parts', () => {
  assert.equal(maskEmailAddress('primary.user@example.com'), 'p***r@example.com');
  assert.equal(maskEmailAddress('ab@example.com'), 'a***b@example.com');
  assert.equal(maskEmailAddress('"user@name"@example.com'), '"***"@example.com');
});

test('Codex account identity matches by key or normalized email fields', () => {
  assert.equal(codexAccountMatchesProvider(
    { accountKey: 'account-1' },
    { provider: 'codex', accountKey: 'account-1' }
  ), true);
  assert.equal(codexAccountMatchesProvider(
    { accountKey: 'account-1', email: 'shared@example.com' },
    { provider: 'codex', accountKey: 'account-2', accountEmail: 'shared@example.com' }
  ), false);
  assert.equal(codexAccountMatchesProvider(
    { accountEmail: 'User@Example.com' },
    { provider: 'codex', accountEmail: 'user@example.com' }
  ), true);
  assert.equal(codexAccountMatchesProvider(
    { email: 'user@example.com' },
    { provider: 'claude', accountEmail: 'user@example.com' }
  ), false);
  assert.equal(codexAccountIdForProvider([
    { id: 'one', accountKey: 'account-1' },
    { id: 'two', accountKey: 'account-2' }
  ], { provider: 'codex', accountKey: 'account-2' }), 'two');
  assert.equal(codexAccountIdForProvider([
    { id: 'one', accountKey: 'account-1', email: 'shared@example.com' },
    { id: 'two', accountKey: 'account-2', email: 'shared@example.com' }
  ], {
    provider: 'codex',
    accountKey: 'account-2',
    accountEmail: 'shared@example.com'
  }), 'two');
});

test('live Codex provider selection uses local raw limits with a legacy aggregate fallback', () => {
  const localLive = { provider: 'codex', status: 'ok', sourceDetail: 'app', accountKey: 'local' };
  const remoteLive = { provider: 'codex', status: 'ok', sourceDetail: 'cli', accountKey: 'remote' };
  const managed = { provider: 'codex', status: 'ok', sourceDetail: 'managed', accountKey: 'managed' };
  const stats = {
    devices: [
      { deviceId: 'this-device', limits: { providers: [managed, localLive] } },
      { deviceId: 'other-device', limits: { providers: [remoteLive] } }
    ],
    limits: { providers: [remoteLive] }
  };

  assert.equal(isCodexLiveAccount(localLive), true);
  assert.equal(isCodexLiveAccount(managed), false);
  assert.equal(localLiveCodexProvider(stats, 'this-device'), localLive);
  assert.equal(localLiveCodexProvider(stats, 'missing-device'), null);
  assert.equal(localLiveCodexProvider({ limits: stats.limits }, 'this-device'), remoteLive);
});

test('renderer loads the shared Codex identity API before app.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/index.html'), 'utf8');
  const identityIndex = html.indexOf('<script src="accountIdentity.js"></script>');
  assert.ok(identityIndex < html.indexOf('<script src="limitProviderPresentation.js"></script>'));
  assert.ok(identityIndex < html.indexOf('<script src="app.js"></script>'));
});
