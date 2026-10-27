'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readRegularFileNoFollow, writePrivateJsonAtomic } = require('../../credentialStore');
const { cursorCacheDir } = require('./usageEvents');
const { normalizeBillingRow } = require('./billingLedger');
const { readCursorLocalTurnUsage } = require('./localSessions');
const { explicitModelId, mergeModelEvidence } = require('./localModels');

const MAX_BYTES = 64 * 1024 * 1024;
const dayKey = time => new Date(time).toISOString().slice(0, 10);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Only whole UTC days absent from every native cache may use local counters.
// An unreadable or incomplete cache cannot establish that absence. The legacy
// export has a fixed leading ISO Date column; other CSV fields are not parsed.
function localNativeCoverage(options = {}) {
  const dir = options.cacheDir || cursorCacheDir(options);
  const days = new Set();
  const historical = [];
  const today = new Date(options.now || Date.now()); today.setHours(0, 0, 0, 0);
  let unavailable = false;
  let files = 0;
  for (const folder of [dir, path.join(dir, 'archive')]) {
    let names;
    try { names = fs.readdirSync(folder); }
    catch (error) { if (error.code !== 'ENOENT') unavailable = true; continue; }
    for (const name of names.filter(name => /^usage.*\.(?:json|csv)$/.test(name))) {
      files++;
      try {
        const data = readRegularFileNoFollow(path.join(folder, name), { maxBytes: MAX_BYTES });
        if (name.endsWith('.csv')) {
          const lines = String(data).replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
          if (!/^"?Date"?,/.test(lines[0] || '')) { if (data.length) unavailable = true; continue; }
          for (const line of lines.slice(1)) {
            const date = /^"?(\d{4}-\d{2}-\d{2}T[^",]+)"?,/.exec(line)?.[1];
            const time = Date.parse(date || '');
            if (!(time > 0) || !Number.isFinite(new Date(time).getTime())) { unavailable = true; continue; }
            days.add(dayKey(time));
            if (time < +today) historical.push(JSON.stringify([time, 'legacy', hash(line)]));
          }
          continue;
        }
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed?.usageEventsDisplay)) { unavailable = true; continue; }
        for (const event of parsed.usageEventsDisplay) {
          const time = /^\d+$/.test(String(event.timestamp)) ? Number(event.timestamp) : Date.parse(event.timestamp);
          if (!(time > 0) || !Number.isFinite(new Date(time).getTime())) { unavailable = true; continue; }
          days.add(dayKey(time));
          if (time < +today) historical.push(JSON.stringify([time, event.model, event.tokenUsage, event.conversationId]));
        }
      } catch (_) { unavailable = true; }
    }
  }
  historical.sort();
  return { days, files, unavailable, signature: `local:${hash([unavailable, historical])}` };
}

function normalizedRow(value) {
  const row = normalizeBillingRow(value);
  if (!row || !/^[a-f0-9]{64}$/.test(row.id || '')) return null;
  if (row.model !== 'unknown' && (!explicitModelId(row.model) || typeof value.priceable !== 'boolean')) return null;
  if (value.modelConflict === true && row.model !== 'unknown') return null;
  return { ...row, ...(typeof value.priceable === 'boolean' ? { priceable: value.priceable } : {}),
    ...(value.modelConflict === true ? { modelConflict: true } : {}) };
}

// The collector is the single writer. Persist only verified scalar counters,
// so log rotation cannot retract recorded usage or retain conversation content.
function readCursorLocalUsage(options = {}) {
  const file = options.localUsagePath || path.join(cursorCacheDir(options), '..', 'cursor-local-usage.json');
  let saved = { version: 2, rows: [], conflicts: [] };
  try {
    saved = JSON.parse(readRegularFileNoFollow(file, { maxBytes: MAX_BYTES }));
    if (![1, 2].includes(saved.version) || !Array.isArray(saved.rows) || !Array.isArray(saved.conflicts)
      || saved.rows.some(row => !normalizedRow(row))
      || saved.conflicts.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid Cursor local usage ledger');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const observed = (options.readTurns || readCursorLocalTurnUsage)(options);
  const conflicts = new Set([...saved.conflicts, ...observed.conflicts]);
  const rows = new Map(saved.rows.map(row => [row.id, normalizedRow(row)]));
  for (const input of observed.rows) {
    const row = normalizedRow(input);
    if (!row) continue;
    const previous = rows.get(row.id);
    if (previous && ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
      .some(key => previous[key] !== row[key])) conflicts.add(row.id);
    else rows.set(row.id, { ...row, eventTime: Math.min(previous?.eventTime || row.eventTime, row.eventTime),
      ...mergeModelEvidence(previous, row) });
  }
  for (const id of conflicts) rows.delete(id);
  const next = { version: 2, rows: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)), conflicts: [...conflicts].sort() };
  const changed = JSON.stringify(saved) !== JSON.stringify(next);
  if (changed) writePrivateJsonAtomic(file, next, { compact: true, maxBytes: MAX_BYTES });
  // Details must honor durable rejections even when coverage or billing
  // precedence withholds this ledger's accounting rows for the current tick.
  options.onCursorLocalUsageConflicts?.(next.conflicts);
  if (options.cursorBillingAccounts?.length) return [];
  const coverage = options.coverage || localNativeCoverage(options);
  const now = +new Date(options.now || Date.now());
  const since = Date.parse(options.allTimeSince || '') || 0;
  if (coverage.unavailable || options.nativeCoverageUnknown) return [];
  if (changed) options.onCursorLocalUsageChanged?.();
  return next.rows.filter(row => row.eventTime >= since && row.eventTime <= now && !coverage.days.has(dayKey(row.eventTime)));
}

module.exports = { localNativeCoverage, readCursorLocalUsage };
