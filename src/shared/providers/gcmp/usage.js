'use strict';

// AI Chat Models (VS Code extension `vicanent.gcmp`) usage parser.
//
// The extension records every Copilot Chat request it routes through one of
// its configured providers as JSONL, one file per hour under
// <VS Code userData>/globalStorage/vicanent.gcmp/usages/YYYY-MM-DD/HH.jsonl.
// Each requestId is written twice — first a status:"estimated" line without
// rawUsage, then a status:"completed" line carrying the authoritative
// rawUsage — so only completed lines are counted. The same requests also land
// in VS Code's chatSessions, which tokscale counts under the copilot client,
// so this adapter exists as a separate opt-in client rather than a copilot
// supplement: enabling both counts the same requests twice.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const GCMP_EXTENSION_DIR = path.join('globalStorage', 'vicanent.gcmp');
const GCMP_SOURCE_CHECK_ID = 'gcmp-usages';
// A pathological gcmp history must not turn one tick into an unbounded read.
const GCMP_MAX_ROWS = 200_000;

// VS Code resolves its userData dir per platform and variant; remote servers
// (SSH/WSL/containers) keep their own userData under ~/.vscode-server*. A
// missing root is filtered out by the caller's dirExists-style checks. The
// roots returned are the per-hour usages directories the parser and the
// watch list both want.
function gcmpUsagesRoots({ homeDir, platform, env } = {}) {
  const home = homeDir || os.homedir();
  const platformKey = platform || process.platform;
  const envVar = env || process.env;
  const roots = [];
  if (platformKey === 'darwin') {
    const appData = path.join(home, 'Library', 'Application Support');
    roots.push(path.join(appData, 'Code', 'User'));
    roots.push(path.join(appData, 'Code - Insiders', 'User'));
  } else if (platformKey === 'win32') {
    const appData = envVar.APPDATA || path.join(home, 'AppData', 'Roaming');
    roots.push(path.join(appData, 'Code', 'User'));
    roots.push(path.join(appData, 'Code - Insiders', 'User'));
  } else {
    const config = envVar.XDG_CONFIG_HOME || path.join(home, '.config');
    roots.push(path.join(config, 'Code', 'User'));
    roots.push(path.join(config, 'Code - Insiders', 'User'));
  }
  roots.push(path.join(home, '.vscode-server', 'data', 'User'));
  roots.push(path.join(home, '.vscode-server-insiders', 'data', 'User'));
  return roots.map((userDir) => path.join(userDir, GCMP_EXTENSION_DIR, 'usages'));
}

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function sourceNamespace(root) {
  return createHash('sha256').update(path.normalize(String(root || ''))).digest('hex').slice(0, 12);
}

// Display model name, falling back to the id with gcmp's `gcmp.<provider>:::`
// namespace prefix stripped (the prefix is the extension's, not a model name).
function modelLabel(record) {
  const name = String(record.modelName || '').trim();
  if (name) return name;
  return String(record.modelId || '').replace(/^gcmp\.[^.]*:::/, '').trim() || 'unknown';
}

// One row per completed request. Returns null for anything that is not
// countable usage: estimated stubs, missing rawUsage, zero-token records.
function normalizeUsageLine(line, sourceId) {
  let record;
  try {
    record = JSON.parse(line);
  } catch (_) {
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  if (record.status !== 'completed' || !record.rawUsage || typeof record.rawUsage !== 'object') return null;

  const usage = record.rawUsage;
  const input = numberValue(usage.prompt_tokens ?? usage.promptTokens);
  const output = numberValue(usage.completion_tokens ?? usage.completionTokens);
  const cacheRead = numberValue(
    usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cachedTokens
    ?? usage.cache_read_input_tokens
  );
  const reasoning = numberValue(usage.completion_tokens_details?.reasoning_tokens);
  if (input === 0 && output === 0 && cacheRead === 0 && reasoning === 0) return null;

  const timestamp = numberValue(record.timestamp);
  const cost = finiteNumber(record.estimatedCost) ?? numberValue(record.costBreakdown?.total);
  return {
    requestId: String(record.requestId || ''),
    sessionId: `${String(record.sessionId || 'unknown')}@${sourceId}`,
    model: modelLabel(record),
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    reasoning,
    cost,
    createdAt: timestamp
  };
}

// Hour files are named YYYY-MM-DD/HH.jsonl, so a sinceMs anchored to local
// midnight can skip every earlier date directory outright. A non-midnight
// sinceMs still filters per record afterwards.
function usagesFiles(root, sinceMs) {
  let dateDirs;
  try {
    dateDirs = fs.readdirSync(root)
      .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name));
  } catch (_) {
    return [];
  }
  if (sinceMs) {
    const sinceKey = localDateKey(sinceMs);
    if (sinceKey) dateDirs = dateDirs.filter((name) => name >= sinceKey);
  }
  const files = [];
  for (const dateDir of dateDirs.sort()) {
    const dirPath = path.join(root, dateDir);
    let hourFiles;
    try {
      hourFiles = fs.readdirSync(dirPath);
    } catch (_) {
      continue;
    }
    for (const hourFile of hourFiles) {
      if (hourFile.endsWith('.jsonl')) files.push(path.join(dirPath, hourFile));
    }
  }
  return files;
}

