'use strict';

/**
 * CCSwitch session usage parser.
 *
 * Reads request logs from ~/.cc-switch/cc-switch.db (or %APPDATA%/ccswitch/...)
 * and aggregates token usage reported in `proxy_request_logs` table.
 * Returns data shaped like a tokscale JSON response so it can be fed
 * directly into extractUsageFromTokscale or merged alongside tokscale
 * results.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

function defaultCcswitchDirs() {
  const home = os.homedir();
  return [
    path.join(home, '.cc-switch'),
    path.join(home, '.cc-switch', 'logs'),
    path.join(home, '.cc-switch', 'sessions'),
    path.join(home, '.ccswitch'),
    path.join(home, '.ccswitch', 'logs'),
    path.join(home, 'AppData', 'Roaming', 'ccswitch', 'logs'),
    path.join(home, 'AppData', 'Local', 'ccswitch', 'logs'),
    path.join(home, '.config', 'ccswitch')
  ];
}

function findCcswitchDbPath(customDirs = null) {
  const dirs = customDirs || defaultCcswitchDirs();
  for (const d of dirs) {
    const candidate = d.endsWith('cc-switch.db') ? d : path.join(d, 'cc-switch.db');
    if (fs.existsSync(candidate)) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (_) {}
    }
  }
  const defaultDb = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  if (fs.existsSync(defaultDb)) {
    try {
      if (fs.statSync(defaultDb).isFile()) return defaultDb;
    } catch (_) {}
  }
  return null;
}

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function normalizedModelId(value) {
  return String(value || '').trim().toLowerCase();
}

function sourceNamespace(dbPath) {
  return createHash('sha256').update(path.normalize(String(dbPath || ''))).digest('hex').slice(0, 12);
}

function collectCcswitchRows(options = {}) {
  const dbPath = options.dbPath || findCcswitchDbPath(options.dirs);
  if (!dbPath) return [];

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT request_id, provider_id, app_type, model, request_model,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             total_cost_usd, latency_ms, status_code, created_at, session_id
      FROM proxy_request_logs
      ORDER BY created_at ASC
    `).all();
    db.close();

    const sourceId = sourceNamespace(dbPath);
    const collected = [];
    const skipOfficial = options.includeOfficial !== true;
    const OFFICIAL_OR_NATIVE_PATTERNS = [
      'official', 'codex', '_codex_', 'claude', 'copilot', 'openai', 'anthropic',
      'github', 'chatgpt', 'opencode', '_opencode_', 'cursor', 'antigravity', 'agy'
    ];

    for (const r of rows) {
      const providerStr = normalizedModelId(r.provider_id);
      const appTypeStr = normalizedModelId(r.app_type);
      const sessionStr = normalizedModelId(r.session_id);

      const isOfficialOrNative = OFFICIAL_OR_NATIVE_PATTERNS.some(
        (pat) =>
          providerStr.includes(pat) ||
          appTypeStr.includes(pat) ||
          sessionStr.includes(pat)
      );
      if (skipOfficial && isOfficialOrNative) {
        continue;
      }

      const rawSessionId = r.session_id || r.provider_id || 'ccswitch_db_session';
      const sessionId = `${rawSessionId}@${sourceId}`;
      const model = r.model || r.request_model || 'ccswitch';
      const input = numberValue(r.input_tokens);
      const output = numberValue(r.output_tokens);
      const cacheRead = numberValue(r.cache_read_tokens);
      const cacheWrite = numberValue(r.cache_creation_tokens);
      const cost = numberValue(r.total_cost_usd);
      const createdAt = timestampMs(r.created_at);

      collected.push({
        sessionId,
        model,
        provider: r.provider_id || 'ccswitch',
        appType: r.app_type || 'ccswitch',
        input,
        output,
        cacheRead,
        cacheWrite,
        cost,
        createdAt,
        messages: 1
      });
    }

    return collected;
  } catch (_) {
    return [];
  }
}

function windowStartMs(windows) {
  return Math.max(0, timestampMs(windows.todayStart), timestampMs(windows.monthStart), timestampMs(windows.allTimeSince));
}

function buildTokscaleJson(windows = {}, options = {}) {
  const sinceMs = windowStartMs(windows);
  const entries = [];
  let allInput = 0, allOutput = 0, allCacheRead = 0, allCacheWrite = 0, allMessages = 0, allCost = 0;

  const allRows = (Array.isArray(options.rows) ? options.rows : collectCcswitchRows(options))
    .filter((row) => {
      if (!sinceMs) return true;
      if (!row.createdAt) return options.includeUndated === true;
      return row.createdAt >= sinceMs;
    });

  const bySessionModel = new Map();
  for (const row of allRows) {
    const key = `${row.sessionId || 'unknown'}\u0000${row.model}`;
    if (!bySessionModel.has(key)) {
      bySessionModel.set(key, {
        sessionId: row.sessionId || 'unknown',
        model: row.model,
        provider: row.provider || 'ccswitch',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        messages: 0,
        cost: 0,
        startedAt: 0,
        lastUsedAt: 0
      });
    }
    const m = bySessionModel.get(key);
    m.input += row.input;
    m.output += row.output;
    m.cacheRead += row.cacheRead;
    m.cacheWrite += row.cacheWrite;
    m.messages += Number(row.messages || 1);
    m.cost += row.cost;
    if (row.createdAt && (!m.startedAt || row.createdAt < m.startedAt)) m.startedAt = row.createdAt;
    if (row.createdAt > m.lastUsedAt) m.lastUsedAt = row.createdAt;
  }

  for (const m of bySessionModel.values()) {
    entries.push({
      client: 'ccswitch',
      mergedClients: null,
      sessionId: m.sessionId,
      model: m.model,
      provider: m.provider,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      totalTokens: m.input + m.output,
      reasoning: 0,
      messageCount: m.messages,
      cost: m.cost,
      startedAt: m.startedAt ? new Date(m.startedAt).toISOString() : '',
      lastUsedAt: m.lastUsedAt ? new Date(m.lastUsedAt).toISOString() : '',
      performance: null
    });
    allInput += m.input;
    allOutput += m.output;
    allCacheRead += m.cacheRead;
    allCacheWrite += m.cacheWrite;
    allMessages += m.messages;
    allCost += m.cost;
  }

  return {
    groupBy: 'client,session,model',
    entries,
    totalInput: allInput,
    totalOutput: allOutput,
    totalCacheRead: allCacheRead,
    totalCacheWrite: allCacheWrite,
    totalMessages: allMessages,
    totalCost: allCost,
    processingTimeMs: 0
  };
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildCcswitchHistoryGraph(options = {}) {
  const byDate = new Map();
  const rows = Array.isArray(options.rows) ? options.rows : collectCcswitchRows(options);
  for (const row of rows) {
    const date = row.createdAt ? localDateKey(row.createdAt) : '';
    if (!date) continue;
    let day = byDate.get(date);
    if (!day) {
      day = { date, clients: [] };
      byDate.set(date, day);
    }
    const modelId = normalizedModelId(row.model) || 'unknown';
    let client = day.clients.find((entry) => entry.modelId === modelId);
    if (!client) {
      client = {
        client: 'ccswitch',
        modelId,
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
    client.cost += row.cost;
    client.messages += 1;
  }
  return { contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

function buildCcswitchPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : collectCcswitchRows(options);
  const buildOptions = { rows };
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();

  return {
    today: buildTokscaleJson({ todayStart }, buildOptions),
    month: buildTokscaleJson({ monthStart }, buildOptions),
    allTime: buildTokscaleJson({ allTimeSince: options.allTimeSince }, { ...buildOptions, includeUndated: true })
  };
}

module.exports = {
  defaultCcswitchDirs,
  findCcswitchDbPath,
  collectCcswitchRows,
  buildTokscaleJson,
  buildCcswitchHistoryGraph,
  buildCcswitchPeriods
};
