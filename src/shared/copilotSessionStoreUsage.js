'use strict';

// JetBrains-family Copilot plugins (IntelliJ / Android Studio / GoLand / ...)
// record one assistant_usage_events row per model request inside
// ~/.copilot/session-store.db (SQLite, WAL mode). tokscale only reads the VS
// Code Copilot surfaces (~/.copilot/otel, ~/.copilot/data.db and the VS Code
// workspaceStorage chat sessions), so without this adapter every
// JetBrains-side request is invisible and the copilot client undercounts.
//
// The table is append-only with a monotonic id, which keeps the collector's
// period-delta anchoring exact: an anchored tick re-reads today's slice and a
// failed read can rebuild today exactly from the last full scan's cached rows.
//
// Rows are merged into the existing 'copilot' client (never a separate client
// id): same vendor icon/labels/pricing surfaces, no renderer churn. Cost
// estimation reuses the shared per-model pricing lookup behind the Qoder CN
// adapter because the pricing plumbing (models.dev catalog + custom pricing)
// is identical for every local SQLite adapter.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const { estimatedQoderCnRowCost, resolveQoderCnPricing, resetQoderCnPricingCache } = require('./qoderCnUsage');

const COPILOT_SESSION_STORE_READ_MAX_BYTES = 50 * 1024 * 1024;
const COPILOT_SESSION_STORE_READ_MAX_ROWS = 100_000;

const COPILOT_SESSION_STORE_USAGE_SQL = `
SELECT id, session_id, model, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at
FROM assistant_usage_events
ORDER BY id
`;

const COPILOT_SESSION_STORE_USAGE_SINCE_SQL = `
SELECT id, session_id, model, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at
FROM assistant_usage_events
WHERE CAST(strftime('%s', created_at) AS INTEGER) * 1000 >= ?
ORDER BY id
`;

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 && value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sourceId(value) {
  return createHash('sha256').update(path.normalize(String(value || ''))).digest('hex').slice(0, 12);
}

function copilotSessionStoreDataPaths(options = {}) {
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const explicitDb = String(env.TOKEN_MONITOR_COPILOT_SESSION_DB_PATH || '').trim();
  return {
    dbPaths: [explicitDb ? path.resolve(explicitDb) : path.join(home, '.copilot', 'session-store.db')]
  };
}

// input_tokens follows the OpenAI usage convention: it is the total prompt
// size including the cached portion, so cache hits are split back out here
// instead of being added on top. Cache fields are clamped into [0, prompt]
// so a misbehaving plugin build can never produce negative input.
function normalizeCopilotSessionStoreDbRow(row, source = 'local') {
  const inputTotal = numeric(row?.input_tokens);
  const output = numeric(row?.output_tokens);
  const cacheRead = numeric(row?.cache_read_tokens ?? 0) ?? 0;
  const cacheWrite = numeric(row?.cache_write_tokens ?? 0) ?? 0;
  if (inputTotal === null || output === null || inputTotal + output === 0) return null;

  const boundedCacheRead = Math.min(inputTotal, Math.max(0, cacheRead));
  const boundedCacheWrite = Math.min(Math.max(0, inputTotal - boundedCacheRead), Math.max(0, cacheWrite));
  const session = String(row?.session_id || 'unknown');
  const message = String(row?.id ?? '');
  return {
    sessionId: `copilot:${source}:${session}`,
    messageId: `copilot:${source}:${session}:${message}`,
    model: String(row?.model || '').trim() || 'copilot',
    projectLabel: '',
    input: Math.max(0, inputTotal - boundedCacheRead - boundedCacheWrite),
    output,
    cacheRead: boundedCacheRead,
    cacheWrite: boundedCacheWrite,
    reasoning: numeric(row?.reasoning_tokens ?? 0) ?? 0,
    createdAt: timestampMs(row?.created_at),
    messages: 1
  };
}

function readBudgetError(limit, cause) {
  const error = new Error(
    `copilot session-store sqlite read budget exceeded (limit ${limit})`,
    cause ? { cause } : undefined
  );
  error.code = 'COPILOT_SESSION_STORE_READ_BUDGET_EXCEEDED';
  return error;
}

function isReadBudgetError(error) {
  return error?.code === 'COPILOT_SESSION_STORE_READ_BUDGET_EXCEEDED'
    || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

function boundedRows(iterable, { maxReadRows }) {
  const rows = [];
  for (const row of iterable) {
    if (rows.length >= maxReadRows) throw readBudgetError(maxReadRows);
    rows.push(row);
  }
  return rows;
}

async function readCopilotSessionStoreRows(dbPath, options = {}) {
  const run = options.execFile || execFileAsync;
  const sinceMs = options.sinceMs;
  const maxReadBytes = COPILOT_SESSION_STORE_READ_MAX_BYTES;
  const maxReadRows = options.maxReadRows || COPILOT_SESSION_STORE_READ_MAX_ROWS;
  const sql = sinceMs
    ? COPILOT_SESSION_STORE_USAGE_SINCE_SQL.replace('?', String(sinceMs))
    : COPILOT_SESSION_STORE_USAGE_SQL;
  try {
    const result = await run('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, sql], {
      encoding: 'utf8', maxBuffer: maxReadBytes, timeout: 30_000, windowsHide: true
    });
    const stdout = String(result?.stdout || '').trim();
    const parsed = JSON.parse(stdout || '[]');
    return boundedRows(Array.isArray(parsed) ? parsed : [], { maxReadRows });
  } catch (cliError) {
    if (isReadBudgetError(cliError)) throw cliError;
    try {
      const requireFn = options.requireFn || require;
      const { DatabaseSync } = requireFn('node:sqlite');
      const database = new DatabaseSync(dbPath, { readOnly: true });
      try {
        database.exec('PRAGMA busy_timeout = 250');
        const statement = database.prepare(sinceMs ? COPILOT_SESSION_STORE_USAGE_SINCE_SQL : COPILOT_SESSION_STORE_USAGE_SQL);
        const iterator = sinceMs ? statement.iterate(sinceMs) : statement.iterate();
        return boundedRows(iterator, { maxReadRows });
      } finally {
        database.close();
      }
    } catch (nodeError) {
      if (isReadBudgetError(nodeError)) throw nodeError;
      // Fail loudly so the collector keeps its previous snapshot and logs the
      // cause instead of silently reporting zero JetBrains usage.
      const message = `copilot session-store sqlite read failed: sqlite3 CLI: ${cliError.message}; node:sqlite: ${nodeError.message}`;
      if (typeof options.logger === 'function') options.logger(message);
      throw new Error(message, { cause: nodeError });
    }
  }
}

