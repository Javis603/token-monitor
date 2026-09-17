'use strict';

/**
 * Mavis (MiniMax Code) token usage adapter.
 *
 * Reads token usage from the local SQLite database that the mavis runtime
 * (MiniMax Code's agent layer) writes to. The DB lives at
 * ~/.minimax/v2/sqlite/runtime-state.sqlite and the relevant table is
 * `local_runtime_token_usage`, indexed on `ts` and `(ts, id)`.
 *
 * Design follows `providers/qodercn/usage.js`:
 *   1. Try the system `sqlite3` CLI first via `execFile` — emits JSON, so
 *      we just JSON.parse the stdout. The CLI ships on most macOS / Linux
 *      systems out of the box and is unaffected by Electron's V8/Node
 *      version, so this is the path with the fewest moving parts.
 *   2. Fall back to Node 22.5+'s built-in `node:sqlite` (stable since
 *      22.13, no flag needed on 22.15+) when the CLI is missing or fails.
 *   3. If both fail, fail loudly — never silently return empty usage
 *      (the collector then keeps its last good snapshot and surfaces the
 *      error in the diagnostics panel).
 *
 * The mavis runtime aggregates six agent names (mavis / coder / explore /
 * general / verifier / worker) into the same table under
 * `framework_type='pi-agent'`, so we read across the umbrella. They all
 * surface as the same `mavis` client id at the UI level.
 *
 * `cost_usd` is written by the runtime when it has a model id, so we use
 * it directly and skip any external pricing lookup — the same shortcut
 * the rest of the catalog takes for client-reported costs.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const MAVIS_HOME = path.join(os.homedir(), '.minimax', 'v2', 'sqlite');
const MAVIS_DB_PATH = path.join(MAVIS_HOME, 'runtime-state.sqlite');
const MAVIS_TABLE = 'local_runtime_token_usage';

const MAVIS_CLIENT_ID = 'mavis';
const MAVIS_PROVIDER_ID = 'mavis';

const MAVIS_AGENT_NAMES = Object.freeze([
  'mavis', 'coder', 'explore', 'general', 'verifier', 'worker'
]);

// Same read budget as qodercn. mavis sessions are smaller (a few hundred
// rows per day) so these are well above the realistic load.
const MAVIS_READ_MAX_BYTES = 50 * 1024 * 1024;
const MAVIS_READ_MAX_ROWS = 100_000;
const MAVIS_READ_TIMEOUT_MS = 30_000;
const MAVIS_READ_BUDGET_ERROR = 'MAVIS_READ_BUDGET_EXCEEDED';

// Pull everything we might need in one query. The `sinceMs` filter is
// applied in SQL so the JSON payload stays small; the `framework_type`
// predicate is currently a no-op (always 'pi-agent') but kept so that
// any future rows from a non-mavis framework are excluded cheaply.
// `reasoning_tokens` and `cache_write_tokens` are always 0 in the pi-agent
// runtime (verified: 0 rows out of ~4k). Drop them from the projection so
// the worker postMessage payload stays smaller and the row construction
// in the worker doesn't have to coerce always-zero values. The host still
// defaults them to 0 in normalizeDbRow when older worker payloads land
// (handy if a future runtime ever does populate them).
const MAVIS_USAGE_SQL = `
SELECT ts, session_id, agent_name, model,
  input_tokens, output_tokens,
  cache_read_tokens, cost_usd
FROM ${MAVIS_TABLE}
WHERE framework_type = 'pi-agent'
  AND agent_name IN (PLACEHOLDER_AGENTS)
ORDER BY ts
`.trim();

const MAVIS_USAGE_SINCE_SQL = `
SELECT ts, session_id, agent_name, model,
  input_tokens, output_tokens,
  cache_read_tokens, cost_usd
FROM ${MAVIS_TABLE}
WHERE framework_type = 'pi-agent'
  AND agent_name IN (PLACEHOLDER_AGENTS)
  AND ts >= ?
ORDER BY ts
`.trim();

/**
 * Coerce a value to a finite number; non-finite or missing defaults to 0.
 * Used to defend every numeric column from the SQLite payload.
 *
 * @param {unknown} value Raw value from a row column.
 * @returns {number} Finite number, or 0 when the value is null/NaN.
 */
