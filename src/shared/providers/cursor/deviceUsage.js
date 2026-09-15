'use strict';

const fs = require('node:fs');
const { cursorDeviceLogPath } = require('./deviceHook');

function normalizeCursorUsageSource(value, fallback = 'account') {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'device' || raw === 'account') return raw;
  return fallback === 'device' ? 'device' : 'account';
}

function isCursorDeviceUsage(value) {
  return normalizeCursorUsageSource(value) === 'device';
}

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function normalizedModelId(value) {
  return String(value || '').trim().toLowerCase();
}

function splitInclusiveInput(record) {
  const inputInclusive = numberValue(record.input_tokens);
  const cacheRead = numberValue(record.cache_read_tokens);
  const cacheWrite = numberValue(record.cache_write_tokens);
  const output = numberValue(record.output_tokens);
  const uncached = inputInclusive >= cacheRead + cacheWrite
    ? inputInclusive - cacheRead - cacheWrite
    : inputInclusive;
  return { input: uncached, cacheRead, cacheWrite, output };
}

function recordId(record) {
  return String(record.generation_id || record.subagent_id || `${record.event || 'stop'}:${record.ts}:${record.model || ''}`);
}

function estimatedRowCost(row, pricingByModel) {
  const pricing = pricingByModel?.[normalizedModelId(row.model)];
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

function collectCursorDeviceRows(options = {}) {
  const logPath = options.logPath || cursorDeviceLogPath(options);
  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const byId = new Map();
  const order = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch (_) { continue; }
    if (!rec || rec.v !== 1) continue;
    const model = String(rec.model || '').trim();
    const createdAt = timestampMs(rec.ts);
    if (!model || !createdAt) continue;
    const tokens = splitInclusiveInput(rec);
    if (tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output === 0) continue;
    const id = recordId(rec);
    const row = {
      id,
      sessionId: String(rec.conversation_id || rec.generation_id || rec.subagent_id || id).trim(),
      model,
      createdAt,
      projectLabel: String(rec.project || '').trim(),
      ...tokens
    };
    if (!byId.has(id)) order.push(id);
    byId.set(id, row);
  }
  return order.map((id) => byId.get(id));
}

function sinceMsFromCutoff(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildTokscaleJson(window, options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : collectCursorDeviceRows(options);
  const sinceMs = window?.todayStart || window?.monthStart || sinceMsFromCutoff(window?.allTimeSince);
  const includeUndated = options.includeUndated === true;
  const entries = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalMessages = 0;
  let totalCost = 0;

  const selected = rows.filter((row) => {
    if (!sinceMs) return true;
    if (!row.createdAt) return includeUndated;
    return row.createdAt >= sinceMs;
  });

  const bySessionModel = new Map();
  for (const row of selected) {
    const key = `${row.sessionId || 'unknown'}\u0000${row.model}`;
    if (!bySessionModel.has(key)) {
      bySessionModel.set(key, {
        sessionId: row.sessionId || 'unknown',
        model: row.model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        messages: 0,
        cost: 0,
        startedAt: 0,
        lastUsedAt: 0,
        projectLabel: row.projectLabel || ''
      });
    }
    const group = bySessionModel.get(key);
    const cost = estimatedRowCost(row, options.pricingByModel);
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.messages += 1;
    group.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
    if (!group.projectLabel && row.projectLabel) group.projectLabel = row.projectLabel;
  }

  for (const group of bySessionModel.values()) {
    entries.push({
      client: 'cursor',
      mergedClients: null,
      sessionId: group.sessionId,
      model: group.model,
      provider: 'cursor',
      input: group.input,
      output: group.output,
      cacheRead: group.cacheRead,
      cacheWrite: group.cacheWrite,
      reasoning: 0,
      messageCount: group.messages,
      cost: group.cost,
      startedAt: group.startedAt ? new Date(group.startedAt).toISOString() : '',
      lastUsedAt: group.lastUsedAt ? new Date(group.lastUsedAt).toISOString() : '',
      projectLabel: group.projectLabel || '',
      performance: null
    });
    totalInput += group.input;
    totalOutput += group.output;
    totalCacheRead += group.cacheRead;
    totalCacheWrite += group.cacheWrite;
    totalMessages += group.messages;
    totalCost += group.cost;
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

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildCursorDeviceHistoryGraph(options = {}) {
  const byDate = new Map();
  const rows = Array.isArray(options.rows) ? options.rows : collectCursorDeviceRows(options);
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
        client: 'cursor',
        modelId,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(client);
    }
    const cost = estimatedRowCost(row, options.pricingByModel);
    client.tokens.input += row.input;
    client.tokens.output += row.output;
    client.tokens.cacheRead += row.cacheRead;
    client.tokens.cacheWrite += row.cacheWrite;
    client.cost += cost === null ? 0 : cost;
    client.messages += 1;
  }
  return { contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

function buildCursorDevicePeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : collectCursorDeviceRows(options);
  const buildOptions = { rows, pricingByModel: options.pricingByModel };
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
  return {
    today: buildTokscaleJson({ todayStart }, buildOptions),
    month: buildTokscaleJson({ monthStart }, buildOptions),
    allTime: buildTokscaleJson({ allTimeSince: options.allTimeSince }, { ...buildOptions, includeUndated: true })
  };
}

module.exports = {
  buildCursorDeviceHistoryGraph,
  buildCursorDevicePeriods,
  buildTokscaleJson,
  collectCursorDeviceRows,
  cursorDeviceLogPath,
  estimatedRowCost,
  isCursorDeviceUsage,
  normalizeCursorUsageSource
};