// Read every gcmp record exactly once per tick, deduped by requestId across
// roots. Multiple roots only matter for several VS Code variants sharing one
// machine; a completed line always wins because estimated lines never enter
// the map.
function collectGcmpRows(options = {}) {
  const sinceMs = Math.max(0, Number(options.sinceMs || 0));
  const roots = Array.isArray(options.roots) && options.roots.length
    ? options.roots
    : gcmpUsagesRoots({ homeDir: options.homeDir, platform: options.platform, env: options.env });
  const rowsById = new Map();
  let truncated = false;
  for (const root of roots) {
    const sourceId = sourceNamespace(root);
    for (const filePath of usagesFiles(root, sinceMs)) {
      let content;
      try {
        content = String(fs.readFileSync(filePath, 'utf8') || '');
      } catch (_) {
        continue;
      }
      for (const line of content.split(/\r?\n/)) {
        const row = normalizeUsageLine(line.trim(), sourceId);
        if (!row) continue;
        if (rowsById.size >= GCMP_MAX_ROWS) {
          truncated = true;
          break;
        }
        const key = `${row.requestId}\u0000${sourceId}`;
        const existing = rowsById.get(key);
        rowsById.set(key, existing || row);
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  if (truncated && typeof options.logger === 'function') {
    options.logger(`gcmp parse truncated: ${GCMP_MAX_ROWS} row limit reached; older usage is not counted`);
  }
  return [...rowsById.values()];
}

function inWindow(row, startMs, includeUndated) {
  if (!startMs) return true;
  if (row.createdAt) return row.createdAt >= startMs;
  return includeUndated === true;
}

// Same tokscale-shaped JSON the other local adapters emit, consumed by
// extractUsageFromTokscale.
function buildTokscaleJson(startMs, rows, includeUndated = false) {
  const grouped = new Map();
  for (const row of rows) {
    if (!inWindow(row, startMs, includeUndated)) continue;
    const key = `${row.sessionId}\u0000${row.model}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        sessionId: row.sessionId,
        model: row.model,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        messages: 0, cost: 0, startedAt: 0, lastUsedAt: 0
      });
    }
    const group = grouped.get(key);
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.reasoning += row.reasoning;
    group.messages += 1;
    group.cost += row.cost;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
  }

  const entries = [...grouped.values()].map((row) => ({
    client: 'gcmp',
    mergedClients: null,
    sessionId: row.sessionId,
    model: row.model,
    provider: 'gcmp',
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    reasoning: row.reasoning,
    messageCount: row.messages,
    cost: row.cost,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : '',
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : '',
    performance: null
  }));
  const sum = (key) => entries.reduce((total, row) => total + row[key], 0);
  return {
    groupBy: 'client,session,model',
    entries,
    totalInput: sum('input'),
    totalOutput: sum('output'),
    totalCacheRead: sum('cacheRead'),
    totalCacheWrite: sum('cacheWrite'),
    totalMessages: sum('messageCount'),
    totalCost: sum('cost'),
    processingTimeMs: 0
  };
}

function buildGcmpPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return {
    today: buildTokscaleJson(todayStart, rows),
    month: buildTokscaleJson(monthStart, rows),
    allTime: buildTokscaleJson(timestampMs(options.allTimeSince), rows, true)
  };
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Raw graph-compatible contributions for the shared history core, mirroring
// the proma/qodercn adapters.
function buildGcmpHistoryGraph(options = {}) {
  const byDate = new Map();
  for (const row of options.rows || []) {
    const date = row.createdAt ? localDateKey(row.createdAt) : '';
    if (!date) continue;
    let day = byDate.get(date);
    if (!day) {
      day = { date, clients: [] };
      byDate.set(date, day);
    }
    let model = day.clients.find((entry) => entry.modelId === row.model);
    if (!model) {
      model = {
        client: 'gcmp',
        modelId: row.model,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(model);
    }
    model.tokens.input += row.input;
    model.tokens.output += row.output;
    model.tokens.cacheRead += row.cacheRead;
    model.tokens.cacheWrite += row.cacheWrite;
    model.tokens.reasoning += row.reasoning;
    model.cost += row.cost;
    model.messages += 1;
  }
  return { contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

module.exports = {
  GCMP_SOURCE_CHECK_ID,
  gcmpUsagesRoots,
  collectGcmpRows,
  normalizeUsageLine,
  buildGcmpPeriods,
  buildGcmpHistoryGraph,
  buildTokscaleJson
};
