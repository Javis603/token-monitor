'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeManagedAccountMeta,
  createManagedAccountLifecycle,
  registerManagedAccountIpc
} = require('../../src/electron/managedAccounts');

// 构造一个受控的 main 侧环境：settings 数组、credentials.json 动态路径
// 读写、持久化与账号级失效全部记录在案，供断言。
function createHarness(options = {}) {
  const state = {
    settings: { managed: [...(options.initialAccounts || [])] },
    persisted: 0,
    persistError: null,
    broadcasts: 0,
    invalidations: [],
    credentials: new Map()
  };
  const config = {
    provider: 'minimax',
    normalizeAccounts: (value) => normalizeManagedAccountMeta(value, ['keySuffix']),
    readCredential: (id) => state.credentials.get(id) || '',
    writeCredential: (id, value) => {
      state.credentials.set(id, value);
      return true;
    },
    removeCredential: (id) => {
      state.credentials.delete(id);
      return true;
    },
    getAccounts: () => state.settings.managed,
    setAccounts: (accounts) => {
      state.settings.managed = accounts;
    },
    persistSettings: () => {
      state.persisted += 1;
      if (state.persistError) throw state.persistError;
    },
    broadcastChange: () => {
      state.broadcasts += 1;
    },
    queueInvalidation: (scope, reason, invalidationOptions) => {
      state.invalidations.push({ scope, reason, invalidationOptions });
    }
  };
  return { state, lifecycle: createManagedAccountLifecycle(config) };
}

const ACCOUNT_A = {
  id: 'minimax-a', accountKey: 'sha256:a', accountLabel: 'Personal',
  keySuffix: 'aaaa', addedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', enabled: true
};
const ACCOUNT_B = {
  id: 'minimax-b', accountKey: 'sha256:b', accountLabel: 'Work',
  keySuffix: 'bbbb', addedAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', enabled: true
};

test('normalizeManagedAccountMeta keeps disabled rows, drops malformed ones, and dedupes', () => {
  const normalized = normalizeManagedAccountMeta([
    ACCOUNT_A,
    { ...ACCOUNT_A, accountEmail: 'dup@example.com' }, // 同 accountKey 的重复行
    { ...ACCOUNT_B, enabled: false }, // 停用行保留（启停是数据本身）
    { id: '' }, // 缺 id
    { accountKey: 'sha256:x' }, // 缺 accountKey
    null,
    'garbage'
  ], ['keySuffix']);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[1].enabled, false);
  assert.equal(normalized[0].keySuffix, 'aaaa', '供应商附加字段被保留');
  assert.equal(normalized[0].id, 'minimax-a');
});

test('removeAccount deletes the credential, persists, and clears the per-account lane', async () => {
  const { state, lifecycle } = createHarness({ initialAccounts: [ACCOUNT_A, ACCOUNT_B] });
  state.credentials.set('minimax-a', 'sk-cp-a');

  const result = await lifecycle.removeAccount('minimax-a');

  assert.equal(result.ok, true);
  assert.deepEqual(result.accounts.map((account) => account.id), ['minimax-b']);
  assert.equal(state.credentials.has('minimax-a'), false, 'credential removed');
  assert.equal(state.persisted, 1);
  assert.equal(state.broadcasts, 1);
  assert.deepEqual(state.invalidations, [{
    scope: { provider: 'minimax', accountId: 'minimax-a', accountKey: 'sha256:a' },
    reason: 'account-removed',
    invalidationOptions: { clear: true, refresh: false }
  }]);
});

test('removeAccount rolls the credential back when the settings write fails', async () => {
  const { state, lifecycle } = createHarness({ initialAccounts: [ACCOUNT_A] });
  state.credentials.set('minimax-a', 'sk-cp-a');
  state.persistError = new Error('disk full');

  const result = await lifecycle.removeAccount('minimax-a');

  assert.equal(result.ok, false);
  assert.equal(state.credentials.get('minimax-a'), 'sk-cp-a', 'credential restored');
  assert.deepEqual(state.settings.managed.map((account) => account.id), ['minimax-a']);
  assert.equal(state.invalidations.length, 0);
});

test('setAccountEnabled persists the flag and refreshes or clears the lane accordingly', async () => {
  const { state, lifecycle } = createHarness({ initialAccounts: [ACCOUNT_A] });

  const disabled = lifecycle.setAccountEnabled('minimax-a', false);
  assert.equal(disabled.ok, true);
  assert.equal(state.settings.managed[0].enabled, false);
  assert.deepEqual(state.invalidations[0].invalidationOptions, { clear: true, refresh: false });

  const enabled = lifecycle.setAccountEnabled('minimax-a', true);
  assert.equal(enabled.ok, true);
  assert.equal(state.settings.managed[0].enabled, true);
  assert.deepEqual(state.invalidations[1].invalidationOptions, { clear: false, refresh: true });
  assert.equal(state.invalidations[1].reason, 'account-state');
});

test('registerManagedAccountIpc wires the shared channels', () => {
  const registered = new Map();
  const ipcMain = { handle: (channel, handler) => registered.set(channel, handler) };
  const handlers = {
    listAccounts: () => ['a'],
    setAccountEnabled: (id, enabled) => ({ id, enabled }),
    removeAccount: (id) => ({ id })
  };
  registerManagedAccountIpc(ipcMain, 'minimax', handlers);
  assert.deepEqual([...registered.keys()], [
    'minimax:accounts',
    'minimax:setAccountEnabled',
    'minimax:removeAccount'
  ]);
});
