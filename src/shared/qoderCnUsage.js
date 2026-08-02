'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { estimatedRowCost } = require('./promaUsage');

const execFileAsync = promisify(execFile);
const QODER_DB_SUFFIX = path.join('SharedClientCache', 'cache', 'db', 'local.db');
// Qoder CN stores internal model codes (model_info.model_key) instead of real
// model names. Official display names come from the app's bundled i18n keys
// `modelSelector.item.<code>` (Qoder CN.app, 2026-07 build); the codes change
// between releases, so historical rows can reference retired codes — e.g.
// qmodel_preview maps to the same Qwen3.7-Max preview as today's
// q35model_preview. Mapping at parse time keeps display and pricing (tokscale
// resolves the display names case-insensitively) correct for every user's
// data. Unmapped codes (custom models) pass through unchanged.
const QODER_MODEL_DISPLAY_NAMES = Object.freeze({
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
const QODER_USAGE_SQL = `
SELECT rowid AS row_id, id, session_id, request_id, token_info, model_info, gmt_create
FROM chat_message
WHERE role = 'assistant'
  AND token_info IS NOT NULL
  AND trim(token_info) NOT IN ('', '{}')
ORDER BY gmt_create, rowid
`;
const QODER_NORMALIZED_TIMESTAMP_SQL = `
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
const QODER_USAGE_SINCE_SQL = `
SELECT rowid AS row_id, id, session_id, request_id, token_info, model_info, gmt_create
FROM chat_message
WHERE role = 'assistant'
  AND token_info IS NOT NULL
  AND trim(token_info) NOT IN ('', '{}')
  AND (typeof(gmt_create) != 'text' AND (${QODER_NORMALIZED_TIMESTAMP_SQL}) >= ?
    OR typeof(gmt_create) = 'text' AND (${QODER_NORMALIZED_TIMESTAMP_SQL}) >= ? - 86400000)
ORDER BY gmt_create, rowid
`;

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

function estimatedQoderRowCost(row, pricingByModel) {
  // Qoder stores Auto as a routing mode without the model selected behind it.
  // Do not let models.dev's unrelated morph/auto entry supply a false price.
  if (String(row?.model || '').trim().toLowerCase() === 'auto') return null;
  return estimatedRowCost(row, pricingByModel);
}

function normalizeQoderDbRow(row, source = 'local') {
  const usage = jsonObject(row?.token_info);
  const prompt = numeric(usage?.prompt_tokens);
  const cached = numeric(usage?.cached_tokens ?? 0);
  const output = numeric(usage?.completion_tokens);
  if (prompt === null || cached === null || output === null || prompt + output === 0) return null;

  const session = String(row?.session_id || row?.request_id || row?.id || row?.row_id || 'unknown');
  const message = String(row?.id || row?.request_id || row?.row_id || `${row?.gmt_create || 0}`);
  const modelInfo = jsonObject(row?.model_info);
  const modelKey = String(modelInfo?.model_key || modelInfo?.modelKey || 'qoder-agent');
  const displayName = Object.prototype.hasOwnProperty.call(QODER_MODEL_DISPLAY_NAMES, modelKey)
    ? QODER_MODEL_DISPLAY_NAMES[modelKey]
    : null;
  return {
    sessionId: `qodercn:${source}:${session}`,
    messageId: `qodercn:${source}:${session}:${message}`,
    model: displayName || modelKey,
    input: Math.max(0, prompt - cached),
    output,
    cacheRead: Math.min(prompt, cached),
    cacheWrite: 0,
    createdAt: timestampMs(row?.gmt_create),
    messages: 1
  };
}

function qoderDataPaths(options = {}) {
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

  const explicitDb = String(env.TOKEN_MONITOR_QODER_CN_DB_PATH || '').trim();
  return {
    dbPaths: explicitDb
      ? [path.resolve(explicitDb)]
      : [path.join(appSupport, 'QoderCN', QODER_DB_SUFFIX)]
  };
}

async function readQoderDbRows(dbPath, options = {}) {
  const run = options.execFile || execFileAsync;
  const sinceMs = options.sinceMs;
  const sql = sinceMs ? QODER_USAGE_SINCE_SQL : QODER_USAGE_SQL;
  const cliArgs = sinceMs
    ? ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, sql.replace('?', String(sinceMs)).replace('?', String(sinceMs - 86_400_000))]
    : ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, sql];
  try {
    const result = await run('sqlite3', cliArgs, {
      encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 30_000, windowsHide: true
    });
    const parsed = JSON.parse(String(result?.stdout || '').trim() || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (cliError) {
    try {
      const requireFn = options.requireFn || require;
      const { DatabaseSync } = requireFn('node:sqlite');
      const database = new DatabaseSync(dbPath, { readOnly: true });
      try {
        database.exec('PRAGMA busy_timeout = 250');
        return sinceMs
          ? database.prepare(QODER_USAGE_SINCE_SQL).all(sinceMs, sinceMs - 86_400_000)
          : database.prepare(QODER_USAGE_SQL).all();
      } finally {
        database.close();
      }
    } catch (nodeError) {
      // Fail loudly instead of silently returning empty usage. The collector
      // logs the error and retains its last complete snapshot when available.
      const message = `qoder sqlite read failed: sqlite3 CLI: ${cliError.message}; node:sqlite: ${nodeError.message}`;
      if (typeof options.logger === 'function') options.logger(message);
      throw new Error(message, { cause: nodeError });
    }
  }
}

async function collectQoderRows(options = {}) {
  const paths = qoderDataPaths(options);
  const dbPaths = Array.isArray(options.dbPaths) ? options.dbPaths : paths.dbPaths;
  const readDbRows = options.readDbRows || readQoderDbRows;
  const sinceMs = options.sinceMs;
  const rows = [];

  for (const dbPath of dbPaths) {
    if (!options.readDbRows && !fs.existsSync(dbPath)) continue;
    const source = sourceId(dbPath);
    const dbRows = await readDbRows(dbPath, { ...options, sinceMs });
    for (const dbRow of dbRows) {
      const row = normalizeQoderDbRow(dbRow, source);
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
    const cost = estimatedQoderRowCost(row, pricingByModel);
    group.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
  }

  const entries = [...grouped.values()].map((row) => ({
    client: 'qodercn', mergedClients: null, sessionId: row.sessionId, model: row.model, provider: 'qodercn',
    input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
    reasoning: 0, messageCount: row.messages, cost: row.cost,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : '',
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : '', performance: null
  }));
  const sum = (key) => entries.reduce((total, row) => total + row[key], 0);
  return {
    groupBy: 'client,session,model', entries,
    totalInput: sum('input'), totalOutput: sum('output'), totalCacheRead: sum('cacheRead'),
    totalCacheWrite: sum('cacheWrite'), totalMessages: sum('messageCount'), totalCost: sum('cost'), processingTimeMs: 0
  };
}

function buildQoderPeriods(options = {}) {
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

function buildQoderHistoryGraph(options = {}) {
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
    const cost = estimatedQoderRowCost(row, options.pricingByModel);
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
  QODER_MODEL_DISPLAY_NAMES,
  QODER_USAGE_SQL,
  QODER_USAGE_SINCE_SQL,
  buildQoderHistoryGraph,
  buildQoderPeriods,
  collectQoderRows,
  normalizeQoderDbRow,
  qoderDataPaths,
  readQoderDbRows
};