function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build a tagged read-budget error so the upstream collector can distinguish
 * "we hit a size cap" from a generic SQLite failure (different UX in the
 * diagnostics panel).
 *
 * @param {string} kind Budget category — 'rows' or 'bytes'.
 * @param {number} limit Cap that was exceeded.
 * @param {unknown} [cause] Original error if any.
 * @returns {Error} Tagged error with `code = MAVIS_READ_BUDGET_ERROR`.
 */
function readBudgetError(kind, limit, cause) {
  const error = new Error(`mavis read budget exceeded: ${kind} > ${limit}`);
  error.code = MAVIS_READ_BUDGET_ERROR;
  if (cause) error.cause = cause;
  return error;
}

/**
 * Test whether an error originated from the read-budget guard.
 *
 * @param {unknown} err Catched error.
 * @returns {boolean} True if the error was tagged by `readBudgetError`.
 */
function isReadBudgetError(err) {
  return err && err.code === MAVIS_READ_BUDGET_ERROR;
}

/**
 * Materialise a row iterator/array while capping the result at
 * `options.maxReadRows` (or the default). Throws a tagged error when the cap
 * is reached so the upstream collector can surface it instead of streaming
 * unbounded memory.
 *
 * @param {Iterable<object>} rows Source rows from the SQLite reader.
 * @param {{maxReadRows?: number}} [options]
 * @returns {object[]} Capped row list, length ≤ maxRows.
 */
function boundedRows(rows, options = {}) {
  const maxRows = options.maxReadRows || MAVIS_READ_MAX_ROWS;
  const out = [];
  for (const row of rows) {
    if (out.length >= maxRows) {
      throw readBudgetError('rows', maxRows);
    }
    out.push(row);
  }
  return out;
}

/**
 * Locate the mavis SQLite database, preferring an explicit `options.dbPath`,
 * then the `MAVIS_RUNTIME_DB` env var (verified to exist on disk), then the
 * default install path. Returns `null` when none of the candidates exist
 * so the caller can skip the tick cleanly.
 *
 * @param {{dbPath?: string}} [options]
 * @returns {string|null} Absolute path to the SQLite file, or `null`.
 */
function resolveMavisDbPath(options = {}) {
  if (options.dbPath) return options.dbPath;
  const fromEnv = process.env.MAVIS_RUNTIME_DB;
  if (fromEnv && String(fromEnv).trim() && fs.existsSync(fromEnv)) return fromEnv;
  if (fs.existsSync(MAVIS_DB_PATH)) return MAVIS_DB_PATH;
  return null;
}

/**
 * Swap the `PLACEHOLDER_AGENTS` token in a SQL template for a parameterized
 * `?,?,...` list sized to the agent names being queried. Centralised so
 * the SQL stays single-sourced.
 *
 * @param {string} sql SQL with `PLACEHOLDER_AGENTS` marker.
 * @param {string[]} agentNames Agent names to bind.
 * @returns {string} SQL with `?` placeholders.
 */
function agentPlaceholders(sql, agentNames) {
  return sql.replace(
    'PLACEHOLDER_AGENTS',
    agentNames.map(() => '?').join(',')
  );
}

/**
 * Read raw rows from the mavis SQLite database for a given agent set and
 * optional `sinceMs` lower bound. Tries the system `sqlite3` CLI first and
 * falls back to `node:sqlite` in a worker_threads isolate when the CLI is
 * missing or fails.
 *
 * Adapter-only helper: callers (collectMavisRows) decide which window to
 * pass; this function just runs the query and returns normalised rows.
 * `options.execFile` is injected by tests so they don't actually shell out
 * to the `sqlite3` CLI during unit runs.
 *
 * @param {string} dbPath Absolute path to the SQLite file.
 * @param {{
 *   sinceMs?: number,
 *   agentNames?: string[],
 *   maxReadBytes?: number,
 *   maxReadRows?: number,
 *   execFile?: (cmd: string, args: string[], opts: object) => Promise<{stdout: string}>,
 *   requireFn?: NodeRequire,
 *   nodeReadTimeoutMs?: number,
 *   logger?: (msg: string) => void
 * }} [options]
 * @returns {Promise<object[]>} Raw rows from the SQLite reader (capped at maxReadRows).
 */
