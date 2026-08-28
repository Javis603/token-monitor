'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createApiKeyAccountController } = require('../../src/electron/apiKeyAccountControllers');

// 受控的 main 侧环境：settings、凭据存取、持久化与账号级失效全部记录
// 在案；validateAccount 可按用例切换（验证失败/成功/重复）。
function createHarness(options = {}) {
  const state = {
    settings: {
      minimaxManagedAccounts: [...(options.initialAccounts || [])],
      minimaxApiKey: options.legacyKey || ''
    },
    persisted: 0,
    persistError: null,
    broadcasts: 0,
    invalidations: [],
    credentials: new Map(),
    validations: []
  };
  const controller = createApiKeyAccountController({
    provider: 'minimax',
    getSettings: () => state.settings,
    persistSettings: () => {
      state.persisted += 1;
      if (state.persistError) throw state.persistError;
    },
    broadcastChange: () => {
      state.broadcasts += 1;
    },
    queueInvalidation: (scope, reason, invalidationOptions) => {
      state.invalidations.push({ scope, reason, invalidationOptions });
    },
    resolveCredentialStore: () => ({
      readManagedAccountCredential: (_provider, id) => state.credentials.get(id) || '',
      writeManagedAccountCredential: (_provider, id, _field, value) => {
        state.credentials.set(id, value);
        return true;
      },
      removeManagedAccountCredentials: (_provider, id) => {
        state.credentials.delete(id);
        return true;
      }
    }),
    validateAccount: async (account) => {
      state.validations.push(account.accountKey);
      if (options.validationError) return { ok: false, errorCode: options.validationError };
      return { ok: true };
    }
  });
  return { state, controller };
}

const KEY_A = 'sk-cp-aaaa';
const KEY_B = 'sk-cp-bbbb';

function accountKeyFor(key) {
  const { managedApiKeyAccountKey } = require('../../src/shared/apiKeyAccounts');
  return managedApiKeyAccountKey('minimax', key);
}

test('addAccount validates before persisting and strips the key from settings metadata', async () => {
  const { state, controller } = createHarness();

  const result = await controller.addAccount(KEY_A, 'Personal');

  assert.equal(result.ok, true);
  assert.equal(state.validations.length, 1, 'exactly one live validation');
  assert.equal(state.credentials.get(result.accounts[0].id), KEY_A, 'key lands in credentials only');
  assert.equal(JSON.stringify(state.settings.minimaxManagedAccounts).includes(KEY_A), false, 'metadata never carries the raw key');
  assert.equal(result.accounts[0].accountLabel, 'Personal');
  assert.deepEqual(state.invalidations, [{
    scope: { provider: 'minimax', accountId: result.accounts[0].id, accountKey: accountKeyFor(KEY_A) },
    reason: 'account-added',
    invalidationOptions: undefined
  }]);
});

test('addAccount refuses an invalid key without touching storage', async () => {
  const { state, controller } = createHarness({ validationError: 'invalidApiKey' });

  const result = await controller.addAccount(KEY_A, '');

  assert.deepEqual(result, { ok: false, errorCode: 'invalidApiKey' });
  assert.equal(state.persisted, 0);
  assert.equal(state.credentials.size, 0);
  assert.equal(state.invalidations.length, 0);
});

test('updateAccount with an unchanged key only relabels and refreshes the lane', async () => {
  const { state, controller } = createHarness();
  const added = await controller.addAccount(KEY_A, '');
  const id = added.accounts[0].id;

  state.validations.length = 0;
  const result = await controller.updateAccount(id, KEY_A, 'Work');

  assert.equal(result.ok, true);
  assert.equal(state.validations.length, 0, 'no live validation when the key is unchanged');
  assert.equal(result.accounts[0].accountLabel, 'Work');
  assert.deepEqual(state.invalidations[state.invalidations.length - 1], {
    scope: { provider: 'minimax', accountId: id, accountKey: accountKeyFor(KEY_A) },
    reason: 'account-state',
    invalidationOptions: { clear: false, refresh: true }
  });
});

