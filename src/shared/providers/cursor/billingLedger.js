'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalCursorUserId } = require('./auth');
const { cursorCacheDir } = require('./usageEvents');
const { normalizeTokscaleModelNameForClient } = require('../../history');
const { readRegularFileNoFollow } = require('../../credentialStore');

const BILLING_LEDGER_MAX_BYTES = 64 * 1024 * 1024;

function billingAccountKey(accountId) {
  const id = String(accountId || '').trim();
  if (!id || id.length > 256) throw new Error('Cursor account is required for billing recovery');
  return crypto.createHash('sha256').update(id).digest('hex');
}

function billingIdentityHash(email) {
  const value = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return value ? crypto.createHash('sha256').update(value).digest('hex') : '';
}

function billingItemsPath(userDataPath, accountId) {
  return path.join(userDataPath, 'cursor-billing', `${billingAccountKey(accountId)}.json`);
}

function normalizeBillingRow(row) {
  if (!row || typeof row.model !== 'string' || !row.model.trim()
    || !Number.isSafeInteger(row.eventTime) || row.eventTime <= 0
    || !Number.isFinite(new Date(row.eventTime).getTime())) return null;
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  if (!fields.every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)) return null;
  const totalTokens = fields.reduce((sum, key) => sum + row[key], 0);
  if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0 || totalTokens !== row.totalTokens) return null;
  return { ...(typeof row.id === 'string' && row.id ? { id: row.id } : {}),
    eventTime: row.eventTime, model: normalizeTokscaleModelNameForClient(row.model, 'cursor'),
    ...Object.fromEntries(fields.map(key => [key, row[key]])), totalTokens };
}

function readBillingRows(filePath, accountId) {
  try {
    const stored = JSON.parse(readRegularFileNoFollow(filePath, { maxBytes: BILLING_LEDGER_MAX_BYTES }));
    if (stored.version !== 2 || stored.accountKey !== billingAccountKey(accountId) || !Array.isArray(stored.rows)) return [];
    const identityHash = /^[0-9a-f]{64}$/.test(stored.identityHash || '') ? stored.identityHash : '';
    return stored.rows.map(normalizeBillingRow).filter(Boolean)
      .map(row => identityHash ? { ...row, billingEmailHash: identityHash } : row);
  } catch (_) { return []; }
}

function eventKey(row) {
  return [row.eventTime, row.model, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens].join(':');
}

// The native cache identifies its owner separately from the active login. A
// switch must never reassign an old usage.json to the newly active account.
function nativeAccountRows(accountId, options = {}) {
  const dir = options.cacheDir || cursorCacheDir(options);
  const files = [];
  for (const folder of [dir, path.join(dir, 'archive')]) {
    try {
      const pattern = folder === dir ? /^usage(?:\.[^/\\]+)?\.json$/ : /^usage.*\.json$/;
      for (const name of fs.readdirSync(folder)) if (pattern.test(name)) files.push(path.join(folder, name));
    } catch (_) {}
  }
  const rows = new Map();
  let unowned = false;
  const account = canonicalCursorUserId(accountId) || accountId;
  for (const file of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { unowned = true; continue; }
    const owner = data?._tokscale?.accountId;
    if (!owner && data?.usageEventsDisplay?.length) { unowned = true; continue; }
    if ((canonicalCursorUserId(owner) || owner) !== account) continue;
    if (!Array.isArray(data.usageEventsDisplay)) { unowned = true; continue; }
    const occurrences = new Map();
    for (const event of data.usageEventsDisplay) {
      const usage = event.tokenUsage || {};
      const eventTime = /^\d+$/.test(String(event.timestamp)) ? Number(event.timestamp) : Date.parse(event.timestamp);
      const counters = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
        .map(key => Number(usage[key] ?? 0));
      const row = normalizeBillingRow({ eventTime, model: event.model,
        ...Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map((key, i) => [key, counters[i]])),
        totalTokens: counters.reduce((sum, count) => sum + count, 0) });
      if (!row) continue;
      // An archived copy of the same source event is not a second native call.
      const key = eventKey(row);
      occurrences.set(key, (occurrences.get(key) || 0) + 1);
      const id = event.usageEventId || event.id
        ? `id:${event.usageEventId || event.id}` : `anonymous:${key}:${occurrences.get(key)}`;
      rows.set(id, { ...row, nativeSessionId: String(event.conversationId || '') });
    }
  }
  return { rows: [...rows.values()], unowned };
}

function billingNativeSnapshot(accounts, now, options = {}) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const byAccount = new Map();
  const parts = [];
  for (const account of accounts) {
    if (!account?.accountId || byAccount.has(account.accountId)) continue;
    const native = nativeAccountRows(account.accountId, options);
    byAccount.set(account.accountId, native);
    parts.push([billingAccountKey(account.accountId), native.unowned,
      native.rows.filter(row => row.eventTime < +today).map(row => `${eventKey(row)}:${row.nativeSessionId}`).sort()]);
  }
  parts.sort((a, b) => a[0].localeCompare(b[0]));
  return { byAccount, signature: crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex') };
}

function reconcileBillingRows(rows, native) {
  if (native.unowned) return [];
  const day = row => new Date(row.eventTime).toISOString().slice(0, 10);
  const byDay = new Map();
  for (const row of rows) {
    const key = day(row);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  }
  const nativeDays = new Map();
  for (const row of native.rows) {
    const key = day(row);
    if (!nativeDays.has(key)) nativeDays.set(key, []);
    nativeDays.get(key).push(row);
  }
  const result = [];
  for (const [date, bills] of byDay) {
    const events = nativeDays.get(date) || [];
    if (!events.length) { result.push(...bills); continue; }
    const remaining = new Set(bills);
    let completeMatch = true;
    for (const event of events) {
      const match = [...remaining].find(bill => eventKey(bill) === eventKey(event));
      if (!match) { completeMatch = false; break; }
      remaining.delete(match);
    }
    // Without a complete native-to-billing join for the day, the native day
    // takes precedence. A sparse resumed export cannot erase other gap days.
    if (completeMatch) result.push(...remaining);
  }
  return result;
}

module.exports = { BILLING_LEDGER_MAX_BYTES, billingAccountKey, billingIdentityHash, billingItemsPath, billingNativeSnapshot, nativeAccountRows,
  normalizeBillingRow, readBillingRows, reconcileBillingRows };
