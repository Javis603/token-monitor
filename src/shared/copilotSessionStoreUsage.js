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
// id): same vendor icon/labels/pricing surfaces, no renderer churn. Costs are
// estimated locally through the shared models.dev catalog lookup plus the
// user's custom-pricing overrides, mirroring how every other parse-local
// adapter prices its rows.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const { customPricingPath } = require('./tokscaleConfig');

const COPILOT_SESSION_STORE_READ_MAX_BYTES = 50 * 1024 * 1024;
const COPILOT_SESSION_STORE_READ_MAX_ROWS = 100_000;

const COPILOT_SESSION_STORE_PRICING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const COPILOT_SESSION_STORE_PRICING_LOOKUP_TIMEOUT_MS = 3000;

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

// A WAL-mode database cannot always be opened read-only in place: when the
// -shm file is absent and no other connection is live (IDE fully closed after
// a checkpoint), SQLite refuses the open. Snapshotting the db + -wal + -shm
// trio into a private directory sidesteps that — the copied connection owns
// its shm and replays the WAL itself. The copy may be a few frames stale
// relative to a live writer, which is fine for usage monitoring.
function snapshotDatabaseTrio(dbPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-copilot-store-'));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const source = dbPath + suffix;
      const target = path.join(dir, 'store.db' + suffix);
      try {
        fs.copyFileSync(source, target);
      } catch (_) {
        // A missing -wal/-shm is normal (checkpointed database); only the main
        // file is required.
      }
    }
    return { dbPath: path.join(dir, 'store.db'), dir };
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }
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
      // Last resort: snapshot the db + -wal + -shm trio into a private temp
      // directory and read the copy, so a checkpointed/closed IDE (no -shm,
      // no live connection) still reports its usage instead of erroring.
      let snapshotDir = null;
      try {
        const snapshot = snapshotDatabaseTrio(dbPath);
        snapshotDir = snapshot.dir;
        const snapshotRequire = options.requireFn || require;
        const { DatabaseSync: SnapshotDatabaseSync } = snapshotRequire('node:sqlite');
        const database = new SnapshotDatabaseSync(snapshot.dbPath, { readOnly: true });
        try {
          database.exec('PRAGMA busy_timeout = 250');
          const statement = database.prepare(sinceMs ? COPILOT_SESSION_STORE_USAGE_SINCE_SQL : COPILOT_SESSION_STORE_USAGE_SQL);
          const iterator = sinceMs ? statement.iterate(sinceMs) : statement.iterate();
          return boundedRows(iterator, { maxReadRows });
        } finally {
          database.close();
        }
      } catch (snapshotError) {
        if (isReadBudgetError(snapshotError)) throw snapshotError;
        // Fail loudly so the collector keeps its previous snapshot and logs
        // the cause instead of silently reporting zero JetBrains usage.
        const message = `copilot session-store sqlite read failed: sqlite3 CLI: ${cliError.message}; node:sqlite: ${nodeError.message}; snapshot copy: ${snapshotError.message}`;
        if (typeof options.logger === 'function') options.logger(message);
        throw new Error(message, { cause: snapshotError });
      } finally {
        if (snapshotDir) {
          try { fs.rmSync(snapshotDir, { recursive: true, force: true }); } catch (_) {}
        }
      }
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

  // Several db paths can resolve to one file; the id key keeps every source
  // deduped when that happens.
  const unique = new Map();
  for (const row of rows) unique.set(row.messageId, row);
  return [...unique.values()];
}

// Positive capabilities stay cached. The custom-pricing file's mtime rides
// along in the cache key so an edit invalidates immediately, matching the
// cadence of every other local-adapter pricing lane.
const COPILOT_SESSION_STORE_PRICING_REVISION_FALLBACK = 0;
const copilotSessionStorePricingCache = new Map();

function copilotSessionStorePricingRevision() {
  try { return fs.statSync(customPricingPath()).mtimeMs; } catch (_) {
    return COPILOT_SESSION_STORE_PRICING_REVISION_FALLBACK;
  }
}

