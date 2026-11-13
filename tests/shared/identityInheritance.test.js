'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_INHERITED_KEYS,
  accountLabel,
  inheritedAccountKeys
} = require('../../src/shared/limits/identityInheritance');

function row(overrides = {}) {
  return { provider: 'copilot', region: '', workspaceKind: '', ...overrides };
}

test('a rotated key inherits the keys recorded under the same email', () => {
  const previous = row({ accountKey: 'sha256:first', accountEmail: 'user@example.com' });
  const current = row({ accountKey: 'sha256:second', accountEmail: 'User@Example.com' });
  assert.deepEqual(inheritedAccountKeys(current, [previous]), ['sha256:first']);
  // Nothing to inherit when the key itself did not move.
  assert.deepEqual(inheritedAccountKeys(previous, [previous]), []);
});

test('an inherited alias chain keeps carrying every key the account used', () => {
  const first = row({ accountKey: 'sha256:first', accountEmail: 'user@example.com' });
  const second = row({
    accountKey: 'sha256:second',
    accountEmail: 'user@example.com',
    accountKeyAliases: ['sha256:first']
  });
  const third = row({ accountKey: 'sha256:third', accountEmail: 'user@example.com' });
  assert.deepEqual(inheritedAccountKeys(third, [second]), ['sha256:second', 'sha256:first']);
  assert.deepEqual(inheritedAccountKeys(third, [second, first]), ['sha256:second', 'sha256:first']);
});

test('a different account or quota pool inherits nothing', () => {
  const previous = row({ accountKey: 'sha256:first', accountEmail: 'user@example.com' });
  assert.deepEqual(inheritedAccountKeys(row({ accountKey: 'sha256:next', accountEmail: 'other@example.com' }), [previous]), []);
  assert.deepEqual(inheritedAccountKeys(row({ accountKey: 'sha256:next', accountEmail: 'user@example.com', region: 'cn' }), [previous]), []);
  assert.deepEqual(inheritedAccountKeys(row({ accountKey: 'sha256:next', accountEmail: 'user@example.com', workspaceKind: 'team' }), [previous]), []);
  assert.deepEqual(inheritedAccountKeys(row({ provider: 'cline', accountKey: 'sha256:next', accountEmail: 'user@example.com' }), [previous]), []);
});

test('an unlabelled account inherits nothing', () => {
  const previous = row({ accountKey: 'sha256:first' });
  assert.equal(accountLabel(previous), '');
  assert.deepEqual(inheritedAccountKeys(row({ accountKey: 'sha256:second' }), [previous]), []);
  // A display label is not an account label: two accounts on one plan share it.
  assert.deepEqual(inheritedAccountKeys(row({ accountKey: 'sha256:second', accountLabel: 'Plus' }),
    [row({ accountKey: 'sha256:first', accountLabel: 'Plus' })]), []);
});

test('a login name is used when no email is reported, and the list stays bounded', () => {
  const previousRows = Array.from({ length: MAX_INHERITED_KEYS + 4 }, (_, index) => row({
    accountKey: `sha256:key-${index}`,
    accountName: 'octocat'
  }));
  const inherited = inheritedAccountKeys(row({ accountKey: 'sha256:current', accountName: 'Octocat' }), previousRows);
  assert.equal(inherited.length, MAX_INHERITED_KEYS);
  assert.equal(inherited.includes('sha256:current'), false);
  // Ledger keys ride the same bounded list.
  assert.deepEqual(inheritedAccountKeys(row({ accountKey: 'sha256:current', accountEmail: 'a@b.c' }), [], ['sha256:old']),
    ['sha256:old']);
});