async function readMavisDbRows(dbPath, options = {}) {
  const run = options.execFile || execFileAsync;
  const sinceMs = Math.max(0, Number(options.sinceMs || 0));
  const agentNames = Array.isArray(options.agentNames) && options.agentNames.length > 0
    ? options.agentNames
    : MAVIS_AGENT_NAMES;
  const maxReadBytes = options.maxReadBytes || MAVIS_READ_MAX_BYTES;
  const maxReadRows = options.maxReadRows || MAVIS_READ_MAX_ROWS;
  const logger = typeof options.logger === 'function' ? options.logger : null;

  const baseSql = sinceMs > 0 ? MAVIS_USAGE_SINCE_SQL : MAVIS_USAGE_SQL;
  const sql = agentPlaceholders(baseSql, agentNames);

  const cliArgs = [
    '-readonly',
    '-json',
    '-cmd', '.timeout 3000',
    dbPath,
    sql
  ];
  if (sinceMs > 0) cliArgs.push(String(sinceMs));

  let cliError;
  try {
    const result = await run('sqlite3', cliArgs, {
      encoding: 'utf8',
      maxBuffer: maxReadBytes,
      timeout: MAVIS_READ_TIMEOUT_MS,
      windowsHide: true
    });
    const stdout = String(result?.stdout || '').trim();
    if (Buffer.byteLength(stdout, 'utf8') > maxReadBytes) {
      throw readBudgetError('bytes', maxReadBytes);
    }
    const parsed = stdout ? JSON.parse(stdout) : [];
    return boundedRows(Array.isArray(parsed) ? parsed : [], { maxReadRows });
  } catch (caught) {
    cliError = caught;
  }
  if (isReadBudgetError(cliError)) {
    if (logger) logger(cliError.message);
    throw cliError;
  }

  // Fallback: built-in node:sqlite (Node 22.5+, stable since 22.13, no flag
  // needed on 22.15+). Injected via requireFn so tests can stub it.
  //
  // Wrapped in a `Promise.race` with a hard 5s timeout. In some Electron
  // builds the `node:sqlite` `DatabaseSync` constructor can block on
  // shared lock acquisition against a busy runtime, and the iter's
  // `iterate()` doesn't return until the writer's transaction is
  // checkpointed. Bounding the wait with a hard timeout means a slow
  // read surfaces as an error that the collect layer logs and keeps
  // the last-good anchor for, instead of wedging the entire collect
  // cycle and blocking every subsequent tick.
  const requireFn = options.requireFn || require;
  const nodeReadTimeoutMs = options.nodeReadTimeoutMs || 5_000;
  let nodeError;
  try {
    const result = await Promise.race([
      readMavisDbRowsNode(dbPath, sql, agentNames, sinceMs, maxReadRows, requireFn),
      new Promise((_, reject) => setTimeout(
        () => reject(Object.assign(new Error('node:sqlite read exceeded ' + nodeReadTimeoutMs + 'ms'), { code: 'MAVIS_READ_TIMEOUT' })),
        nodeReadTimeoutMs
      ))
    ]);
    return result;
  } catch (caught) {
    nodeError = caught;
    if (caught && caught.code === 'MAVIS_READ_TIMEOUT' && logger) {
      logger('mavis: ' + caught.message);
    }
  }
  if (isReadBudgetError(nodeError)) {
    if (logger) logger(nodeError.message);
    throw nodeError;
  }

  const message = `mavis sqlite read failed: sqlite3 CLI: ${cliError?.message || 'unknown'}; node:sqlite: ${nodeError?.message || 'unknown'}`;
  if (logger) logger(message);
  throw new Error(message, { cause: nodeError || cliError });
}