function normalizeCopilotSessionStorePricing(result) {
  const source = result?.pricing;
  if (!source || typeof source !== 'object') return null;
  const pick = (key) => {
    const value = Number(source[key]);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const pricing = {
    inputCostPerToken: pick('inputCostPerToken'),
    outputCostPerToken: pick('outputCostPerToken'),
    cacheReadInputTokenCost: pick('cacheReadInputTokenCost'),
    cacheCreationInputTokenCost: pick('cacheCreationInputTokenCost')
  };
  return pricing.inputCostPerToken !== undefined || pricing.outputCostPerToken !== undefined ? pricing : null;
}

async function resolveCopilotSessionStorePricing(rows, options = {}) {
  const lookup = options.lookupModelPricing;
  const pricingByModel = {};
  if (typeof lookup !== 'function') return pricingByModel;
  const revision = options.pricingRevision ?? copilotSessionStorePricingRevision();
  const nowMs = options.nowMs ?? Date.now();
  const commandTimeoutMs = options.commandTimeoutMs || COPILOT_SESSION_STORE_PRICING_LOOKUP_TIMEOUT_MS;
  const modelIds = [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.model || '').trim().toLowerCase())
    .filter(Boolean))];
  for (const modelId of modelIds) {
    const cached = copilotSessionStorePricingCache.get(modelId);
    if (cached && cached.revision === revision && nowMs - cached.at < COPILOT_SESSION_STORE_PRICING_CACHE_TTL_MS) {
      if (cached.pricing) pricingByModel[modelId] = cached.pricing;
      continue;
    }
    let pricing = null;
    try {
      pricing = normalizeCopilotSessionStorePricing(await lookup(modelId, commandTimeoutMs));
    } catch (_) {
      // An unknown model, offline lookup, or custom channel must remain
      // cost-unavailable instead of inheriting an unrelated catalog price.
    }
    copilotSessionStorePricingCache.set(modelId, { at: nowMs, revision, pricing });
    if (pricing) pricingByModel[modelId] = pricing;
  }
  return pricingByModel;
}

function resetCopilotSessionStorePricingCache() {
  copilotSessionStorePricingCache.clear();
}

function estimateCopilotSessionStoreRowCost(row, pricingByModel) {
  const pricing = pricingByModel?.[String(row?.model || '').trim().toLowerCase()];
  if (!pricing || typeof pricing !== 'object') return null;
  const components = [
    [row?.input, pricing.inputCostPerToken],
    [row?.output, pricing.outputCostPerToken],
    [row?.cacheRead, pricing.cacheReadInputTokenCost],
    [row?.cacheWrite, pricing.cacheCreationInputTokenCost]
  ];
  let cost = 0;
  for (const [tokens, unitCost] of components) {
    if (!tokens) continue;
    if (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) return null;
    cost += tokens * Number(unitCost);
  }
  return cost;
}

function buildTokscaleJson(startMs, rows, pricingByModel, includeUndated = false) {
  const grouped = new Map();
  for (const row of rows) {
    // Dated rows must fall inside the window, undated rows count only for
    // allTime (includeUndated) — never for today/month, so a row without a
    // parseable timestamp cannot pollute the rolling windows.
    if (startMs && (row.createdAt ? row.createdAt < startMs : !includeUndated)) continue;
    const key = `${row.sessionId}\0${row.model}`;
    if (!grouped.has(key)) grouped.set(key, { ...row, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, startedAt: 0, lastUsedAt: 0, cost: 0 });
    const group = grouped.get(key);
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.messages += row.messages;
    const cost = estimateCopilotSessionStoreRowCost(row, pricingByModel);
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
    const cost = estimateCopilotSessionStoreRowCost(row, options.pricingByModel);
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
  resolveCopilotSessionStorePricing,
  resetCopilotSessionStorePricingCache,
  buildCopilotSessionStorePeriods,
  buildCopilotSessionStoreHistoryGraph
};
