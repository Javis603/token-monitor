'use strict';

const MAX_CODEX_ACCOUNT_ALIASES = 100;
const MAX_CODEX_ACCOUNT_KEY_LENGTH = 256;
const MAX_CODEX_ACCOUNT_ALIAS_LENGTH = 80;

function cleanAliasText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function normalizeCodexAccountAliases(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [rawKey, rawAlias] of Object.entries(value)) {
    if (Object.keys(normalized).length >= MAX_CODEX_ACCOUNT_ALIASES) break;
    const key = cleanAliasText(rawKey, MAX_CODEX_ACCOUNT_KEY_LENGTH);
    const alias = cleanAliasText(rawAlias, MAX_CODEX_ACCOUNT_ALIAS_LENGTH);
    if (key && alias) normalized[key] = alias;
  }
  return normalized;
}

module.exports = {
  MAX_CODEX_ACCOUNT_ALIAS_LENGTH,
  normalizeCodexAccountAliases
};
