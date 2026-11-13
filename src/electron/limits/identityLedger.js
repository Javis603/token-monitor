'use strict';

// Remembers which account keys this device has seen for one labelled account,
// so a key that rotates while the app is closed is still recognized as a rename
// rather than a new account (see shared/limits/identityInheritance for the rule
// itself). Only the account's keys and a digest of its label are stored: the
// label is usually an email, and equality is all a lookup needs.
//
// The rows this tracks are provider snapshots, not credentials — every key here
// already travels in sync payloads — and the file is scoped to this device's
// userData directory.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { readJson, writeJsonAtomic } = require('../../shared/config');
const { MAX_INHERITED_KEYS, accountLabel, identityScope } = require('../../shared/limits/identityInheritance');

const VERSION = 1;
const MAX_ACCOUNTS = 256;

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function accountId(row) {
  const label = accountLabel(row);
  if (!label) return '';
  return digest([identityScope(row), label]);
}

function validKey(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function createIdentityLedger(filePath, { now = Date.now } = {}) {
  const stored = readJson(filePath, null);
  const accounts = new Map();
  for (const entry of Array.isArray(stored?.accounts) ? stored.accounts : []) {
    if (!entry || typeof entry.id !== 'string' || !Array.isArray(entry.keys)) continue;
    accounts.set(entry.id, {
      id: entry.id,
      keys: entry.keys.filter(validKey).slice(-MAX_INHERITED_KEYS),
      at: Number(entry.at) || 0,
      signature: ''
    });
  }
  function save() {
    const rows = [...accounts.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_ACCOUNTS)
      .map(({ id, keys, at }) => ({ id, keys, at }));
    try {
      writeJsonAtomic(filePath, { version: VERSION, accounts: rows });
      // Account keys are identity, not telemetry: keep the ledger private like
      // the credentials and the quota history beside it.
      if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
      return true;
    } catch (error) {
      console.warn(`[limits] identity ledger could not be saved: ${error.message}`);
      return false;
    }
  }
  // The keys the account was recorded under before the one its row reports now.
  function recall(row) {
    const id = accountId(row);
    if (!id) return [];
    const entry = accounts.get(id);
    if (!entry) return [];
    const current = String(row?.accountKey || '').trim();
    return entry.keys.filter((key) => key !== current);
  }
  // Records the row's identity so the next rename of this account can be
  // recognized. A row without a label or key teaches nothing.
  function remember(row) {
    const id = accountId(row);
    const key = String(row?.accountKey || '').trim();
    if (!id || !key) return false;
    let entry = accounts.get(id);
    if (!entry) {
      entry = { id, keys: [], at: 0, signature: '' };
      accounts.set(id, entry);
    }
    const keys = [...new Set([...entry.keys, key,
      ...(Array.isArray(row?.accountKeyAliases) ? row.accountKeyAliases : []).map(value => String(value || '').trim())
    ].filter(validKey))].slice(-MAX_INHERITED_KEYS);
    const signature = keys.join('\n');
    if (entry.signature === signature) return true;
    entry.keys = keys;
    entry.signature = signature;
    entry.at = now();
    return save();
  }
  return { recall, remember };
}

module.exports = { createIdentityLedger };
