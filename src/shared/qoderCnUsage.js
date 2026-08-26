'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { customPricingPath } = require('./tokscaleConfig');
const QODER_CN_DB_SUFFIX = path.join('SharedClientCache', 'cache', 'db', 'local.db');
// Qoder CN stores internal model codes (model_info.model_key) instead of real
// model names. Official display names come from the app's bundled i18n keys
// `modelSelector.item.<code>` (Qoder CN.app, 2026-07 build); the codes change
// between releases, so historical rows can reference retired codes — e.g.
// qmodel_preview maps to the same Qwen3.7-Max preview as today's
// q35model_preview. Mapping at parse time keeps display and pricing (tokscale
// resolves the display names case-insensitively) correct for every user's
// data. Unmapped codes (custom models) pass through unchanged.
const QODER_CN_MODEL_DISPLAY_NAMES = Object.freeze({
  auto: 'Auto',
  dashscope_qmodel: 'Qwen3.7-Plus',
  dashscope_qwen3_coder: 'Qwen3-Coder-Plus',
  dashscope_qwen_max_latest: 'Qwen3-Max',
  dfmodel: 'DeepSeek-V4-Flash',
  dmodel: 'DeepSeek-V4-Pro',
  efficient: 'Efficient',
  gm51model: 'GLM-5.2',
  gmodel: 'GLM-5',
  kmodel: 'Kimi-K2.7-Code',
  lite: 'Lite',
  mmodel: 'MiniMax-M3',
  performance: 'Performance',
  q35model: 'Qwen3.5-Plus',
  q35model_preview: 'Qwen3.8-Max-Preview',
  q36fmodel: 'Qwen3.6-Flash',
  qmodel: 'Qwen3.7-Plus',
  qmodel_latest: 'Qwen3.7-Max',
  qmodel_preview: 'Qwen3.8-Max-Preview', // retired code, same preview model
  ultimate: 'Ultimate'
});
const QODER_CN_ROUTING_TIERS = new Set(['auto', 'ultimate', 'performance', 'efficient', 'lite']);
const QODER_CN_READ_MAX_BYTES = 50 * 1024 * 1024;
const QODER_CN_READ_MAX_ROWS = 100_000;
const QODER_CN_NEGATIVE_SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
const QODER_CN_READ_BUDGET_ERROR = 'QODER_CN_READ_BUDGET_EXCEEDED';
// Qoder CN also keeps a live model catalog (code -> displayName) in the
// VS Code-style state DB next to the app root: ItemTable rows keyed
// `aicoding.modelConfigs.cache.<surface>`. The catalog ships with the app and
// changes between releases (gmodel has been GLM-5, GLM-5.2 and GLM-5.3), so the
// static table above ages while rows keep referencing the current codes. The
// dynamic catalog wins over the static table; codes absent from both pass
// through unchanged. `secret://`-prefixed keys in the same table are DPAPI
// encrypted and deliberately never touched — the three catalog keys are plain.
const QODER_CN_STATE_DB_SUFFIX = path.join('User', 'globalStorage', 'state.vscdb');
const QODER_CN_MODEL_CONFIG_CACHE_KEYS = Object.freeze([
  'aicoding.modelConfigs.cache.quest',
  'aicoding.modelConfigs.cache.assistant',
  'aicoding.modelConfigs.cache.experts'
]);
// Sub-agent sessions (session_type `agent_sub_*`, parent_session_id pointing at
// a task-* session) record no model on their messages. They are attributed to
// the parent task's model with this suffix: the suffixed name matches no
// pricing entry, so an unpriceable attribution stays unpriced (issue #301:
// unknown attribution is never costed) while still showing which parent model
// the usage belongs to.
const QODER_CN_SUB_AGENT_MODEL_SUFFIX = ' (sub-agent)';
const QODER_CN_USAGE_SQL = `
SELECT rowid AS row_id, id, session_id, request_id, token_info, model_info, gmt_create,
  (SELECT cs.project_name FROM chat_session cs WHERE cs.session_id = chat_message.session_id LIMIT 1) AS project_name
FROM chat_message
WHERE role = 'assistant'
  AND token_info IS NOT NULL
  AND trim(token_info) NOT IN ('', '{}')
ORDER BY gmt_create, rowid
`;
const QODER_CN_NORMALIZED_TIMESTAMP_SQL = `
CASE
  WHEN typeof(gmt_create) = 'text' AND strftime('%s', trim(gmt_create)) IS NOT NULL
    THEN CAST(strftime('%s', trim(gmt_create)) AS REAL) * 1000
  WHEN typeof(gmt_create) = 'text' AND CAST(trim(gmt_create) AS REAL) > 0
    AND CAST(trim(gmt_create) AS REAL) < 1000000000000
    THEN CAST(trim(gmt_create) AS REAL) * 1000
  WHEN typeof(gmt_create) = 'text' AND CAST(trim(gmt_create) AS REAL) >= 1000000000000
    THEN CAST(trim(gmt_create) AS REAL)
  WHEN typeof(gmt_create) = 'text'
    THEN 0
  WHEN CAST(gmt_create AS REAL) > 0 AND CAST(gmt_create AS REAL) < 1000000000000
    THEN CAST(gmt_create AS REAL) * 1000
  ELSE CAST(gmt_create AS REAL)
END
`;
const QODER_CN_USAGE_SINCE_SQL = `
SELECT rowid AS row_id, id, session_id, request_id, token_info, model_info, gmt_create,
  (SELECT cs.project_name FROM chat_session cs WHERE cs.session_id = chat_message.session_id LIMIT 1) AS project_name
FROM chat_message
WHERE role = 'assistant'
  AND token_info IS NOT NULL
  AND trim(token_info) NOT IN ('', '{}')
  AND (typeof(gmt_create) != 'text' AND (${QODER_CN_NORMALIZED_TIMESTAMP_SQL}) >= ?
    OR typeof(gmt_create) = 'text' AND (${QODER_CN_NORMALIZED_TIMESTAMP_SQL}) >= ? - 86400000)
ORDER BY gmt_create, rowid
`;

