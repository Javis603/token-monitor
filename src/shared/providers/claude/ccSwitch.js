'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { localDayKey } = require('../../history');
const { sharedDataDir } = require('../../config');

const DB_PATH = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const CLAUDE_APPS = "('claude', 'claude-desktop')";

function safeCount(value) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('invalid CC-Switch usage counter');
  return number;
}

function readCcSwitchClaudeRows(dbPath = DB_PATH) {
  if (!fs.existsSync(dbPath)) return [];
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!tables.has('usage_daily_rollups') || !tables.has('proxy_request_logs')) throw new Error('unsupported CC-Switch usage schema');
    const rollups = db.prepare(`
      SELECT date, model, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
        SUM(cache_read_tokens) AS cacheRead, SUM(cache_creation_tokens) AS cacheWrite,
        SUM(total_cost_usd) AS cost, SUM(success_count) AS requests
      FROM usage_daily_rollups WHERE app_type IN ${CLAUDE_APPS}
      GROUP BY date, model
    `).all();
    const logs = db.prepare(`
      SELECT date(created_at, 'unixepoch', 'localtime') AS date, model,
        SUM(input_tokens) AS input, SUM(output_tokens) AS output,
        SUM(cache_read_tokens) AS cacheRead, SUM(cache_creation_tokens) AS cacheWrite,
        SUM(total_cost_usd) AS cost, COUNT(*) AS requests
      FROM proxy_request_logs
      WHERE app_type IN ${CLAUDE_APPS} AND data_source = 'proxy'
        AND status_code BETWEEN 200 AND 299
      GROUP BY date(created_at, 'unixepoch', 'localtime'), model
    `).all();
    // CC-Switch inserts archived request totals and deletes their detail rows
    // in one SAVEPOINT. The tables therefore hold disjoint request sets even
    // when a later request falls on an already archived local day.
    return [...rollups, ...logs].map((row) => {
      const date = String(row.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid CC-Switch usage date');
      const input = safeCount(row.input);
      const output = safeCount(row.output);
      const cacheRead = safeCount(row.cacheRead);
      const cacheWrite = safeCount(row.cacheWrite);
      if (!Number.isSafeInteger(input + output + cacheRead + cacheWrite)) throw new Error('CC-Switch usage exceeds safe integer range');
      return {
        date,
        model: String(row.model || 'unknown').trim() || 'unknown',
        input, output, cacheRead, cacheWrite,
        cost: Number.isFinite(Number(row.cost)) ? Math.max(0, Number(row.cost)) : 0,
        requests: safeCount(row.requests)
      };
    });
  } finally {
    db.close();
  }
}

function loadCcSwitchClaudeRows(options = {}) {
  const cachePath = options.cachePath || path.join(sharedDataDir(), 'cc-switch-claude-usage.json');
  const dbPath = path.resolve(options.dbPath || DB_PATH);
  try {
    if (fs.existsSync(dbPath)) {
      const rows = readCcSwitchClaudeRows(dbPath);
      try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        const pending = `${cachePath}.tmp`;
        fs.writeFileSync(pending, JSON.stringify({ version: 2, dbPath, rows }));
        fs.renameSync(pending, cachePath);
      } catch (error) {
        options.logger?.(`CC-Switch usage snapshot write failed: ${error.message}`);
      }
      return rows;
    }
  } catch (error) {
    options.logger?.(`CC-Switch usage read failed: ${error.message}`);
  }
  try {
    const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (saved.version === 2 && saved.dbPath === dbPath && Array.isArray(saved.rows)) return saved.rows;
  } catch (_) {}
  return [];
}

function admittedCcSwitchClaudeRows(rows, localAllTime) {
  const localTokens = safeCount(localAllTime?.clients?.claude);
  const sessions = Object.values(localAllTime?.sessions || {}).filter((session) => session?.client === 'claude');
  const sessionTokens = sessions.reduce((sum, session) => sum + safeCount(session.totalTokens), 0);
  // A client total without complete dated sessions has no safe overlap boundary.
  if (localTokens !== sessionTokens) return [];
  const occupiedDays = new Set();
  for (const session of sessions) {
    if (!session.startedAt || !session.lastUsedAt) return [];
    const start = Date.parse(session.startedAt);
    const end = Date.parse(session.lastUsedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    const limit = new Date(end);
    limit.setHours(0, 0, 0, 0);
    while (cursor <= limit) {
      occupiedDays.add(localDayKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return rows.filter((row) => !occupiedDays.has(row.date));
}

function ccSwitchClaudeJson(rows) {
  return {
    entries: rows.map((row) => ({
      client: 'claude', model: row.model,
      input: row.input, output: row.output,
      cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
      messageCount: 0, cost: row.cost
    }))
  };
}

function ccSwitchClaudeGraph(rows) {
  const dates = new Map();
  for (const row of rows) {
    if (!dates.has(row.date)) dates.set(row.date, { date: row.date, clients: [] });
    dates.get(row.date).clients.push({
      client: 'claude', modelId: row.model,
      tokens: { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite },
      cost: row.cost, messages: 0
    });
  }
  return { contributions: [...dates.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

module.exports = { DB_PATH, readCcSwitchClaudeRows, loadCcSwitchClaudeRows, admittedCcSwitchClaudeRows, ccSwitchClaudeJson, ccSwitchClaudeGraph };
