'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createIdentityLedger } = require('../../src/electron/limits/identityLedger');

const account = (accountKey, accountEmail, extra = {}) => ({
  provider: 'copilot', region: '', workspaceKind: '', accountKey, accountEmail, ...extra
});

function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-identities-'));
  const file = path.join(directory, 'limit-identities.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { file, ledger: createIdentityLedger(file, options) };
}

test('the ledger recalls the keys an account was recorded under, across restarts', (t) => {
  const { file, ledger } = fixture(t, { now: () => 10 });
  assert.deepEqual(ledger.recall(account('sha256:first', 'user@example.com')), []);
  assert.equal(ledger.remember(account('sha256:first', 'User@Example.com')), true);
  assert.deepEqual(ledger.recall(account('sha256:second', 'user@example.com')), ['sha256:first']);

  const reopened = createIdentityLedger(file);
  assert.deepEqual(reopened.recall(account('sha256:second', 'user@example.com')), ['sha256:first']);
  // The alias chain rides along, so a second rotation still finds the first key.
  reopened.remember(account('sha256:third', 'user@example.com', { accountKeyAliases: ['sha256:second'] }));
  assert.deepEqual(reopened.recall(account('sha256:fourth', 'user@example.com')),
    ['sha256:first', 'sha256:third', 'sha256:second']);
});

test('the ledger stores no label text, only its digest', (t) => {
  const { file, ledger } = fixture(t, { now: () => 10 });
  ledger.remember(account('sha256:first', 'private@example.com'));
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes('example.com'), false);
  assert.equal(text.includes('sha256:first'), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('an unlabelled account is neither remembered nor recalled', (t) => {
  const { file, ledger } = fixture(t, { now: () => 10 });
  const unlabelled = { provider: 'kimi', accountKey: 'sha256:kimi' };
  assert.equal(ledger.remember(unlabelled), false);
  assert.deepEqual(ledger.recall(unlabelled), []);
  assert.equal(fs.existsSync(file), false);
});

test('a different account under the same provider is not recalled', (t) => {
  const { ledger } = fixture(t, { now: () => 10 });
  ledger.remember(account('sha256:first', 'user@example.com'));
  assert.deepEqual(ledger.recall(account('sha256:other', 'other@example.com')), []);
  assert.deepEqual(ledger.recall(account('sha256:other', 'user@example.com', { region: 'cn' })), []);
  assert.deepEqual(ledger.recall(account('sha256:other', 'user@example.com', { workspaceKind: 'team' })), []);
});

test('an unchanged account does not rewrite the ledger', (t) => {
  let now = 1;
  const { file, ledger } = fixture(t, { now: () => now });
  ledger.remember(account('sha256:first', 'user@example.com'));
  const first = fs.statSync(file).mtimeMs;
  now = 2;
  assert.equal(ledger.remember(account('sha256:first', 'user@example.com')), true);
  assert.equal(fs.statSync(file).mtimeMs, first);
});
