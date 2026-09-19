'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_CODEX_ACCOUNT_ALIAS_LENGTH,
  normalizeCodexAccountAliases
} = require('../../src/shared/accountDisplayPreferences');

test('Codex account aliases keep only non-empty stable-key entries', () => {
  assert.deepEqual(normalizeCodexAccountAliases({
    ' sha256:first ': '  工作号  ',
    'sha256:empty': '   ',
    '': 'missing key',
    'sha256:control': 'Main\u0000\n account'
  }), {
    'sha256:first': '工作号',
    'sha256:control': 'Main account'
  });
  assert.deepEqual(normalizeCodexAccountAliases(null), {});
  assert.deepEqual(normalizeCodexAccountAliases([]), {});
});

test('Codex account aliases are bounded before persistence', () => {
  const longAlias = 'a'.repeat(MAX_CODEX_ACCOUNT_ALIAS_LENGTH + 20);
  assert.equal(
    normalizeCodexAccountAliases({ account: longAlias }).account.length,
    MAX_CODEX_ACCOUNT_ALIAS_LENGTH
  );
  const many = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`key-${index}`, `Name ${index}`]));
  assert.equal(Object.keys(normalizeCodexAccountAliases(many)).length, 100);
});
