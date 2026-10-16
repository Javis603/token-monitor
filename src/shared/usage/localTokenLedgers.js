'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveSqlite, openDb } = require('../sqliteReadOnly');
const { clientSourceRoots } = require('../clientSources');
const { localDayKey } = require('../history');

const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
const modelKey = (value) => String(value || 'unknown')
  .replace(/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}:/i, '').toLowerCase();

function addCount(map, key, delta) {
  Object.defineProperty(map, key, {
    value: (Object.hasOwn(map, key) ? count(map[key]) : 0) + delta,
    enumerable: true, configurable: true, writable: true
  });
}

function fingerprint(file) {
  return [file, `${file}-wal`].map((item) => {
    try { const stat = fs.statSync(item); return `${stat.size}:${stat.mtimeMs}`; }
    catch (error) { if (error.code === 'ENOENT') return '-'; throw error; }
  }).join('|');
}

function readRows(file, kind) {
  const sqlite = resolveSqlite({});
  if (!sqlite || !fs.existsSync(file)) return [];
  const db = openDb(file, sqlite);
  const rows = [];
  const add = (row, tokens, timestamp) => {
    const date = timestamp == null ? row.date : localDayKey(new Date(timestamp));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    rows.push({ date, client: row.client, model: row.model || 'unknown', tokens });
  };
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  try {
    // Detail and archived rollups must come from the same SQLite snapshot.
    db.exec('BEGIN');
    if (kind === 'cherrystudio') {
      const fields = columns('ai_usage_record');
      if (!fields.has('model_id') || !fields.has('created_at')) return [];
      const select = (name) => fields.has(name) ? `r.${name}` : 'NULL';
      const legacy = fields.has('record_kind') && fields.has('message_id') && fields.has('message_kind')
        ? `WHERE r.record_kind = 'invocation' OR (r.record_kind = 'legacy-aggregate' AND NOT EXISTS (
            SELECT 1 FROM ai_usage_record i WHERE i.record_kind = 'invocation'
              AND i.message_id IS r.message_id AND i.message_kind IS r.message_kind))`
        : fields.has('record_kind') ? "WHERE r.record_kind = 'invocation'" : '';
      const query = `SELECT r.model_id AS model, r.created_at,
        ${select('total_tokens')} AS total_tokens, ${select('input_tokens')} AS input_tokens,
        ${select('output_tokens')} AS output_tokens FROM ai_usage_record r ${legacy}`;
      for (const row of db.prepare(query).iterate()) {
        const at = Number(row.created_at);
        if (!Number.isFinite(at) || at <= 0) continue;
        // Both caches are subsets of input and reasoning is a subset of output.
        const tokens = row.total_tokens == null ? count(row.input_tokens) + count(row.output_tokens) : count(row.total_tokens);
        add({ ...row, client: 'cherrystudio' }, tokens, at);
      }
    } else {
      for (const [table, detail] of [['proxy_request_logs', true], ['usage_daily_rollups', false]]) {
        const fields = columns(table);
        if (!fields.has('app_type') || !fields.has('model') || !fields.has('input_tokens')
          || !fields.has(detail ? 'created_at' : 'date')) continue;
        const select = (name) => fields.has(name) ? name : '0';
        const query = `SELECT app_type AS client, model, input_tokens,
          ${select('output_tokens')} AS output_tokens, ${select('cache_read_tokens')} AS cache_read_tokens,
          ${select('cache_creation_tokens')} AS cache_creation_tokens,
          ${select('input_token_semantics')} AS input_token_semantics,
          ${detail ? 'created_at' : 'date'} FROM ${table} WHERE app_type IN ('claude', 'codex')`;
        for (const row of db.prepare(query).iterate()) {
          if (detail && (!Number.isFinite(Number(row.created_at)) || Number(row.created_at) <= 0)) continue;
          const input = count(row.input_tokens), read = count(row.cache_read_tokens), write = count(row.cache_creation_tokens);
          const semantics = Number(row.input_token_semantics);
          if (![0, 1, 2].includes(semantics)) continue;
          const inclusive = semantics === 1 || (semantics === 0 && row.client === 'codex');
          const fresh = inclusive ? Math.max(0, input - read - (semantics === 1 ? write : 0)) : input;
          add(row, fresh + read + write + count(row.output_tokens), detail ? Number(row.created_at) * 1000 : null);
        }
      }
    }
    db.exec('COMMIT');
    return rows;
  } finally { db.close(); }
}

