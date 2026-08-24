'use strict';

// 多账号（managed accounts）的 main 进程共用装配层。
//
// MiMo 与 MiniMax 共用同一套「settings 存元数据 + credentials.json 动态
// 路径存密钥」的骨架。账号创建与活体验证因供应商而异（cookie 解析 vs
// API key 清洗、错误码映射、email 回填 vs 自定义标签），由各供应商自备；
// 本模块只承载与供应商无关的部分：元数据归一化、删除/启停（含凭据
// 回滚与账号级 limits 失效）、IPC 注册样板——这些逻辑曾以 MiMo 专用
// 形式存在，MiniMax 接入前提取，避免两份平行实现漂移。

const MANAGED_ACCOUNT_EMAIL_MAX_LENGTH = 254;

// settings 侧元数据归一化：不去除 disabled 账号（启停状态是数据本身），
// 丢弃缺 id/accountKey 的残缺行并按 accountKey 去重。extraStringFields
// 是供应商自有的附加字符串字段（如 MiniMax 的 keySuffix 显示尾号），
// 永远不包含密钥本体——密钥只进 credentials.json。
function normalizeManagedAccountMeta(value, extraStringFields) {
  if (!Array.isArray(value)) return [];
  const extraFields = Array.isArray(extraStringFields) ? extraStringFields : [];
  const seen = new Set();
  const accounts = [];
  for (const account of value) {
    if (!account || typeof account !== 'object') continue;
    const id = String(account.id || '').trim();
    const accountKey = String(account.accountKey || '').trim();
    if (!id || !accountKey) continue;
    if (seen.has(accountKey)) continue;
    seen.add(accountKey);
    const normalized = {
      id,
      accountKey,
      accountEmail: String(account.accountEmail || '').trim().slice(0, MANAGED_ACCOUNT_EMAIL_MAX_LENGTH),
      accountLabel: String(account.accountLabel || '').trim(),
      addedAt: account.addedAt || new Date().toISOString(),
      updatedAt: account.updatedAt || account.addedAt || new Date().toISOString(),
      enabled: account.enabled !== false
    };
    for (const field of extraFields) {
      normalized[field] = String(account[field] || '').trim();
    }
    accounts.push(normalized);
  }
  return accounts;
}

// 删除/启停生命周期。config 各项均为注入的 main 侧能力：
//   provider                失效 scope 的供应商 id
//   normalizeAccounts        settings 元数据归一化（normalizeManagedAccountMeta 的供应商包装）
//   readCredential / writeCredential / removeCredential   credentials.json 动态路径读写
//   getAccounts / setAccounts   当前 settings 内的账号数组（元数据视角，不含密钥）
//   persistSettings          saveSettings({ throwOnError: true })——失败抛错触发回滚
//   broadcastChange          推送 settings 与账号列表到 renderer
//   queueInvalidation        账号级 limits 失效（queueLimitInvalidation）
function createManagedAccountLifecycle(config) {
  const {
    provider,
    normalizeAccounts,
    readCredential,
    writeCredential,
    removeCredential,
    getAccounts,
    setAccounts,
    persistSettings,
    broadcastChange,
    queueInvalidation
  } = config;

  function listAccounts() {
    return normalizeAccounts(getAccounts());
  }

  async function removeAccount(id) {
    const accountId = String(id || '').trim();
    const accounts = normalizeAccounts(getAccounts());
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    const previousCredential = readCredential(accountId);
    if (!removeCredential(accountId)) return { ok: false, error: 'Could not remove stored credential' };
    setAccounts(accounts.filter((entry) => entry.id !== accountId));
    try {
      persistSettings();
    } catch (_) {
      // 恢复内存中的账号列表与已删凭据，让内存与磁盘保持一致——
      // 否则下一次无关的 settings 保存会把这次失败的删除悄悄落盘。
      setAccounts(accounts);
      if (previousCredential) writeCredential(accountId, previousCredential);
      return { ok: false, error: 'Could not persist account removal' };
    }
    broadcastChange();
    queueInvalidation(
      { provider, accountId, accountKey: account.accountKey },
      'account-removed',
      { clear: true, refresh: false }
    );
    return { ok: true, accounts: listAccounts() };
  }

  function setAccountEnabled(id, enabled) {
    const accountId = String(id || '').trim();
    const accounts = normalizeAccounts(getAccounts());
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) return { ok: false, error: 'Account not found' };
    account.enabled = Boolean(enabled);
    account.updatedAt = new Date().toISOString();
    setAccounts(accounts);
    try {
      persistSettings();
    } catch (_) {
      return { ok: false, error: 'Could not persist account state' };
    }
    broadcastChange();
    queueInvalidation(
      { provider, accountId, accountKey: account.accountKey },
      'account-state',
      { clear: !account.enabled, refresh: account.enabled }
    );
    return { ok: true, accounts: listAccounts() };
  }

  return { listAccounts, removeAccount, setAccountEnabled };
}

// 四个标准 managed-account IPC channel 的注册样板。addAccount 各供应商
// 自行注册（参数形状不同：MiMo 只收 cookie，MiniMax 收 key + 可选标签）。
function registerManagedAccountIpc(ipcMain, channelPrefix, handlers) {
  ipcMain.handle(`${channelPrefix}:accounts`, () => handlers.listAccounts());
  ipcMain.handle(`${channelPrefix}:setAccountEnabled`, (_event, id, enabled) => handlers.setAccountEnabled(id, enabled));
  ipcMain.handle(`${channelPrefix}:removeAccount`, (_event, id) => handlers.removeAccount(id));
}

module.exports = {
  normalizeManagedAccountMeta,
  createManagedAccountLifecycle,
  registerManagedAccountIpc
};