// Path to the worker script that owns the `node:sqlite` read path.
// We resolve it relative to this file so the same code works whether
// token-monitor is running from a normal Node module layout or from
// inside an asar archive (Electron rewrites __dirname to the asar path
// at runtime, which is what we want).
const MAVIS_READER_WORKER_FILENAME = 'mavis-reader.worker.js';

/**
 * Spawn a fresh worker_threads worker that runs `mavis-reader.worker.js`,
 * forward the SQL + bind args, and resolve with the row payload (or reject
 * with the worker's reported error). Each call gets a brand new worker
 * because a wedged worker can never recover; terminating it is the only
 * safe cleanup, and a new worker per query is cheap (~25 ms cold start)
 * compared to the 5-minute collect interval.
 *
 * `options.requireFn` is exposed for tests so they can stub out
 * `node:worker_threads`; production callers always use the real
 * constructor.
 *
 * @param {string} dbPath Absolute path to the SQLite file.
 * @param {string} sql SQL with parameter placeholders.
 * @param {string[]} agentNames Agent names to bind.
 * @param {number} sinceMs Lower-bound timestamp (ms epoch) or 0.
 * @param {number} maxReadRows Maximum rows to read before bailing.
 * @param {{requireFn?: NodeRequire}} [options]
 * @returns {Promise<object[]>} Row payload from the worker.
 */
function runMavisReaderWorker(dbPath, sql, agentNames, sinceMs, maxReadRows, options) {
  const requireFn = (options && options.requireFn) || require;
  const workerThreads = requireFn('node:worker_threads');
  const path = requireFn('node:path');
  const workerPath = path.join(__dirname, MAVIS_READER_WORKER_FILENAME);
  const bindArgs = sinceMs > 0 ? [...agentNames, sinceMs] : [...agentNames];

  return new Promise((resolve, reject) => {
    let settled = false;
    let worker;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (worker) {
        // Best-effort terminate; we don't await because the host has
        // already decided what to do with the result. Terminating
        // releases the SQLite handle inside the worker even when the
        // read itself was hung on a busy writer.
        try { worker.terminate(); } catch (_) { /* ignore */ }
      }
      fn(value);
    };

    try {
      worker = new workerThreads.Worker(workerPath, {
        workerData: {
          dbPath,
          sql,
          bindArgs,
          maxReadRows,
          busyTimeoutMs: 250,
        },
      });
    } catch (e) {
      finish(reject, e);
      return;
    }

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'done') {
        finish(resolve, msg.rows || []);
      } else if (msg.type === 'error') {
        finish(reject, new Error(msg.error || 'mavis worker reported an error'));
      }
    });

    worker.on('error', (err) => {
      finish(reject, err instanceof Error ? err : new Error(String(err)));
    });

    worker.on('exit', (code) => {
      // `done` / `error` already settled the promise; only act if we
      // somehow exited without a message (e.g. the worker crashed
      // during module load).
      if (settled) return;
      if (code !== 0) {
        finish(reject, new Error(`mavis reader worker exited with code ${code}`));
      } else {
        finish(reject, new Error('mavis reader worker exited without producing a result'));
      }
    });
  });
}

/**
 * `node:sqlite` read path on the worker_threads isolate. Delegates to
 * `runMavisReaderWorker` (overridable via `execWorker` for tests) and
 * applies the row-budget cap.
 *
 * @param {string} dbPath Absolute path to the SQLite file.
 * @param {string} sql SQL with parameter placeholders.
 * @param {string[]} agentNames Agent names to bind.
 * @param {number} sinceMs Lower-bound timestamp (ms epoch) or 0.
 * @param {number} maxReadRows Maximum rows to read before bailing.
 * @param {NodeRequire} requireFn `require()` (injected for tests).
 * @returns {Promise<object[]>} Row payload, capped at maxReadRows.
 */