function createLocalTokenLedgerReader(options = {}) {
  const cache = new Map();
  return (clients) => {
    const selected = new Set(String(clients || '').split(','));
    const files = [];
    if (selected.has('cherrystudio')) {
      const roots = clientSourceRoots('cherrystudio', options).cherrystudio || [];
      for (const root of roots) if (root.id === 'cherrystudio-db') files.push([root.sourcePath, 'cherrystudio']);
    }
    if (selected.has('claude') || selected.has('codex')) {
      files.push([path.join(options.homeDir || os.homedir(), '.cc-switch', 'cc-switch.db'), 'ccswitch']);
    }
    const rows = [];
    for (const [file, kind] of files) {
      try {
        const revision = fingerprint(file);
        if (cache.get(file)?.revision !== revision) cache.set(file, { revision, rows: readRows(file, kind) });
        rows.push(...cache.get(file).rows.filter((row) => selected.has(row.client)));
      } catch (error) {
        // A failed read never substitutes stale/partial rows for a fresh scan.
        cache.delete(file);
        options.onError?.(error, file);
      }
    }
    return rows;
  };
}

// These ledgers overlap transcripts and old rollups have no request IDs. They
// prove a lower bound per client/model/window, not an additive request stream.
// Apply after native retention, outside the collector's exact delta anchors.
function applyLocalTokenLedgers(summary, rows, options = {}) {
  if (!rows.length) return summary;
  const now = new Date(summary.updatedAt || Date.now());
  if (Number.isNaN(now.getTime())) return summary;
  const today = localDayKey(now);
  const periods = summary.periods || summary;
  const since = options.allTimeSince || '0000-01-01';
  for (const name of ['today', 'month', 'allTime']) {
    const period = periods[name];
    if (!period) continue; // Preserve progressive previews.
    const floors = new Map();
    for (const row of rows) {
      if (row.date > today || (name === 'allTime' && row.date < since)
        || (name === 'today' && row.date !== today)
        || (name === 'month' && row.date.slice(0, 7) !== today.slice(0, 7))) continue;
      const key = JSON.stringify([row.client, modelKey(row.model)]);
      const bucket = floors.get(key) || { client: row.client, model: row.model, tokens: 0 };
      bucket.tokens += row.tokens;
      floors.set(key, bucket);
    }
    for (const { client, model, tokens } of floors.values()) {
      const matching = Object.entries(period.clientModels?.[client] || {}).filter(([label]) => modelKey(label) === modelKey(model));
      const attributed = Object.values(period.clientModels?.[client] || {}).reduce((sum, value) => sum + count(value), 0);
      if (attributed < count(period.clients?.[client])) continue;
      const observed = matching.reduce((sum, [, value]) => sum + count(value), 0);
      const delta = Math.max(0, tokens - observed);
      if (!delta) continue;
      const label = matching.find(([label]) => label.toLowerCase() === String(model).toLowerCase())?.[0] || model;
      period.totalTokens += delta;
      addCount(period.clients, client, delta);
      addCount(period.models, label, delta);
      period.clientModels[client] ||= {};
      addCount(period.clientModels[client], label, delta);
      // The overlap is unknown. Do not guess a cache/output split or invent
      // per-session attribution, timing, request counts, or prices for it.
      period.unclassifiedTokens += delta;
      addCount(period.clientUnclassifiedTokens, client, delta);
      addCount(period.modelUnclassifiedTokens, label, delta);
      period.capabilities.tokenComponents = false;
    }
  }
  return summary;
}

module.exports = { createLocalTokenLedgerReader, applyLocalTokenLedgers };