test('updateAccount swapping the key invalidates the old identity and refreshes the new one', async () => {
  const { state, controller } = createHarness();
  const added = await controller.addAccount(KEY_A, 'Personal');
  const id = added.accounts[0].id;
  state.invalidations.length = 0;

  const result = await controller.updateAccount(id, KEY_B, '');

  assert.equal(result.ok, true);
  assert.equal(state.credentials.get(id), KEY_B);
  assert.equal(result.accounts[0].accountKey, accountKeyFor(KEY_B));
  const reasons = state.invalidations.map((entry) => entry.reason);
  assert.deepEqual(reasons, ['account-removed', 'account-added']);
  assert.equal(state.invalidations[0].scope.accountKey, accountKeyFor(KEY_A), 'old identity cleared');
  assert.equal(state.invalidations[1].scope.accountKey, accountKeyFor(KEY_B), 'new identity refreshed');
});

test('updateAccount rejects a key that duplicates another account', async () => {
  const { state, controller } = createHarness();
  await controller.addAccount(KEY_A, '');
  const second = await controller.addAccount(KEY_B, '');
  // accounts 列表按添加序返回，取 keySuffix 定位刚加入的第二个账号。
  const secondId = second.accounts.find((entry) => entry.keySuffix === 'bbbb').id;
  state.validations.length = 0;

  const result = await controller.updateAccount(secondId, KEY_A, '');

  assert.deepEqual(result, { ok: false, errorCode: 'duplicateAccount' });
  assert.equal(state.validations.length, 0, 'duplicate check precedes validation');
  assert.equal(state.credentials.get(secondId), KEY_B, 'credential untouched');
});

test('updateAccount rolls the credential back when the settings write fails', async () => {
  const { state, controller } = createHarness();
  const added = await controller.addAccount(KEY_A, '');
  const id = added.accounts[0].id;
  state.persistError = new Error('disk full');

  const result = await controller.updateAccount(id, KEY_B, '');

  assert.equal(result.ok, false);
  assert.equal(state.credentials.get(id), KEY_A, 'credential restored');
});

test('migrateLegacyKey converts the single-key era once and is idempotent', () => {
  const { state, controller } = createHarness({ legacyKey: KEY_A });

  controller.migrateLegacyKey();
  assert.equal(state.settings.minimaxApiKey, '', 'legacy key cleared');
  assert.equal(state.settings.minimaxManagedAccounts.length, 1);
  assert.equal(state.credentials.size, 1);
  const account = state.settings.minimaxManagedAccounts[0];
  assert.equal(account.accountKey, accountKeyFor(KEY_A), 'identity formula unchanged');
  assert.ok(!('apiKey' in account), 'metadata carries no key');

  // 幂等：已有账号后再次迁移是 no-op。
  state.persisted = 0;
  controller.migrateLegacyKey();
  assert.equal(state.persisted, 0);
});

test('migrateLegacyKey keeps the legacy path when the settings write fails', () => {
  const { state, controller } = createHarness({ legacyKey: KEY_A });
  state.persistError = new Error('disk full');

  controller.migrateLegacyKey();

  assert.equal(state.settings.minimaxApiKey, KEY_A, 'legacy key preserved');
  assert.deepEqual(state.settings.minimaxManagedAccounts, []);
});

test('reorderAccounts rewrites the display order and tolerates partial input', async () => {
  const { state, controller } = createHarness();
  const first = await controller.addAccount(KEY_A, '');
  const second = await controller.addAccount(KEY_B, '');
  const third = await controller.addAccount('sk-cp-cccc', '');
  const ids = first.accounts.map((entry) => entry.id);

  // 把第二个账号拖到最前：完整 id 顺序幂等重排。
  const secondId = second.accounts.find((entry) => entry.keySuffix === 'bbbb').id;
  const thirdId = third.accounts.find((entry) => entry.keySuffix === 'cccc').id;
  const result = await controller.reorderAccounts([secondId, ...ids]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.accounts.map((entry) => entry.keySuffix), ['bbbb', 'aaaa', 'cccc']);
  assert.equal(state.settings.minimaxManagedAccounts.map((entry) => entry.keySuffix).join(''), 'bbbbaaaacccc');

  // 漏传的账号保持在尾部，未知 id 被忽略——重排永远收敛。
  const partial = await controller.reorderAccounts([thirdId, 'unknown-id']);
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.accounts.map((entry) => entry.keySuffix), ['cccc', 'bbbb', 'aaaa']);

  // 顺序未变时跳过持久化。
  state.persisted = 0;
  const unchanged = await controller.reorderAccounts(partial.accounts.map((entry) => entry.id));
  assert.equal(unchanged.ok, true);
  assert.equal(state.persisted, 0);
});