async function collectCopilotSessionStoreRows(options = {}) {
  const paths = copilotSessionStoreDataPaths(options);
  const dbPaths = Array.isArray(options.dbPaths) ? options.dbPaths : paths.dbPaths;
  const readDbRows = options.readDbRows || readCopilotSessionStoreRows;
  const sinceMs = options.sinceMs;
  const rows = [];

  for (const dbPath of dbPaths) {
    if (!options.readDbRows && !fs.existsSync(dbPath)) continue;
    const source = sourceId(dbPath);
    const dbRows = await readDbRows(dbPath, { ...options, sinceMs });
    for (const dbRow of dbRows) {
      const row = normalizeCopilotSessionStoreDbRow(dbRow, source);
      if (row) rows.push(row);
    }
  }

  // The table can also back non-JetBrains surfaces sharing ~/.copilot; the id
  // key keeps every source deduped when several db paths resolve to one file.
  const unique = new Map();
  for (const row of rows) unique.set(row.messageId, row);
  return [...unique.values()];
}

function estimateRowCost(row, pricingByModel) {
  return estimatedQoderCnRowCost({ model: row.model, input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite }, pricingByModel);
}

function buildTokscaleJson(startMs, rows, pricingByModel, includeUndated = false) {
  const grouped = new Map();
  for (const row of rows) {
    // Dated rows must fall inside the window, undated rows count only for
    // allTime (includeUndated) — never for today/month, mirroring proma/qodercn.
    if (startMs && (row.createdAt ? row.createdAt < startMs : !includeUndated)) continue;
    const key = `${row.sessionId}\0${row.model}`;
    if (!grouped.has(key)) grouped.set(key, { ...row, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, startedAt: 0, lastUsedAt: 0, cost: 0 });
    const group = grouped.get(key);
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.messages += row.messages;
    const cost = estimateRowCost(row, pricingByModel);
    group.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
  }

  const entries = [...grouped.values()].map((row) => ({
    client: 'copilot', mergedClients: null, sessionId: row.sessionId, model: row.model, provider: 'copilot',
    input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
    reasoning: row.reasoning, messageCount: row.messages, cost: row.cost,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : '',
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : '',
    projectLabel: '', performance: null
  }));
  const sum = (key) => entries.reduce((total, row) => total + row[key], 0);
  return {
    groupBy: 'client,session,model', entries,
    totalInput: sum('input'), totalOutput: sum('output'), totalCacheRead: sum('cacheRead'),
    totalCacheWrite: sum('cacheWrite'), totalMessages: sum('messageCount'), totalCost: sum('cost'), processingTimeMs: 0
  };
}

function buildCopilotSessionStorePeriods(options = {}) {
  const now = options.now || new Date();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const pricingByModel = options.pricingByModel || {};
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return {
    today: buildTokscaleJson(todayStart, rows, pricingByModel),
    month: buildTokscaleJson(monthStart, rows, pricingByModel),
    allTime: buildTokscaleJson(timestampMs(options.allTimeSince), rows, pricingByModel, true)
  };
}

function localDateKey(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildCopilotSessionStoreHistoryGraph(options = {}) {
  const days = new Map();
  for (const row of options.rows || []) {
    const date = localDateKey(row.createdAt);
    if (!date) continue;
    if (!days.has(date)) days.set(date, { date, clients: [] });
    const day = days.get(date);
    let model = day.clients.find((entry) => entry.modelId === row.model);
    if (!model) {
      model = { client: 'copilot', modelId: row.model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 0 };
      day.clients.push(model);
    }
    const cost = estimateRowCost(row, options.pricingByModel);
    model.tokens.input += row.input;
    model.tokens.output += row.output;
    model.tokens.cacheRead += row.cacheRead;
    model.tokens.cacheWrite += row.cacheWrite;
    model.tokens.reasoning += row.reasoning;
    model.cost += cost === null ? 0 : cost;
    model.messages += row.messages;
  }
  return { contributions: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

module.exports = {
  copilotSessionStoreDataPaths,
  normalizeCopilotSessionStoreDbRow,
  readCopilotSessionStoreRows,
  collectCopilotSessionStoreRows,
  resolveCopilotSessionStorePricing: resolveQoderCnPricing,
  resetCopilotSessionStorePricingCache: resetQoderCnPricingCache,
  buildCopilotSessionStorePeriods,
  buildCopilotSessionStoreHistoryGraph
};
