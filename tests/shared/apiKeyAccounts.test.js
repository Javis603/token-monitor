'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  API_KEY_LABEL_MAX_LENGTH,
  apiKeyAccountDisplayLabel,
  apiKeySuffix,
  cleanApiKeySecret,
  createApiKeyManagedAccount,
  managedApiKeyAccountKey,
  normalizeApiKeyManagedAccounts,
  scopedApiKeyManagedAccounts
} = require('../../src/shared/apiKeyAccounts');

function account(provider, overrides = {}) {
  const created = createApiKeyManagedAccount(provider, 'sk-test-1234', 'Personal', []);
  assert.ok(created.ok);
  return { ...created.account, ...overrides };
}

test('cleanApiKeySecret trims whitespace and paired quotes from pasted keys', () => {
  assert.equal(cleanApiKeySecret('  "sk-1"  '), 'sk-1');
  assert.equal(cleanApiKeySecret("'sk-2'"), 'sk-2');
  assert.equal(cleanApiKeySecret('sk-3'), 'sk-3');
  assert.equal(cleanApiKeySecret(null), '');
  assert.equal(cleanApiKeySecret(42), '');
});

test('accountKey is provider-scoped: the same key in two providers is two accounts', () => {
  // 通用化的关键性质：accountKey 公式 hashKey(provider, key) 与各供应商
  // 单账号时代一致（迁移身份连续），且不同供应商的同名 key 不互撞。
  const { hashKey } = require('../../src/shared/hashKey');
  assert.equal(managedApiKeyAccountKey('minimax', 'sk-same'), hashKey('minimax', 'sk-same'));
  assert.equal(managedApiKeyAccountKey('deepseek', 'sk-same'), hashKey('deepseek', 'sk-same'));
  assert.notEqual(
    managedApiKeyAccountKey('minimax', 'sk-same'),
    managedApiKeyAccountKey('deepseek', 'sk-same')
  );
});

test('createApiKeyManagedAccount rejects empty keys, caps labels, and keeps a duplicate stable', () => {
  assert.deepEqual(
    createApiKeyManagedAccount('zai', '   ', '', []),
    { ok: false, errorCode: 'missingApiKey' }
  );

  const longLabel = 'x'.repeat(API_KEY_LABEL_MAX_LENGTH + 10);
  const first = createApiKeyManagedAccount('zai', 'sk-cp-dup', longLabel, []);
  assert.ok(first.ok);
  assert.match(first.account.id, /^zai-/);
  assert.equal(first.account.keySuffix, '-dup');
  assert.equal(first.account.accountLabel.length, API_KEY_LABEL_MAX_LENGTH);
  assert.equal(first.account.enabled, true);

  const again = createApiKeyManagedAccount('zai', '"sk-cp-dup"', '', [first.account]);
  assert.ok(again.ok);
  assert.equal(again.account.id, first.account.id, 'duplicate keeps its id');
  assert.equal(again.account.addedAt, first.account.addedAt, 'duplicate keeps addedAt');
  assert.equal(again.account.accountLabel.length, API_KEY_LABEL_MAX_LENGTH, 'label cap preserved');
});

test('normalize filters disabled/invalid rows and dedupes by accountKey per provider', () => {
  const a = account('deepseek');
  const normalized = normalizeApiKeyManagedAccounts('deepseek', [
    a,
    { ...a, apiKey: a.apiKey }, // 同 accountKey 重复行
    { accountKey: 'sha256:other', apiKey: 'sk-other-5678', enabled: true },
    { accountKey: 'sha256:x', apiKey: 'sk-x', enabled: false }, // 停用
    null,
    { accountKey: 'sha256:y' }, // 缺 apiKey
    'garbage'
  ]);
  assert.equal(normalized.length, 2);
});

test('scoped accounts filter by accountKey/label and fail closed for provider-only scopes', () => {
  const a = account('zai', { accountLabel: 'Personal' });
  const b = account('zai', { accountKey: 'sha256:work', apiKey: 'sk-work-9999', accountLabel: 'Work' });
  const rows = [a, b];

  assert.equal(scopedApiKeyManagedAccounts('zai', rows, null).length, 2);
  assert.equal(
    scopedApiKeyManagedAccounts('zai', rows, { provider: 'zai', accountKey: a.accountKey }).length,
    1
  );
  assert.deepEqual(
    scopedApiKeyManagedAccounts('zai', rows, { provider: 'zai', accountLabel: 'Work' }).map((row) => row.accountKey),
    ['sha256:work']
  );
  assert.throws(
    () => scopedApiKeyManagedAccounts('zai', rows, { provider: 'zai' }),
    /requires an account identifier/
  );
});

test('displayLabel prefers the custom label and falls back to the bare key suffix', () => {
  assert.equal(apiKeyAccountDisplayLabel(account('minimax')), 'Personal');
  assert.equal(apiKeyAccountDisplayLabel(account('minimax', { accountLabel: '' })), '1234');
  assert.equal(apiKeyAccountDisplayLabel(account('minimax', { accountLabel: '', keySuffix: '' })), '');
  assert.equal(apiKeySuffix('sk-cp-abcd'), 'abcd');
});
