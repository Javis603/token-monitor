'use strict';

// API key 型供应商的 main 进程装配工厂（minimax / deepseek / zai 共用）。
//
// 与 managedAccounts.js（更低一层的通用生命周期）配合：本工厂封装「添加
// （活体验证 → 写凭据 → 存元数据 → 账号级失效）」「编辑（标签-only /
// 换 key 双路径，换 key = 换账号身份双失效）」「旧单 key 一次性迁移」的
// 同构骨架；各供应商只注入自己的活体验证函数（probe 一次对应 fetcher）。
// 密钥永远只进 credentials.json 的 providers.<provider>.accounts.<id>.apiKey
// 动态路径，settings 只存元数据。

const {
  API_KEY_LABEL_MAX_LENGTH,
  apiKeyAccountDisplayLabel,
  apiKeySuffix,
  cleanApiKeySecret,
  createApiKeyManagedAccount,
  managedApiKeyAccountKey
} = require('../shared/apiKeyAccounts');
const {
  createManagedAccountLifecycle,
  normalizeManagedAccountMeta,
  registerManagedAccountIpc
} = require('./managedAccounts');

function createApiKeyAccountController(config) {
  const {
    provider,
    getSettings,
    persistSettings,
    broadcastChange,
    queueInvalidation,
    resolveCredentialStore,
    validateAccount
  } = config;
  const settingsKey = `${provider}ManagedAccounts`;
  const legacyKey = `${provider}ApiKey`;

  function normalizeMeta(value) {
    return normalizeManagedAccountMeta(value, ['keySuffix']);
  }

  function readAccounts() {
    return normalizeMeta(getSettings()?.[settingsKey]);
  }

  function writeAccounts(accounts) {
    getSettings()[settingsKey] = normalizeMeta(accounts);
  }

  function readCredential(id) {
    try {
      return cleanApiKeySecret(resolveCredentialStore().readManagedAccountCredential(provider, id, 'apiKey'));
    } catch (_) {
      return '';
    }
  }

  function writeCredential(id, value) {
    const apiKey = cleanApiKeySecret(value);
    if (!apiKey) return false;
    try {
      return resolveCredentialStore().writeManagedAccountCredential(provider, id, 'apiKey', apiKey);
    } catch (_) {
      return false;
    }
  }

  function removeCredential(id) {
    try {
      return resolveCredentialStore().removeManagedAccountCredentials(provider, id);
    } catch (_) {
      return false;
    }
  }

  function accountsForRenderer() {
    return readAccounts();
  }

  // 采集侧投影：元数据 + 从 credentials.json 拼回的 apiKey，无凭据的行
  // 直接丢弃（残留元数据不参与探测）。
  function managedAccountsForCollector() {
    return readAccounts().map((account) => ({
      ...account,
      apiKey: readCredential(account.id)
    })).filter((account) => account.apiKey);
  }

  const lifecycle = createManagedAccountLifecycle({
    provider,
    normalizeAccounts: normalizeMeta,
    readCredential,
    writeCredential,
    removeCredential,
    getAccounts: () => getSettings()?.[settingsKey],
    setAccounts: writeAccounts,
    persistSettings,
    broadcastChange,
    queueInvalidation
  });

  async function addAccount(apiKeyValue, accountLabel) {
    const accounts = readAccounts();
    const result = createApiKeyManagedAccount(provider, apiKeyValue, String(accountLabel || ''), accounts);
    if (!result.ok) return result;
    // 活体验证：新密钥先探测一次，unauthorized 直接拒绝入库。
    const validation = await validateAccount(result.account);
    if (!validation?.ok) return validation;
    const previousCredential = readCredential(result.account.id);
    const credentialStored = writeCredential(result.account.id, result.account.apiKey);
    delete result.account.apiKey;
    if (!credentialStored) return { ok: false, errorCode: 'credentialStorageUnavailable' };
    writeAccounts([
      ...accounts.filter((account) => account.accountKey !== result.account.accountKey),
      result.account
    ]);
    try {
      persistSettings();
    } catch (_) {
      if (previousCredential) writeCredential(result.account.id, previousCredential);
      else removeCredential(result.account.id);
      return { ok: false, errorCode: 'credentialStorageUnavailable' };
    }
    broadcastChange();
    queueInvalidation(
      { provider, accountId: result.account.id, accountKey: result.account.accountKey },
      'account-added'
    );
    return { ok: true, accounts: accountsForRenderer() };
  }

  async function updateAccount(id, apiKeyValue, accountLabel) {
    const accountId = String(id || '').trim();
    const accounts = readAccounts();
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    const nextLabel = String(accountLabel ?? '').trim().slice(0, API_KEY_LABEL_MAX_LENGTH);
    const nextKey = cleanApiKeySecret(apiKeyValue ?? '');
    const currentKey = readCredential(accountId);

    // key 留空或与当前一致：仅更新标签（清空则回退 key 尾号），不触碰凭据。
    if (!nextKey || nextKey === currentKey) {
      account.accountLabel = nextLabel;
      account.updatedAt = new Date().toISOString();
      writeAccounts(accounts);
      try {
        persistSettings();
      } catch (_) {
        return { ok: false, error: 'Could not persist account label' };
      }
      broadcastChange();
      queueInvalidation(
        { provider, accountId, accountKey: account.accountKey },
        'account-state',
        { clear: false, refresh: true }
      );
      return { ok: true, accounts: accountsForRenderer() };
    }

    // key 有变化：不能与其他已配置账号重复（那就是另一个账号本身）。
    const nextAccountKey = managedApiKeyAccountKey(provider, nextKey);
    if (accounts.some((entry) => entry.id !== accountId && entry.accountKey === nextAccountKey)) {
      return { ok: false, errorCode: 'duplicateAccount' };
    }
    // 活体验证：新 key 先探测一次，unauthorized 直接拒绝换钥。
    const validation = await validateAccount({ ...account, apiKey: nextKey, accountKey: nextAccountKey });
    if (!validation?.ok) return validation;
    const previousAccountKey = account.accountKey;
    if (!writeCredential(accountId, nextKey)) {
      return { ok: false, errorCode: 'credentialStorageUnavailable' };
    }
    Object.assign(account, {
      accountKey: nextAccountKey,
      accountLabel: nextLabel || String(account.accountLabel || '').trim(),
      keySuffix: apiKeySuffix(nextKey),
      updatedAt: new Date().toISOString()
    });
    writeAccounts(accounts);
    try {
      persistSettings();
    } catch (_) {
      if (currentKey) writeCredential(accountId, currentKey);
      return { ok: false, errorCode: 'credentialStorageUnavailable' };
    }
    broadcastChange();
    // 换 key = 换账号身份：旧身份的行数据清掉，新身份立即采集。
    queueInvalidation(
      { provider, accountId, accountKey: previousAccountKey },
      'account-removed',
      { clear: true, refresh: false }
    );
    queueInvalidation(
      { provider, accountId, accountKey: nextAccountKey },
      'account-added'
    );
    return { ok: true, accounts: accountsForRenderer() };
  }

  // 旧单账号密钥（settings.<provider>ApiKey）一次性迁移为第一个托管
  // 账号，幂等：仅当没有任何账号且旧密钥存在时执行；凭据写入成功后才
  // 清空旧 settings key，任何一步失败都保持旧路径下次重试。accountKey
  // 公式与单账号路径一致，limits 身份与订阅绑定保持连续。
  function migrateLegacyKey() {
    const legacyKeyValue = cleanApiKeySecret(getSettings()?.[legacyKey] || '');
    if (!legacyKeyValue) return;
    if (readAccounts().length > 0) return;
    const result = createApiKeyManagedAccount(provider, legacyKeyValue, '', []);
    if (!result.ok) return;
    if (!writeCredential(result.account.id, result.account.apiKey)) return;
    const { apiKey, ...meta } = result.account;
    writeAccounts([meta]);
    getSettings()[legacyKey] = '';
    try {
      persistSettings();
    } catch (_) {
      // settings 落盘失败则整体回退：旧 key 路径继续工作，凭据残留在
      // credentials.json 中等待下次迁移覆盖，无需回滚删除。
      getSettings()[settingsKey] = [];
      getSettings()[legacyKey] = legacyKeyValue;
    }
  }

  // 标准托管账号 channel 之外的两条供应商特有通道（add 带标签参数、
  // update 带三参），与 registerManagedAccountIpc 的三条一起注册。
  function registerIpc(ipcMain) {
    ipcMain.handle(`${provider}:addAccount`, (_event, apiKey, accountLabel) => addAccount(apiKey, accountLabel));
    ipcMain.handle(`${provider}:updateAccount`, (_event, id, apiKey, accountLabel) => updateAccount(id, apiKey, accountLabel));
    registerManagedAccountIpc(ipcMain, provider, {
      listAccounts: accountsForRenderer,
      setAccountEnabled: lifecycle.setAccountEnabled,
      removeAccount: lifecycle.removeAccount
    });
  }

  return {
    accountsForRenderer,
    managedAccountsForCollector,
    addAccount,
    updateAccount,
    migrateLegacyKey,
    lifecycle,
    registerIpc,
    displayLabel: apiKeyAccountDisplayLabel
  };
}

module.exports = { createApiKeyAccountController };
