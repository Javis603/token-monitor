'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cleanMinimaxSecret,
  createMinimaxManagedAccount,
  minimaxAccountDisplayLabel,
  minimaxAccountKey,
  normalizeMinimaxManagedAccounts,
  scopedMinimaxManagedAccounts
} = require('../../src/shared/minimaxAccounts');

function account(overrides = {}) {
  const created = createMinimaxManagedAccount('sk-cp-test-1234', 'Personal', []);
  assert.ok(created.ok);
  return { ...created.account, ...overrides };
}

test('cleanMinimaxSecret trims whitespace and paired quotes from pasted keys', () => {
  assert.equal(cleanMinimaxSecret('  "sk-cp-1"  '), 'sk-cp-1');
  assert.equal(cleanMinimaxSecret("'sk-cp-2'"), 'sk-cp-2');
  assert.equal(cleanMinimaxSecret('sk-cp-3'), 'sk-cp-3');
  assert.equal(cleanMinimaxSecret(null), '');
  assert.equal(cleanMinimaxSecret(42), '');
});

test('minimaxAccountKey matches the legacy single-key formula so migration keeps identity', () => {
  // 旧单账号路径：accountKey = hashKey('minimax', key)。迁移成托管账号后
  // 公式必须一致，否则 limitsRuntime 的 per-account 身份与订阅绑定断裂。
  const { hashKey } = require('../../src/shared/hashKey');
  assert.equal(minimaxAccountKey('sk-cp-same'), hashKey('minimax', 'sk-cp-same'));
});

test('createMinimaxManagedAccount rejects empty keys and keeps a duplicate stable', () => {
  assert.deepEqual(createMinimaxManagedAccount('   ', '', []), { ok: false, errorCode: 'missingApiKey' });

  const first = createMinimaxManagedAccount('sk-cp-dup', 'Work', []);
  assert.ok(first.ok);
  assert.match(first.account.id, /^minimax-/);
  assert.equal(first.account.keySuffix, '-dup');
  assert.equal(first.account.accountLabel, 'Work');
  assert.equal(first.account.enabled, true);

  const again = createMinimaxManagedAccount('"sk-cp-dup"', '', [first.account]);
  assert.ok(again.ok);
  assert.equal(again.account.id, first.account.id, 'duplicate keeps its id');
  assert.equal(again.account.addedAt, first.account.addedAt, 'duplicate keeps addedAt');
  assert.equal(again.account.accountLabel, 'Work', 'empty label keeps the previous one');
  assert.equal(again.account.accountKey, first.account.accountKey);
});

test('normalizeMinimaxManagedAccounts drops disabled and invalid rows and dedupes by accountKey', () => {
  const a = account();
  const b = account({ accountKey: 'sha256:other', apiKey: 'sk-cp-other-5678' });
  const normalized = normalizeMinimaxManagedAccounts([
    a,
    { ...a, apiKey: a.apiKey }, // 同 accountKey 的重复行
    b,
    { ...b, enabled: false }, // 已停用
    null,
    { accountKey: 'sha256:x' }, // 缺 apiKey
    'garbage'
  ]);
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized.map((item) => item.accountKey), [a.accountKey, 'sha256:other']);
});

test('scopedMinimaxManagedAccounts filters by accountKey or label and guards provider-wide scopes', () => {
  const a = account({ accountLabel: 'Personal' });
  const b = account({ accountKey: 'sha256:work', apiKey: 'sk-cp-work-9999', accountLabel: 'Work' });
  const rows = [a, b];

  assert.equal(scopedMinimaxManagedAccounts(rows, null).length, 2);
  assert.equal(
    scopedMinimaxManagedAccounts(rows, { provider: 'minimax', accountKey: a.accountKey }).length,
    1
  );
  assert.deepEqual(
    scopedMinimaxManagedAccounts(rows, { provider: 'minimax', accountLabel: 'Work' }).map((row) => row.accountKey),
    ['sha256:work']
  );
  // 多账号却无标识的 provider 级 scope 会把一次「账号级」刷新退化成全量
  // 扫描，必须 fail closed（与 MiMo 同语义）。
  assert.throws(
    () => scopedMinimaxManagedAccounts(rows, { provider: 'minimax' }),
    /requires an account identifier/
  );
});

test('minimaxAccountDisplayLabel prefers the custom label and falls back to the key suffix', () => {
  assert.equal(minimaxAccountDisplayLabel(account()), 'Personal');
  assert.equal(minimaxAccountDisplayLabel(account({ accountLabel: '' })), '1234');
  assert.equal(minimaxAccountDisplayLabel(account({ accountLabel: '', keySuffix: '' })), '');
});