async function readMavisDbRowsNode(dbPath, sql, agentNames, sinceMs, maxReadRows, requireFn) {
  // Delegate to a worker_threads worker instead of calling node:sqlite
  // on the main isolate. The previous "Promise.race + 5s timeout" guard
  // didn't actually help when `DatabaseSync` and `stmt.iterate()` are
  // synchronous native calls that lock V8 — the timer never gets to
  // fire. Spawning a worker moves the lock off our isolate entirely.
  // Test code injects `execWorker` to avoid the real worker spawn.
  const execWorker = (requireFn && requireFn.__execWorker) || runMavisReaderWorker;
  const rows = await execWorker(dbPath, sql, agentNames, sinceMs, maxReadRows, { requireFn });
  return boundedRows(rows, { maxReadRows });
}

/**
 * Format a mavis model id, falling back to `<agent> (model unknown)` when
 * the runtime left the column NULL (≈90% of rows in current builds).
 * Non-NULL rows pass through trimmed.
 *
 * @param {unknown} value Raw `model` column.
 * @param {unknown} agentName Raw `agent_name` column for fallback.
 * @returns {string} Trimmed model id, or a synthesised placeholder.
 */
function normalizedModelId(value, agentName) {
  // mavis runtime currently leaves model NULL on ~90% of rows; fall back
  // to `${agent} (model unknown)` so the breakdown still shows per-agent
  // splitting. Non-NULL rows pass through as-is.
  const trimmed = String(value || '').trim();
  if (trimmed) return trimmed;
  const agent = String(agentName || '').trim();
  return agent ? `${agent} (model unknown)` : 'unknown';
}

/**
 * Format a millisecond timestamp as a local-zone `YYYY-MM-DD` key. Returns
 * `''` for unparsable input.
 *
 * @param {number|string|Date} timestamp
 * @returns {string} `YYYY-MM-DD` in local time, or `''` if invalid.
 */
function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Convert a raw SQLite row into the normalised shape consumed by the rest
 * of the collector. Discards rows missing `session_id`.
 *
 * @param {object|null|undefined} raw Row from the SQLite reader.
 * @returns {{
 *   sessionId: string,
 *   agentName: string,
 *   model: string,
 *   createdAt: number,
 *   input: number,
 *   output: number,
 *   reasoning: number,
 *   cacheRead: number,
 *   cacheWrite: number,
 *   cost: number
 * }|null} Normalised row, or `null` when missing the session id.
 */
function normalizeDbRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = String(raw.session_id || '').trim();
  if (!sessionId) return null;
  return {
    sessionId,
    agentName: String(raw.agent_name || '').trim(),
    model: normalizedModelId(raw.model, raw.agent_name),
    createdAt: numberValue(raw.ts),
    input: numberValue(raw.input_tokens),
    output: numberValue(raw.output_tokens),
    reasoning: numberValue(raw.reasoning_tokens),
    cacheRead: numberValue(raw.cache_read_tokens),
    cacheWrite: numberValue(raw.cache_write_tokens),
    cost: raw.cost_usd == null ? 0 : Number(raw.cost_usd) || 0
  };
}

// Mavis runtime currently writes `cost_usd = 0` for any row where the model
// column is NULL (it only fills `cost_usd` when it has a model id to look
// the rate up against). Token-monitor can recover the cost client-side so
// the cost panels don't read all-zeros: the runtime-supplied `cost_usd` is
// always preferred, and only zero rows get the fallback below.
//
// Prices follow the mavis public listing (CNY per 1M tokens, standard
// tier "永久五折" / permanent 50% off); we convert to USD with
// `cnyToUsdRate` so the result lands in the same currency shape as the
// runtime-supplied cost column. The 512k context boundary is the public
// mavis tier split (≤ 512k input tokens vs > 512k). The "priority" tier
// (1.5x standard) is a per-request service-tier flag the mavis runtime
// currently does not surface in the SQLite store, so we deliberately do
// not model it here.
//
// This table is intentionally hand-rolled rather than fetched from the
// mavis runtime, because the mavis CLI does not currently expose its
// pricing in any other place — if it ever does, the loader can read it
// at startup and pass via `options.priceTable` (tests already do this).
const MAVIS_PRICING = Object.freeze({
  'minimax/MiniMax-M3': {
    input: { upTo512k: 2.10, over512k: 4.20 },
    output: { upTo512k: 8.40, over512k: 16.80 },
    cacheRead: { upTo512k: 0.42, over512k: 0.84 }
  }
});

