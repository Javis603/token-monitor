'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  codexAccountMatchesIdentity,
  findMatchingCodexAccount,
  liveCodexAuthPath,
  readCodexAuthMaterial,
  writeCodexAuthFile
} = require('../../src/shared/codexSystemSwitch');

test('liveCodexAuthPath respects CODEX_HOME and otherwise uses the default Codex home', () => {
  assert.equal(
    liveCodexAuthPath({ CODEX_HOME: '/tmp/scoped-codex-home' }, '/Users/example'),
    path.join('/tmp/scoped-codex-home', 'auth.json')
  );
  assert.equal(
    liveCodexAuthPath({}, '/Users/example'),
    path.join('/Users/example', '.codex', 'auth.json')
  );
});

test('managed Codex accounts match identities by stable key or lower-cased email', () => {
  const accounts = [
    { id: 'first', accountKey: 'sha256:first', email: 'first@example.com' },
    { id: 'second', accountKey: 'sha256:second', email: 'second@example.com' }
  ];

  assert.equal(codexAccountMatchesIdentity(accounts[0], { accountKey: 'sha256:first' }), true);
  assert.equal(codexAccountMatchesIdentity(accounts[0], { email: 'FIRST@example.com' }), true);
  assert.equal(codexAccountMatchesIdentity(accounts[0], { accountKey: 'sha256:second' }), false);
  assert.equal(codexAccountMatchesIdentity(accounts[0], { accountKey: 'sha256:other', email: 'first@example.com' }), false);
  assert.equal(findMatchingCodexAccount(accounts, { email: 'SECOND@example.com' })?.id, 'second');
});

test('Codex auth files are written atomically with private permissions and readable identity', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'token-monitor-codex-switch-'));
  const authPath = path.join(root, 'live', 'auth.json');
  const authData = JSON.stringify({
    account: { email: 'Primary.User@Example.com', planType: 'plus' }
  });

  await writeCodexAuthFile(authPath, authData);

  const stat = await fs.promises.stat(authPath);
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600);
  }

  const material = await readCodexAuthMaterial(authPath);
  assert.equal(material.data, authData);
  assert.equal(material.identity.email, 'primary.user@example.com');
  assert.equal(material.identity.accountLabel, 'plus');
});