// Fallbacks for Qoder CN versions whose database has no chat_session table:
// the scalar subquery would fail the whole read, so probe once per process and
// use the plain queries instead (sessions then stay unattributed).
const QODER_CN_USAGE_SQL_NO_PROJECT = `
SELECT rowid AS row_id, id, session_id, request_id, token_info, model_info, gmt_create
FROM chat_message
WHERE role = 'assistant'
  AND token_info IS NOT NULL
  AND trim(token_info) NOT IN ('', '{}')
ORDER BY gmt_create, rowid
`;
const QODER_CN_USAGE_SINCE_SQL_NO_PROJECT = `
SELECT rowid AS row_id, id, session_id, request_id, token_info, model_info, gmt_create
FROM chat_message
WHERE role = 'assistant'
  AND token_info IS NOT NULL
  AND trim(token_info) NOT IN ('', '{}')
  AND (typeof(gmt_create) != 'text' AND (${QODER_CN_NORMALIZED_TIMESTAMP_SQL}) >= ?
    OR typeof(gmt_create) = 'text' AND (${QODER_CN_NORMALIZED_TIMESTAMP_SQL}) >= ? - 86400000)
ORDER BY gmt_create, rowid
`;
const QODER_CN_CHAT_SESSION_PROBE_SQL = `SELECT 1 FROM sqlite_master
WHERE type = 'table' AND name = 'chat_session'
  AND EXISTS (SELECT 1 FROM pragma_table_info('chat_session') WHERE name = 'project_name')
LIMIT 1`;
// Qoder CN added parent_session_id / preferred_model_info to chat_session
// alongside the sub-agent session types. Older databases lack the columns, so
// model inheritance is probed separately and skipped cleanly there.
const QODER_CN_SESSION_MODEL_PROBE_SQL = `SELECT 1 FROM sqlite_master
WHERE type = 'table' AND name = 'chat_session'
  AND EXISTS (SELECT 1 FROM pragma_table_info('chat_session') WHERE name = 'parent_session_id')
  AND EXISTS (SELECT 1 FROM pragma_table_info('chat_session') WHERE name = 'preferred_model_info')
LIMIT 1`;
// The whole session table is small next to chat_message (one row per chat, not
// per message) and parent sessions can predate the message window being read,
// so inheritance reads the session mapping independently of the usage query
// instead of correlating a subquery per message row.
const QODER_CN_SESSION_MODELS_SQL = `
SELECT session_id, parent_session_id, preferred_model_info FROM chat_session
`;

function normalizeQoderCnProjectLabel(value) {
  // '.' is Qoder CN's "no project" sentinel; keep it unattributed so it does
  // not surface as a phantom project named '.' in the Projects view.
  const label = String(value || '').trim();
  return label === '.' ? '' : label;
}

// Positive capabilities remain cached. Confirmed-absent capabilities use a
// bounded TTL so an in-place Qoder schema migration becomes visible without
// probing every legacy database on every collector tick. Transient probe
// failures are never cached.
const qoderCnChatSessionTableCache = new Map();
const qoderCnSessionModelTableCache = new Map();

// Runs a boolean sqlite_master/pragma probe: true when the SQL yields a row,
// false when the database was read successfully without one, or null when the
// probe itself failed.
async function probeQoderCnSql(dbPath, sql, { run, requireFn } = {}) {
  try {
    if (run) {
      const result = await run('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, sql], {
        encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000, windowsHide: true
      });
      const parsed = JSON.parse(String(result?.stdout || '').trim() || '[]');
      return Array.isArray(parsed) ? parsed.length > 0 : null;
    }
  } catch (_) { /* fall through to node:sqlite */ }
  try {
    const requireFnLocal = requireFn || require;
    const { DatabaseSync } = requireFnLocal('node:sqlite');
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout = 250');
      return database.prepare(sql).get() !== undefined;
    } finally {
      database.close();
    }
  } catch (_) {
    return null;
  }
}

