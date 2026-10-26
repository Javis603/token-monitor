'use strict';

const { randomUUID } = require('node:crypto');

const IDENTITY_FIELDS = ['accountKey', 'accountEmail', 'accountName', 'accountLabel'];

function claudeWebAccountMetadata(account) {
  return Object.fromEntries(['id', 'organizationId', ...IDENTITY_FIELDS]
    .map((key) => [key, String(account?.[key] || '').trim()]));
}

function normalizeClaudeManagedAccounts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((account) => {
    const metadata = claudeWebAccountMetadata(account);
    if (!metadata.id || seen.has(metadata.id)) return [];
    seen.add(metadata.id);
    return [{ ...metadata, enabled: account.enabled !== false,
      addedAt: String(account.addedAt || ''), updatedAt: String(account.updatedAt || '') }];
  });
}

function upsertClaudeManagedAccount(value, candidate, provider, accountId, now = Date.now()) {
  const accounts = normalizeClaudeManagedAccounts(value);
  const previous = accounts.find((account) => account.id === accountId)
    || accounts.find((account) => provider?.accountKey && account.accountKey === provider.accountKey);
  const timestamp = new Date(now).toISOString();
  const account = {
    ...claudeWebAccountMetadata(provider), id: previous?.id || randomUUID(),
    organizationId: candidate.claudeWebOrganizationId || '', enabled: true,
    addedAt: previous?.addedAt || timestamp, updatedAt: timestamp
  };
  if (previous?.organizationId === account.organizationId
    && (!account.accountKey || account.accountKey === previous.accountKey)) {
    for (const key of IDENTITY_FIELDS) account[key] ||= previous[key] || '';
  }
  const updated = previous ? accounts.map((entry) => entry.id === previous.id ? account : entry) : [...accounts, account];
  return updated.filter((entry) => entry.id === account.id || !account.accountKey || entry.accountKey !== account.accountKey);
}

module.exports = { claudeWebAccountMetadata, normalizeClaudeManagedAccounts,
  upsertClaudeManagedAccount };
