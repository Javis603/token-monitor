'use strict';

// MiniMax 多账号（managed accounts）支持。
//
// settings.minimaxManagedAccounts 只保存账号元数据（不含密钥本体）；
// 每个账号的 API key 存放在 credentials.json 的
// providers.minimax.accounts.<id>.apiKey 动态路径下，与 MiMo 的动态账号
// 存储模式一致。accountKey 恒为 hashKey('minimax', apiKey)，与历史单账号
// 路径（settings.minimaxApiKey）保持同一公式——旧密钥迁移成第一个账号后
// 账号身份连续，limitsRuntime 的 per-account 调度与订阅绑定都不会断裂。

const crypto = require('node:crypto');
const { hashKey } = require('./hashKey');

const MINIMAX_ACCOUNT_ID_PREFIX = 'minimax-';
const MINIMAX_LABEL_MAX_LENGTH = 64;
const MINIMAX_KEY_SUFFIX_LENGTH = 4;

// 去除密钥两端空白与成对引号（从 minimaxLimits 的内部 cleanSecret 迁移
// 到此），供 minimaxLimits 与本模块共用，避免两份实现漂移。
function cleanMinimaxSecret(value) {
  let raw = value;
  if (typeof raw !== 'string') return '';
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function minimaxAccountKey(apiKey) {
  return hashKey('minimax', apiKey);
}

// API key 是不透明字符串，无法像 MiMo cookie 那样解析出邮箱，尾号
// （…abcd）是多账号在 UI 中区分账号的最低限度信息。仅在创建账号时
// 派生一次存入元数据，之后展示层不再需要密钥本体。
function minimaxKeySuffix(apiKey) {
  return apiKey.slice(-MINIMAX_KEY_SUFFIX_LENGTH);
}

// 采集侧归一化：过滤未启用与无效密钥的账号，按 accountKey 去重。
// 入参每个账号需带 apiKey（由 main 侧从 credentials.json 拼回），输出
// 直接供 fetchMinimaxLimits 逐账号探测。
function normalizeMinimaxManagedAccounts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const accounts = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || item.enabled === false) continue;
    const apiKey = cleanMinimaxSecret(item.apiKey);
    if (!apiKey) continue;
    const accountKey = String(item.accountKey || '').trim() || minimaxAccountKey(apiKey);
    if (seen.has(accountKey)) continue;
    seen.add(accountKey);
    accounts.push({ ...item, accountKey, apiKey });
  }
  return accounts;
}

// limitRefreshScope 过滤，语义与 scopedMimoManagedAccounts 对齐：账号级
// 刷新必须定位到唯一账号，配置了多个账号却不带账号标识时抛错，防止
// 一次「账号级」刷新实际退化为全量扫描（探测时限只按一份预算发放）。
function scopedMinimaxManagedAccounts(value, scope) {
  const accounts = normalizeMinimaxManagedAccounts(value);
  if (!scope) return accounts;
  const hasAccountIdentifier = Boolean(scope.accountKey || scope.accountLabel);
  if (!hasAccountIdentifier && accounts.length > 1) {
    throw new TypeError('MiniMax limit refresh scope requires an account identifier when multiple accounts are configured');
  }
  return accounts.filter((account) => {
    if (scope.accountKey) return account.accountKey === scope.accountKey;
    if (scope.accountLabel) return account.accountLabel === scope.accountLabel;
    return true;
  });
}

// 创建/更新账号。重复添加同一密钥视为更新该账号（保留 id 与 addedAt，
// 覆盖标签），与 createMimoManagedAccount 的去重语义一致。返回的 account
// 短暂持有 apiKey：调用方活体验证、写入 credentials.json 后必须剥离
// apiKey 再存入 settings（元数据永不落密钥）。
function createMinimaxManagedAccount(apiKeyValue, accountLabel, existing) {
  const apiKey = cleanMinimaxSecret(apiKeyValue);
  if (!apiKey) {
    return { ok: false, errorCode: 'missingApiKey' };
  }
  const label = String(accountLabel || '').trim().slice(0, MINIMAX_LABEL_MAX_LENGTH);
  const accountKey = minimaxAccountKey(apiKey);
  const duplicate = (existing || []).find(
    (account) => String(account?.accountKey || '').trim() === accountKey
  );
  return {
    ok: true,
    account: {
      id: duplicate?.id || `${MINIMAX_ACCOUNT_ID_PREFIX}${crypto.randomUUID()}`,
      accountKey,
      accountLabel: label || String(duplicate?.accountLabel || '').trim(),
      keySuffix: minimaxKeySuffix(apiKey),
      apiKey,
      addedAt: duplicate?.addedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      enabled: true
    }
  };
}

// 账号显示名：自定义标签优先，未填时回退 key 尾号（4 位）。尾号不带
// 省略号等装饰字符——wire 层 normalizeAccountLabel 的字符白名单会把它
// 剥掉，导致设置页与 limits 页显示不一致。
function minimaxAccountDisplayLabel(account) {
  const label = String(account?.accountLabel || '').trim();
  if (label) return label;
  return String(account?.keySuffix || '').trim();
}

module.exports = {
  MINIMAX_LABEL_MAX_LENGTH,
  cleanMinimaxSecret,
  createMinimaxManagedAccount,
  minimaxAccountDisplayLabel,
  minimaxAccountKey,
  minimaxKeySuffix,
  normalizeMinimaxManagedAccounts,
  scopedMinimaxManagedAccounts
};
