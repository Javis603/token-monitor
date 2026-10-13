'use strict';

// Collector-only boundary: persisted usage never contains native account IDs,
// addresses, or credentials. Portable usage normalization accepts hashed IDs only.
const { hashKey } = require('./hashKey');
const { normalizeUsageSource } = require('./usage');

const ACCOUNT_ID = /^sha256:[a-f0-9]{64}$/;

function sourceFromRow(row) {
  const explicit = row?.usageSource && typeof row.usageSource === 'object' && !Array.isArray(row.usageSource)
    ? row.usageSource : null;
  const raw = explicit || row || {};
  const provider = raw.platform ?? raw.provider ?? row?.provider ?? row?.providerId ?? row?.provider_id;
  const nativeId = raw.accountId ?? raw.account_id;
  const nativeLabel = raw.accountLabel ?? raw.account_label;
  const identity = typeof nativeId === 'string' || typeof nativeId === 'number'
    ? String(nativeId).trim() : '';
  const label = typeof nativeLabel === 'string' ? nativeLabel.trim() : '';
  const platform = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  const accountId = ACCOUNT_ID.test(identity) ? identity
    : (identity || label ? hashKey('usage-account-v1', platform, identity || label) : '');
  return normalizeUsageSource({
    platform,
    accountId,
    accessType: raw.accessType ?? raw.access_type
  });
}

function applyRowUsageSource(row) {
  if (!row || typeof row !== 'object') return;
  const source = sourceFromRow(row);
  if (source.platform || source.accountId || source.accessType !== 'unknown') row.usageSource = source;
  else delete row.usageSource;
  if (Array.isArray(row.usageSourceReferences)) {
    row.usageSourceReferences = row.usageSourceReferences.map((entry) => ({
      usageSource: sourceFromRow(entry),
      outputTokens: entry?.outputTokens,
      ...(typeof entry?.lastUsedAt === 'string' ? { lastUsedAt: entry.lastUsedAt } : {})
    }));
  }
  if (Array.isArray(row.usageSources)) {
    row.usageSources = row.usageSources.map((entry) => ({
      usageSource: sourceFromRow(entry),
      timedOutputTokens: entry?.timedOutputTokens,
      timedDurationMs: entry?.timedDurationMs
    }));
  }
}

module.exports = { applyRowUsageSource, sourceFromRow };