// Returns true when chat_session.project_name exists, false when the database
// was read successfully without it, or null when the probe itself failed.
async function probeQoderCnChatSessionTable(dbPath, options = {}) {
  return probeQoderCnSql(dbPath, QODER_CN_CHAT_SESSION_PROBE_SQL, options);
}

// Same contract for the model-inheritance columns (parent_session_id +
// preferred_model_info); both must exist for the session-model mapping to be
// usable.
async function probeQoderCnSessionModelColumns(dbPath, options = {}) {
  return probeQoderCnSql(dbPath, QODER_CN_SESSION_MODEL_PROBE_SQL, options);
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 && value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const number = Number(value);
  if (Number.isFinite(number)) return number > 0 && number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function jsonObject(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function sourceId(value) {
  return createHash('sha256').update(path.normalize(String(value || ''))).digest('hex').slice(0, 12);
}

function isQoderCnRoutingTier(value) {
  return QODER_CN_ROUTING_TIERS.has(String(value || '').trim().toLowerCase());
}

// chat_message.model_info is JSON with the model under $.model_key; missing or
// malformed payloads yield null (the sub-agent inheritance path).
function qoderCnModelKeyFromInfo(value) {
  const modelInfo = jsonObject(value);
  const key = String(modelInfo?.model_key || modelInfo?.modelKey || '').trim();
  return key || null;
}

// Dynamic catalog (state.vscdb) wins over the static table; an entry has to be
// an own property with a non-empty value so prototype names ("constructor",
// "toString") can never be resolved as display names. Codes absent from both
// catalogs pass through unchanged to the caller.
function qoderCnModelDisplayName(code, dynamicNames) {
  if (dynamicNames) {
    if (typeof dynamicNames.get === 'function') {
      const name = dynamicNames.get(code);
      if (typeof name === 'string' && name.trim()) return name.trim();
    } else if (Object.prototype.hasOwnProperty.call(dynamicNames, code)) {
      const name = dynamicNames[code];
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  }
  if (Object.prototype.hasOwnProperty.call(QODER_CN_MODEL_DISPLAY_NAMES, code)) {
    return QODER_CN_MODEL_DISPLAY_NAMES[code];
  }
  return null;
}

// Values interpolated into IN (...) lists for the sqlite3 CLI path cannot use
// bound parameters, so single quotes are doubled — the ids come from the local
// database itself and only ever need literal escaping.
function qoderCnSqlStringLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function estimatedQoderCnRowCost(row, pricingByModel) {
  // Qoder CN stores routing tiers without the model selected behind them. Do
  // not let an unrelated catalog/custom-pricing entry supply a false price.
  const modelId = String(row?.model || '').trim().toLowerCase();
  if (isQoderCnRoutingTier(modelId)) return null;
  const pricing = pricingByModel?.[modelId];
  if (!pricing || typeof pricing !== 'object') return null;
  const components = [
    [row.input, pricing.inputCostPerToken],
    [row.output, pricing.outputCostPerToken],
    [row.cacheRead, pricing.cacheReadInputTokenCost],
    [row.cacheWrite, pricing.cacheCreationInputTokenCost]
  ];
  let cost = 0;
  for (const [tokens, unitCost] of components) {
    if (!tokens) continue;
    if (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) return null;
    cost += tokens * Number(unitCost);
  }
  return cost;
}

const QODER_CN_PRICING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const QODER_CN_PRICING_LOOKUP_TIMEOUT_MS = 3000;
const qoderCnPricingCache = new Map();

function qoderCnPricingRevision() {
  try { return fs.statSync(customPricingPath()).mtimeMs; } catch (_) { return 0; }
}

function normalizeQoderCnPricing(result) {
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

async function resolveQoderCnPricing(rows, options = {}) {
  const lookup = options.lookupModelPricing;
  const revision = options.pricingRevision ?? qoderCnPricingRevision();
  const nowMs = options.nowMs ?? Date.now();
  const commandTimeoutMs = options.commandTimeoutMs || QODER_CN_PRICING_LOOKUP_TIMEOUT_MS;
  const pricingByModel = {};
  const modelIds = [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.model || '').trim().toLowerCase())
    .filter((modelId) => modelId && !isQoderCnRoutingTier(modelId)))];
  for (const modelId of modelIds) {
    const cached = qoderCnPricingCache.get(modelId);
    if (cached && cached.revision === revision && nowMs - cached.at < QODER_CN_PRICING_CACHE_TTL_MS) {
      if (cached.pricing) pricingByModel[modelId] = cached.pricing;
      continue;
    }
    let pricing = null;
    try {
      pricing = normalizeQoderCnPricing(await lookup(modelId, commandTimeoutMs));
    } catch (_) {
      // An unknown model, offline lookup, or custom channel must remain
      // cost-unavailable instead of inheriting an unrelated catalog price.
    }
    qoderCnPricingCache.set(modelId, { at: nowMs, revision, pricing });
    if (pricing) pricingByModel[modelId] = pricing;
  }
  return pricingByModel;
}

function resetQoderCnPricingCache() {
  qoderCnPricingCache.clear();
}

// context is optional and supplied by collectQoderCnRows:
//   modelDisplayNames      — code -> displayName from state.vscdb (dynamic
//                            catalog, takes precedence over the static table)
//   inheritedSessionModels — Map<sessionId, parent model code> resolved from
//                            chat_session for sub-agent sessions whose messages
//                            record no model of their own
function normalizeQoderCnDbRow(row, source = 'local', context = {}) {
  const usage = jsonObject(row?.token_info);
  const prompt = numeric(usage?.prompt_tokens);
  const cached = numeric(usage?.cached_tokens ?? 0);
  const output = numeric(usage?.completion_tokens);
  if (prompt === null || cached === null || output === null || prompt + output === 0) return null;

  const session = String(row?.session_id || row?.request_id || row?.id || row?.row_id || 'unknown');
  const message = String(row?.id || row?.request_id || row?.row_id || `${row?.gmt_create || 0}`);
  const modelKey = qoderCnModelKeyFromInfo(row?.model_info);
  let model;
  if (modelKey) {
    model = qoderCnModelDisplayName(modelKey, context.modelDisplayNames) || modelKey;
  } else {
    // No model recorded on the message: sub-agent rows inherit the parent
    // task's model (suffixed); everything else keeps the generic fallback.
    const inheritedKey = typeof context.inheritedSessionModels?.get === 'function'
      ? context.inheritedSessionModels.get(String(row?.session_id || ''))
      : null;
    model = inheritedKey
      ? `${qoderCnModelDisplayName(inheritedKey, context.modelDisplayNames) || inheritedKey}${QODER_CN_SUB_AGENT_MODEL_SUFFIX}`
      : 'qoder-agent';
  }
  return {
    sessionId: `qodercn:${source}:${session}`,
    messageId: `qodercn:${source}:${session}:${message}`,
    model,
    projectLabel: normalizeQoderCnProjectLabel(row?.project_name),
    input: Math.max(0, prompt - cached),
    output,
    cacheRead: Math.min(prompt, cached),
    cacheWrite: 0,
    createdAt: timestampMs(row?.gmt_create),
    messages: 1
  };
}

// <appRoot>\SharedClientCache\cache\db\local.db and
// <appRoot>\User\globalStorage\state.vscdb share the Qoder CN app root. The
// suffix is matched case-insensitively: on Windows the drive-letter and
// directory casing a process reports can differ from the canonical spelling.
// A db path outside the standard layout yields null so the caller falls back
// to the app root derived from qoderCnDataPaths().
function qoderCnStateDbPathFromDbPath(dbPath) {
  const normalized = path.normalize(String(dbPath || ''));
  if (!normalized) return null;
  const suffix = path.normalize(QODER_CN_DB_SUFFIX);
  if (!normalized.toLowerCase().endsWith(suffix.toLowerCase())) return null;
  const appRoot = normalized.slice(0, normalized.length - suffix.length);
  if (!appRoot || appRoot === path.sep) return null;
  return path.join(appRoot, QODER_CN_STATE_DB_SUFFIX);
}

function qoderCnDataPaths(options = {}) {
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  let appSupport;
  if (platform === 'darwin') appSupport = path.join(home, 'Library', 'Application Support');
  else if (platform === 'win32') appSupport = (typeof env.APPDATA === 'string' && env.APPDATA.length > 0) ? env.APPDATA : path.join(home, 'AppData', 'Roaming');
  else {
    const xdg = env.XDG_CONFIG_HOME;
    appSupport = (typeof xdg === 'string' && path.isAbsolute(xdg)) ? xdg : path.join(home, '.config');
  }

  const appRoot = path.join(appSupport, 'QoderCN');
  const explicitDb = String(env.TOKEN_MONITOR_QODER_CN_DB_PATH || '').trim();
  return {
    dbPaths: explicitDb
      ? [path.resolve(explicitDb)]
      : [path.join(appRoot, QODER_CN_DB_SUFFIX)],
    stateDbPaths: [path.join(appRoot, QODER_CN_STATE_DB_SUFFIX)]
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function positiveIntegerOrZero(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function readBudgetError(kind, limit, cause) {
  const error = new Error(`qodercn sqlite read budget exceeded (${kind} limit ${limit})`, cause ? { cause } : undefined);
  error.code = QODER_CN_READ_BUDGET_ERROR;
  return error;
}

function isReadBudgetError(error) {
  return error?.code === QODER_CN_READ_BUDGET_ERROR
    || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

function boundedRows(iterable, { maxReadBytes, maxReadRows, countBytes }) {
  const rows = [];
  let bytes = 2; // JSON array brackets; commas are counted as rows are appended.
  for (const row of iterable) {
    if (rows.length >= maxReadRows) throw readBudgetError('rows', maxReadRows);
    if (countBytes) {
      const serialized = JSON.stringify(row);
      bytes += Buffer.byteLength(serialized, 'utf8') + (rows.length > 0 ? 1 : 0);
      if (bytes > maxReadBytes) throw readBudgetError('bytes', maxReadBytes);
    }
    rows.push(row);
  }
  return rows;
}

async function readQoderCnDbRows(dbPath, options = {}) {
  const run = options.execFile || execFileAsync;
  const sinceMs = options.sinceMs;
  const nowMs = options.nowMs ?? Date.now();
  const negativeSchemaCacheTtlMs = positiveIntegerOrZero(
    options.negativeSchemaCacheTtlMs,
    QODER_CN_NEGATIVE_SCHEMA_CACHE_TTL_MS
  );
  const maxReadBytes = positiveInteger(options.maxReadBytes, QODER_CN_READ_MAX_BYTES);
  const maxReadRows = positiveInteger(options.maxReadRows, QODER_CN_READ_MAX_ROWS);
  const cachedProbe = qoderCnChatSessionTableCache.get(dbPath);
  let probed = cachedProbe?.hasProject;
  const negativeCacheFresh = cachedProbe?.hasProject === false
    && nowMs - cachedProbe.at < negativeSchemaCacheTtlMs;
  if (probed === undefined || (probed === false && !negativeCacheFresh)) {
    probed = await probeQoderCnChatSessionTable(dbPath, { run, requireFn: options.requireFn });
    if (probed !== null) qoderCnChatSessionTableCache.set(dbPath, { hasProject: probed, at: nowMs });
  }
  const withProject = probed === true;
  const sql = sinceMs
    ? (withProject ? QODER_CN_USAGE_SINCE_SQL : QODER_CN_USAGE_SINCE_SQL_NO_PROJECT)
    : (withProject ? QODER_CN_USAGE_SQL : QODER_CN_USAGE_SQL_NO_PROJECT);
  const cliArgs = sinceMs
    ? ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, sql.replace('?', String(sinceMs)).replace('?', String(sinceMs))]
    : ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, sql];
  try {
    const result = await run('sqlite3', cliArgs, {
      encoding: 'utf8', maxBuffer: maxReadBytes, timeout: 30_000, windowsHide: true
    });
    const stdout = String(result?.stdout || '').trim();
    if (Buffer.byteLength(stdout, 'utf8') > maxReadBytes) throw readBudgetError('bytes', maxReadBytes);
    const parsed = JSON.parse(stdout || '[]');
    return boundedRows(Array.isArray(parsed) ? parsed : [], { maxReadBytes, maxReadRows, countBytes: false });
  } catch (cliError) {
    if (isReadBudgetError(cliError)) {
      const error = cliError.code === QODER_CN_READ_BUDGET_ERROR
        ? cliError
        : readBudgetError('bytes', maxReadBytes, cliError);
      if (typeof options.logger === 'function') options.logger(error.message);
      throw error;
    }
    try {
      const requireFn = options.requireFn || require;
      const { DatabaseSync } = requireFn('node:sqlite');
      const database = new DatabaseSync(dbPath, { readOnly: true });
      try {
        database.exec('PRAGMA busy_timeout = 250');
        const statement = database.prepare(withProject
          ? (sinceMs ? QODER_CN_USAGE_SINCE_SQL : QODER_CN_USAGE_SQL)
          : (sinceMs ? QODER_CN_USAGE_SINCE_SQL_NO_PROJECT : QODER_CN_USAGE_SQL_NO_PROJECT));
        const iterator = sinceMs ? statement.iterate(sinceMs, sinceMs) : statement.iterate();
        return boundedRows(iterator, { maxReadBytes, maxReadRows, countBytes: true });
      } finally {
        database.close();
      }
    } catch (nodeError) {
      if (isReadBudgetError(nodeError)) {
        if (typeof options.logger === 'function') options.logger(nodeError.message);
        throw nodeError;
      }
      // Fail loudly instead of silently returning empty usage. The collector
      // logs the error and retains its last complete snapshot when available.
      const message = `qodercn sqlite read failed: sqlite3 CLI: ${cliError.message}; node:sqlite: ${nodeError.message}`;
      if (typeof options.logger === 'function') options.logger(message);
      throw new Error(message, { cause: nodeError });
    }
  }
}

// Shared dual-backend reader for the auxiliary reads (state.vscdb catalog,
// chat_session mapping, per-session message fallback): sqlite3 CLI first, then
// node:sqlite, with the same row/byte budgets as the usage query. Unlike
// readQoderCnDbRows this throws to its caller — every consumer here treats the
// data as best-effort and degrades instead of failing the collection.
async function readQoderCnSqlRows(dbPath, sql, options = {}) {
  const run = options.execFile || execFileAsync;
  const maxReadBytes = positiveInteger(options.maxReadBytes, QODER_CN_READ_MAX_BYTES);
  const maxReadRows = positiveInteger(options.maxReadRows, QODER_CN_READ_MAX_ROWS);
  try {
    const result = await run('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, sql], {
      encoding: 'utf8', maxBuffer: maxReadBytes, timeout: 30_000, windowsHide: true
    });
    const stdout = String(result?.stdout || '').trim();
    if (Buffer.byteLength(stdout, 'utf8') > maxReadBytes) throw readBudgetError('bytes', maxReadBytes);
    const parsed = JSON.parse(stdout || '[]');
    return boundedRows(Array.isArray(parsed) ? parsed : [], { maxReadBytes, maxReadRows, countBytes: false });
  } catch (cliError) {
    if (isReadBudgetError(cliError)) throw cliError;
    try {
      const requireFn = options.requireFn || require;
      const { DatabaseSync } = requireFn('node:sqlite');
      const database = new DatabaseSync(dbPath, { readOnly: true });
      try {
        database.exec('PRAGMA busy_timeout = 250');
        return boundedRows(database.prepare(sql).iterate(), { maxReadBytes, maxReadRows, countBytes: true });
      } finally {
        database.close();
      }
    } catch (nodeError) {
      if (isReadBudgetError(nodeError)) throw nodeError;
      throw new Error(`qodercn sqlite read failed: sqlite3 CLI: ${cliError.message}; node:sqlite: ${nodeError.message}`, { cause: nodeError });
    }
  }
}

// Reads the live model catalog from state.vscdb. The database is a best-effort
// cache of the app's model list: a missing file, a missing key, a malformed
// payload or a locked database silently yields an empty mapping and the static
// table stays authoritative.
async function readQoderCnModelDisplayNames(stateDbPath, options = {}) {
  const names = Object.create(null);
  if (!stateDbPath || !fs.existsSync(stateDbPath)) return names;
  try {
    const literals = QODER_CN_MODEL_CONFIG_CACHE_KEYS.map((key) => qoderCnSqlStringLiteral(key)).join(', ');
    const sql = `SELECT key, value FROM ItemTable WHERE key IN (${literals})`;
    const rows = await readQoderCnSqlRows(stateDbPath, sql, options);
    const valuesByKey = new Map();
    for (const row of rows) {
      const key = String(row?.key || '');
      if (QODER_CN_MODEL_CONFIG_CACHE_KEYS.includes(key) && !valuesByKey.has(key)) valuesByKey.set(key, row?.value);
    }
    // Iterate in the fixed key order so a code listed by several surfaces keeps
    // the first catalog's spelling (the surfaces describe the same models).
    for (const key of QODER_CN_MODEL_CONFIG_CACHE_KEYS) {
      const entries = jsonObject(valuesByKey.get(key));
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const code = String(entry?.name || '').trim();
        const displayName = String(entry?.displayName || '').trim();
        if (code && displayName && names[code] === undefined) names[code] = displayName;
      }
    }
  } catch (_) {
    // Anything unreadable here must never take the usage collection down.
  }
  return names;
}

// Reads the chat_session mapping used for sub-agent model inheritance.
// Returns null when the columns are absent (probe), the database cannot be
// read, or the read budget is exceeded — inheritance then simply stays off.
async function readQoderCnSessionModels(dbPath, options = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const run = options.execFile || execFileAsync;
  const nowMs = options.nowMs ?? Date.now();
  const negativeSchemaCacheTtlMs = positiveIntegerOrZero(
    options.negativeSchemaCacheTtlMs,
    QODER_CN_NEGATIVE_SCHEMA_CACHE_TTL_MS
  );
  const cachedProbe = qoderCnSessionModelTableCache.get(dbPath);
  let probed = cachedProbe?.supported;
  const negativeCacheFresh = cachedProbe?.supported === false
    && nowMs - cachedProbe.at < negativeSchemaCacheTtlMs;
  if (probed === undefined || (probed === false && !negativeCacheFresh)) {
    probed = await probeQoderCnSessionModelColumns(dbPath, { run, requireFn: options.requireFn });
    if (probed !== null) qoderCnSessionModelTableCache.set(dbPath, { supported: probed, at: nowMs });
  }
  if (probed !== true) return null;
  try {
    const rows = await readQoderCnSqlRows(dbPath, QODER_CN_SESSION_MODELS_SQL, options);
    const sessions = new Map();
    for (const row of rows) {
      const sessionId = String(row?.session_id || '').trim();
      if (!sessionId || sessions.has(sessionId)) continue;
      const preferred = jsonObject(row?.preferred_model_info);
      const preferredModel = String(preferred?.preferred_model || preferred?.preferredModel || '').trim();
      sessions.set(sessionId, {
        parentSessionId: String(row?.parent_session_id || '').trim() || null,
        preferredModel: preferredModel || null
      });
    }
    return sessions;
  } catch (error) {
    if (typeof options.logger === 'function') options.logger(`qodercn session model read failed: ${error.message}`);
    return null;
  }
}

// Latest message model per session for parents whose preferred_model_info is
// empty. Only the given sessions are read, newest first, so the first row seen
// per session is that session's latest model.
async function readQoderCnLatestSessionModelKeys(dbPath, sessionIds, options = {}) {
  const latest = new Map();
  const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  if (!dbPath || !ids.length || !fs.existsSync(dbPath)) return latest;
  const literals = ids.map((id) => qoderCnSqlStringLiteral(id)).join(', ');
  const sql = `SELECT session_id, model_info FROM chat_message
WHERE session_id IN (${literals})
  AND model_info IS NOT NULL
  AND trim(model_info) NOT IN ('', '{}')
ORDER BY gmt_create DESC, rowid DESC`;
  try {
    const rows = await readQoderCnSqlRows(dbPath, sql, options);
    for (const row of rows) {
      const sessionId = String(row?.session_id || '').trim();
      if (!sessionId || latest.has(sessionId)) continue;
      const code = qoderCnModelKeyFromInfo(row?.model_info);
      if (code) latest.set(sessionId, code);
    }
  } catch (error) {
    if (typeof options.logger === 'function') options.logger(`qodercn session message model read failed: ${error.message}`);
  }
  return latest;
}

// Walks a session's parent chain: the parent's preferred model first, then its
// latest known message model, then its own parent. deadEnds (optional)
// collects the sessions a fallback message query could still resolve.
function qoderCnSessionModelFromChain(sessionId, sessionModels, latestMaps, deadEnds) {
  const seen = new Set();
  let current = sessionModels.get(sessionId)?.parentSessionId || null;
  while (current && !seen.has(current)) {
    seen.add(current);
    const info = sessionModels.get(current);
    if (!info) {
      if (deadEnds) deadEnds.add(current);
      return null;
    }
    if (info.preferredModel) return info.preferredModel;
    for (const latest of latestMaps) {
      if (latest.has(current)) return latest.get(current);
    }
    if (info.parentSessionId) {
      current = info.parentSessionId;
      continue;
    }
    if (deadEnds) deadEnds.add(current);
    return null;
  }
  return null;
}

// Resolves the parent model code for every session that has messages without a
// model of their own. Parent sessions may predate the message window (and can
// even carry no token-bearing messages at all), so the mapping comes from
// chat_session rather than from the rows already read.
async function resolveQoderCnInheritedSessionModels(dbPath, dbRows, options = {}) {
  const inherited = new Map();
  const candidateSessions = new Set();
  for (const row of dbRows) {
    if (qoderCnModelKeyFromInfo(row?.model_info)) continue;
    const sessionId = String(row?.session_id || '').trim();
    if (sessionId) candidateSessions.add(sessionId);
  }
  if (!candidateSessions.size) return inherited;

  const sessionModels = await readQoderCnSessionModels(dbPath, options);
  if (!sessionModels) return inherited;

  // Latest in-window model per session, for free: the usage query returns rows
  // oldest-first, so the last write per session is the newest message.
  const latestRowModels = new Map();
  for (const row of dbRows) {
    const sessionId = String(row?.session_id || '').trim();
    const code = qoderCnModelKeyFromInfo(row?.model_info);
    if (sessionId && code) latestRowModels.set(sessionId, code);
  }

  const deadEnds = new Set();
  for (const sessionId of candidateSessions) {
    const code = qoderCnSessionModelFromChain(sessionId, sessionModels, [latestRowModels], deadEnds);
    if (code) inherited.set(sessionId, code);
  }
  if (deadEnds.size) {
    const latestDbModels = await readQoderCnLatestSessionModelKeys(dbPath, [...deadEnds], options);
    if (latestDbModels.size) {
      for (const sessionId of candidateSessions) {
        if (inherited.has(sessionId)) continue;
        const code = qoderCnSessionModelFromChain(sessionId, sessionModels, [latestRowModels, latestDbModels], null);
        if (code) inherited.set(sessionId, code);
      }
    }
  }
  return inherited;
}

async function collectQoderCnRows(options = {}) {
  const paths = qoderCnDataPaths(options);
  const injectedDbPaths = Array.isArray(options.dbPaths);
  const dbPaths = injectedDbPaths ? options.dbPaths : paths.dbPaths;
  const readDbRows = options.readDbRows || readQoderCnDbRows;
  const readModelDisplayNames = options.readModelDisplayNames || readQoderCnModelDisplayNames;
  const sinceMs = options.sinceMs;
  const rows = [];

  for (const dbPath of dbPaths) {
    if (!options.readDbRows && !fs.existsSync(dbPath)) continue;
    const source = sourceId(dbPath);
    const dbRows = await readDbRows(dbPath, { ...options, sinceMs });
    // The dynamic catalog lives next to the database (same app root); it is
    // read once per collection and shared by every row, never re-read per row.
    // An injected db path keeps the collection hermetic: only a standard
    // SharedClientCache layout (or an explicit stateDbPath) opts into the
    // local app root.
    const stateDbPath = options.stateDbPath
      || qoderCnStateDbPathFromDbPath(dbPath)
      || (injectedDbPaths ? null : paths.stateDbPaths[0]);
    let modelDisplayNames = null;
    try {
      const names = await readModelDisplayNames(stateDbPath, options);
      if (names && typeof names === 'object') modelDisplayNames = names;
    } catch (_) { /* a failing catalog read keeps the static table */ }
    const inheritedSessionModels = await resolveQoderCnInheritedSessionModels(dbPath, dbRows, options);
    const context = { modelDisplayNames, inheritedSessionModels };
    for (const dbRow of dbRows) {
      const row = normalizeQoderCnDbRow(dbRow, source, context);
      if (row) rows.push(row);
    }
  }

  const unique = new Map();
  for (const row of rows) unique.set(row.messageId, row);
  return [...unique.values()];
}

function buildTokscaleJson(startMs, rows, pricingByModel, includeUndated = false) {
  const grouped = new Map();
  for (const row of rows) {
    // Mirrors promaUsage: dated rows must fall inside the window, undated rows
    // count only for allTime (includeUndated) — never for today/month.
    if (startMs && (row.createdAt ? row.createdAt < startMs : !includeUndated)) continue;
    const key = `${row.sessionId}\0${row.model}`;
    if (!grouped.has(key)) grouped.set(key, { ...row, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, startedAt: 0, lastUsedAt: 0, cost: 0 });
    const group = grouped.get(key);
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.messages += row.messages;
    const cost = estimatedQoderCnRowCost(row, pricingByModel);
    group.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
  }

  const entries = [...grouped.values()].map((row) => ({
    client: 'qodercn', mergedClients: null, sessionId: row.sessionId, model: row.model, provider: 'qodercn',
    input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
    reasoning: 0, messageCount: row.messages, cost: row.cost,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : '',
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : '',
    projectLabel: row.projectLabel || '', performance: null
  }));
  const sum = (key) => entries.reduce((total, row) => total + row[key], 0);
  return {
    groupBy: 'client,session,model', entries,
    totalInput: sum('input'), totalOutput: sum('output'), totalCacheRead: sum('cacheRead'),
    totalCacheWrite: sum('cacheWrite'), totalMessages: sum('messageCount'), totalCost: sum('cost'), processingTimeMs: 0
  };
}

function buildQoderCnPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const pricingByModel = options.pricingByModel;
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

function buildQoderCnHistoryGraph(options = {}) {
  const days = new Map();
  for (const row of options.rows || []) {
    const date = localDateKey(row.createdAt);
    if (!date) continue;
    if (!days.has(date)) days.set(date, { date, clients: [] });
    const day = days.get(date);
    let model = day.clients.find((entry) => entry.modelId === row.model);
    if (!model) {
      model = { client: 'qodercn', modelId: row.model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 0 };
      day.clients.push(model);
    }
    const cost = estimatedQoderCnRowCost(row, options.pricingByModel);
    model.tokens.input += row.input;
    model.tokens.output += row.output;
    model.tokens.cacheRead += row.cacheRead;
    model.tokens.cacheWrite += row.cacheWrite;
    model.cost += cost === null ? 0 : cost;
    model.messages += row.messages;
  }
  return { contributions: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

module.exports = {
  QODER_CN_MODEL_DISPLAY_NAMES,
  buildQoderCnHistoryGraph,
  buildQoderCnPeriods,
  collectQoderCnRows,
  normalizeQoderCnDbRow,
  qoderCnDataPaths,
  qoderCnStateDbPathFromDbPath,
  readQoderCnDbRows,
  readQoderCnModelDisplayNames,
  readQoderCnSessionModels,
  resolveQoderCnPricing,
  resetQoderCnPricingCache,
  resetQoderCnChatSessionProbe() {
    qoderCnChatSessionTableCache.clear();
    qoderCnSessionModelTableCache.clear();
  }
};