const MAVIS_CONTEXT_TIER_THRESHOLD = 512 * 1024; // 512k input tokens is the mavis public tier boundary
const MAVIS_DEFAULT_CNY_TO_USD_RATE = 7; // CNY per 1 USD; overridden by options for tests and live FX feeds

/**
 * Recover an estimated `cost` (USD) for rows the runtime left at zero,
 * using the published mavis tier prices and the local CNY→USD rate.
 * Rows that already carry a positive `cost` are passed through unchanged.
 *
 * @param {object|null|undefined} row Normalised row from `normalizeDbRow`.
 * @param {{priceTable?: object, cnyToUsdRate?: number}} [options]
 * @returns {object} The input row, with `cost` populated when recovered.
 */
function applyPriceFallback(row, options = {}) {
  if (!row || row.cost > 0) return row;
  const table = options.priceTable || MAVIS_PRICING;
  const rate = options.cnyToUsdRate || MAVIS_DEFAULT_CNY_TO_USD_RATE;
  // Try the explicit model id first. Mavis runtime currently only
  // ships one model (minimax/MiniMax-M3), so the public listing has
  // exactly one rate card and any "X (model unknown)" fallback row
  // — where the runtime left the model column NULL and token-monitor
  // fabricated a placeholder from the agent name — should still
  // bill at that same card. The display label stays as
  // "${agent} (model unknown)" so the UI doesn't claim a real model
  // id it doesn't have; only the cost column is recovered.
  let modelRates = table[row.model];
  if (!modelRates && row.model && row.model.endsWith(' (model unknown)')) {
    modelRates = table['minimax/MiniMax-M3'];
  }
  if (!modelRates) return row;
  const tier = (row.input + row.cacheRead) > MAVIS_CONTEXT_TIER_THRESHOLD ? 'over512k' : 'upTo512k';
  // Reasoning tokens are output-side, billed at the output rate.
  const inputCost = (row.input * modelRates.input[tier]) / 1_000_000;
  const outputCost = ((row.output + row.reasoning) * modelRates.output[tier]) / 1_000_000;
  const cacheReadCost = (row.cacheRead * modelRates.cacheRead[tier]) / 1_000_000;
  // Cache writes are commonly free; fall back to the model rate if mavis ever
  // prices them. Today the column is unused.
  const totalCny = inputCost + outputCost + cacheReadCost;
  return { ...row, cost: totalCny / rate };
}

/**
 * Top-level entry point: locate the SQLite file, read rows for the configured
 * window, normalise, and apply the price fallback. Returns an empty array
 * when the database cannot be located (not an error — it's a frequent "no
 * install yet" state in fresh environments).
 *
 * @param {object} [options]
 * @returns {Promise<object[]>} Normalised rows ready for aggregation.
 */
async function collectMavisRows(options = {}) {
  const dbPath = options.dbPath || resolveMavisDbPath(options);
  if (!dbPath) return [];
  const read = options.readDbRows || readMavisDbRows;
  const dbRows = await read(dbPath, options);
  const out = [];
  const applyPrice = options.applyPriceFallback !== false;
  for (const raw of dbRows) {
    const normalized = normalizeDbRow(raw);
    if (!normalized) continue;
    out.push(applyPrice ? applyPriceFallback(normalized, options) : normalized);
  }
  return out;
}

