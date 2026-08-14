'use strict';

/**
 * Generic pipeline shared by locally-parsed clients (Proma, DeepSeek Harness,
 * and future JSONL transcript adapters).
 *
 * A local adapter supplies message-level rows and this module turns them into
 * tokscale-shaped JSON, bounded periods, and history-graph contributions tagged
 * with the adapter's client id — the same shapes collector.js merges alongside
 * real tokscale output.
 *
 * Row contract (per message, before window filtering):
 *   {
 *     sessionId: string,
 *     model: string,
 *     input: number, output: number, cacheRead: number, cacheWrite: number,
 *     messages?: number (default 1),
 *     createdAt: number (ms epoch; 0 when undated),
 *     provider?: string,          // per-row provider, falls back to options.provider
 *     startedAt?: number | string, // session start (ms or parseable); defaults to createdAt
 *     lastUsedAt?: number | string, // session last activity; defaults to createdAt
 *     projectId?: string, projectLabel?: string
 *   }
 */

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function rowTotal(row) {
  return row.input + row.output + row.cacheRead + row.cacheWrite;
}

function normalizedModelId(value) {
  return String(value || '').trim().toLowerCase();
}

// Cost is an estimate from a model-price catalog, never a provider invoice.
// Return null rather than silently undercount when a row uses a token category
// whose rate is unavailable (notably cache writes for some custom prices).
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

function windowStartMs(windows) {
  return Math.max(0, timestampMs(windows.todayStart), timestampMs(windows.monthStart), timestampMs(windows.allTimeSince));
}

/**
 * Build a tokscale-compatible JSON object from message-level rows.
 *
 * @param {{ todayStart?: number, monthStart?: number, allTimeSince?: number }} windows
 *        Unix timestamps (ms) for period boundaries.
 * @param {{ client: string, provider?: string, rows?: Array, pricingByModel?: object, includeUndated?: boolean }} options
 * @returns {{ entries: Array, totalInput: number, totalOutput: number, totalCacheRead: number, totalCacheWrite: number, totalMessages: number, totalCost: number }}
 */
function buildTokscaleJson(windows = {}, options = {}) {
  const sinceMs = windowStartMs(windows);
  const entries = [];
  let allInput = 0, allOutput = 0, allCacheRead = 0, allCacheWrite = 0, allMessages = 0, allCost = 0;

  // Filter at message level. Filtering after per-session aggregation would use
  // the session's earliest timestamp and drop today's usage from a session
  // that began before midnight.
  const allRows = (Array.isArray(options.rows) ? options.rows : [])
    .filter((row) => {
      if (!sinceMs) return true;
      if (!row.createdAt) return options.includeUndated === true;
      return row.createdAt >= sinceMs;
    });

  // Keep the source log's stable session id while aggregating streamed
  // messages by model. extractUsageFromTokscale() then merges all model rows
  // for the same session into one period.sessions entry.
  const bySessionModel = new Map();
  for (const row of allRows) {
    const key = row.sessionId + '\u0000' + row.model;
    if (!bySessionModel.has(key)) {
      bySessionModel.set(key, {
        sessionId: row.sessionId,
        model: row.model,
        provider: row.provider || options.provider || options.client,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0,
        startedAt: 0, lastUsedAt: 0,
        projectId: row.projectId || '',
        projectLabel: row.projectLabel || ''
      });
    }
    const entry = bySessionModel.get(key);
    const cost = estimatedRowCost(row, options.pricingByModel);
    entry.input += row.input;
    entry.output += row.output;
    entry.cacheRead += row.cacheRead;
    entry.cacheWrite += row.cacheWrite;
    entry.messages += Number(row.messages || 1);
    entry.cost += cost === null ? 0 : cost;
    const startedAt = timestampMs(row.startedAt) || row.createdAt;
    const lastUsedAt = timestampMs(row.lastUsedAt) || row.createdAt;
    if (startedAt && (!entry.startedAt || startedAt < entry.startedAt)) entry.startedAt = startedAt;
    if (lastUsedAt > entry.lastUsedAt) entry.lastUsedAt = lastUsedAt;
  }

  for (const entry of bySessionModel.values()) {
    entries.push({
      client: options.client,
      mergedClients: null,
      sessionId: entry.sessionId,
      model: entry.model,
      provider: entry.provider,
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite,
      reasoning: 0,
      messageCount: entry.messages,
      cost: entry.cost,
      startedAt: entry.startedAt ? new Date(entry.startedAt).toISOString() : '',
      lastUsedAt: entry.lastUsedAt ? new Date(entry.lastUsedAt).toISOString() : '',
      performance: null,
      ...(entry.projectId ? { projectId: entry.projectId } : {}),
      ...(entry.projectLabel ? { projectLabel: entry.projectLabel } : {})
    });
    allInput += entry.input;
    allOutput += entry.output;
    allCacheRead += entry.cacheRead;
    allCacheWrite += entry.cacheWrite;
    allMessages += entry.messages;
    allCost += entry.cost;
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
  return year + '-' + month + '-' + day;
}

// Return raw graph-compatible contributions so collector.js can merge this
// local adapter with tokscale's graph output through the shared history core.
function buildHistoryGraph(options = {}) {
  const byDate = new Map();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  for (const row of rows) {
    const date = row.createdAt ? localDateKey(row.createdAt) : '';
    if (!date) continue; // an undated row cannot be truthfully placed on a day
    let day = byDate.get(date);
    if (!day) {
      day = { date, clients: [] };
      byDate.set(date, day);
    }
    const modelId = normalizedModelId(row.model) || 'unknown';
    let client = day.clients.find((entry) => entry.modelId === modelId);
    if (!client) {
      client = {
        client: options.client,
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
    client.messages += Number(row.messages || 1);
  }
  return { contributions: [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)) };
}

/**
 * Compute local midnight for today and month start, then build
 * tokscale-compatible JSON.
 *
 * @param {{ client: string, provider?: string, now?: Date | number | string, allTimeSince?: number | string, rows?: Array, pricingByModel?: object }} options
 */
function buildPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const buildOptions = { client: options.client, provider: options.provider, rows, pricingByModel: options.pricingByModel };
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();

  return {
    today: buildTokscaleJson({ todayStart }, buildOptions),
    month: buildTokscaleJson({ monthStart }, buildOptions),
    allTime: buildTokscaleJson({ allTimeSince: options.allTimeSince }, { ...buildOptions, includeUndated: true })
  };
}

module.exports = {
  buildHistoryGraph,
  buildPeriods,
  buildTokscaleJson,
  estimatedRowCost,
  normalizedModelId,
  numberValue,
  rowTotal,
  timestampMs,
  windowStartMs
};