// Aggregation key: (sessionId, localDate, model). The local date is part
// of the key so that a single session that runs across midnight gets two
// history buckets instead of being attributed entirely to the day the
// last turn landed on. Same defect proma's adapter had to fix early on;
// doing it here from day one.
//
// Inlined into buildHistoryGraphFromRows because the per-row merge only
// runs in that one place; keeping the helper exported for tests would
// leave it as dead code in production (and trip `no-unused-vars`).

/**
 * Fold normalised rows into the `graph.contributions[]` shape that
 * `collectHistoryOnce` consumes. Buckets by `(localDate, model)`. Drop
 * rows lacking `createdAt` rather than merging them into "today".
 *
 * @param {object[]} rows Normalised rows from `collectMavisRows`.
 * @returns {{contributions: {date: string, clients: object[]}[]}} Graph-shaped output.
 */
function buildHistoryGraphFromRows(rows) {
  const byDate = new Map();
  for (const row of rows) {
    if (!row.createdAt) continue;
    const date = localDateKey(row.createdAt);
    if (!date) continue;
    let day = byDate.get(date);
    if (!day) {
      day = { date, clients: [] };
      byDate.set(date, day);
    }
    let client = day.clients.find((entry) => entry.modelId === row.model);
    if (!client) {
      client = {
        client: MAVIS_CLIENT_ID,
        modelId: row.model,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(client);
    }
    client.tokens.input += row.input;
    client.tokens.output += row.output;
    client.tokens.cacheRead += row.cacheRead;
    client.tokens.cacheWrite += row.cacheWrite;
    client.tokens.reasoning += row.reasoning;
    client.cost += row.cost;
    client.messages += 1;
  }
  return {
    contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  };
}

/**
 * Convenience wrapper: read rows (or use pre-fetched ones) and produce the
 * history graph. Tests pass `options.rows` to avoid the SQLite read; live
 * callers rely on the read path.
 *
 * @param {{rows?: object[]} & object} [options]
 * @returns {Promise<{contributions: {date: string, clients: object[]}[]}>} Graph.
 */
async function buildMavisHistoryGraph(options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : await collectMavisRows(options);
  return buildHistoryGraphFromRows(rows);
}

/**
 * Build the tokscale-compatible aggregate JSON for one time window. Rows
 * older than `windowStartMs` are dropped; rows missing `createdAt` are kept
 * only when `includeUndated` is true (used for the allTime period).
 *
 * @param {number} windowStartMs Lower-bound timestamp (ms epoch).
 * @param {{rows?: object[], includeUndated?: boolean}} [options]
 * @returns {Promise<object>} Tokscale-style aggregate for the window.
 */
// Build the tokscale-compatible JSON for a single time window. The window
// is a minimum createdAt: rows older than it are dropped before
// per-session aggregation. Undated rows are kept only when
// `includeUndated` is true (used for the allTime period).
async function buildTokscaleJson(windowStartMs, options = {}) {
  const includeUndated = options.includeUndated === true;
  const rows = Array.isArray(options.rows) ? options.rows : await collectMavisRows(options);
  const filtered = [];
  for (const row of rows) {
    if (!row.createdAt) {
      if (includeUndated) filtered.push(row);
      continue;
    }
    if (row.createdAt >= windowStartMs) filtered.push(row);
  }
  const bySessionModel = new Map();
  for (const row of filtered) {
    const key = `${row.sessionId}\u0000${row.model}`;
    let m = bySessionModel.get(key);
    if (!m) {
      m = {
        sessionId: row.sessionId,
        model: row.model,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        messages: 0, cost: 0, startedAt: 0, lastUsedAt: 0
      };
      bySessionModel.set(key, m);
    }
    m.input += row.input;
    m.output += row.output;
    m.cacheRead += row.cacheRead;
    m.cacheWrite += row.cacheWrite;
    m.reasoning += row.reasoning;
    m.cost += row.cost;
    m.messages += 1;
    if (row.createdAt && (!m.startedAt || row.createdAt < m.startedAt)) m.startedAt = row.createdAt;
    if (row.createdAt > m.lastUsedAt) m.lastUsedAt = row.createdAt;
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalMessages = 0;
  let totalCost = 0;
  const entries = [];
  for (const m of bySessionModel.values()) {
    entries.push({
      client: MAVIS_CLIENT_ID,
      mergedClients: null,
      sessionId: m.sessionId,
      model: m.model,
      provider: MAVIS_PROVIDER_ID,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      reasoning: m.reasoning,
      messageCount: m.messages,
      cost: m.cost,
      startedAt: m.startedAt ? new Date(m.startedAt).toISOString() : '',
      lastUsedAt: m.lastUsedAt ? new Date(m.lastUsedAt).toISOString() : '',
      performance: null
    });
    totalInput += m.input;
    totalOutput += m.output;
    totalCacheRead += m.cacheRead;
    totalCacheWrite += m.cacheWrite;
    totalMessages += m.messages;
    totalCost += m.cost;
  }

  return {
    groupBy: 'client,session,model',
    entries,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    totalMessages,
    totalCost,
    processingTimeMs: 0
  };
}

/**
 * Build the `{ today, month, allTime }` aggregate for `collectUsageOnce` to
 * merge into the rolling windows. `allTimeSince` is parsed as a local-zone
 * date so cross-day boundaries align with the collector's day buckets.
 *
 * @param {{rows?: object[], now?: Date|string|number, allTimeSince?: string}} [options]
 * @returns {Promise<{today: object, month: object, allTime: object}>} Three windowed aggregates.
 */
async function buildMavisPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : await collectMavisRows(options);
  const buildOptions = { rows };
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
  // Parse allTimeSince as a local calendar day so '2026-08-01' lines up
  // with the same local midnight that buildTokscaleJson and the history
  // graph both bucket by. `new Date('2026-08-01')` would otherwise parse
  // as UTC midnight, which is a day earlier in any negative-offset zone
  // and would silently drop data the user expects to be included.
  const allTimeSince = options.allTimeSince
    ? parseLocalDay(options.allTimeSince)
    : 0;

  return {
    today: await buildTokscaleJson(todayStart, buildOptions),
    month: await buildTokscaleJson(monthStart, buildOptions),
    allTime: await buildTokscaleJson(allTimeSince, { ...buildOptions, includeUndated: true })
  };
}

/**
 * Parse a date-only or short-string input to local-midnight ms epoch.
 * `YYYY-MM-DD` is the only accepted structured form; timestamps and locale
 * strings fall through to `new Date()`. Returns 0 for unparseable input.
 *
 * @param {Date|string|null|undefined} value
 * @returns {number} Local-midnight ms epoch, or 0.
 */
function parseLocalDay(value) {
  if (value instanceof Date) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 0, 0, 0, 0).getTime();
  }
  const str = String(value || '').trim();
  if (!str) return 0;
  // YYYY-MM-DD form: take the parts and build a local-midnight Date. This
  // is the only format we accept; anything else (timestamps, ISO with
  // time, locale strings) falls back to `new Date()` parsing so callers
  // who want exact-instant semantics can still opt in.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
  }
  return new Date(str).getTime() || 0;
}

module.exports = {
  MAVIS_HOME,
  MAVIS_DB_PATH,
  MAVIS_TABLE,
  MAVIS_CLIENT_ID,
  MAVIS_PROVIDER_ID,
  MAVIS_AGENT_NAMES,
  MAVIS_READ_MAX_BYTES,
  MAVIS_READ_MAX_ROWS,
  MAVIS_PRICING,
  MAVIS_CONTEXT_TIER_THRESHOLD,
  MAVIS_DEFAULT_CNY_TO_USD_RATE,
  collectMavisRows,
  buildMavisHistoryGraph,
  buildMavisPeriods,
  buildTokscaleJson,
  buildHistoryGraphFromRows,
  resolveMavisDbPath,
  readMavisDbRows,
  readMavisDbRowsNode,
  runMavisReaderWorker,
  MAVIS_READER_WORKER_FILENAME,
  normalizedModelId,
  normalizeDbRow,
  applyPriceFallback
};
