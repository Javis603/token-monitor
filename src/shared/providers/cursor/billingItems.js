'use strict';

// Grok's usage page lists Cursor included calls that the older cursor.com
// usage-event export no longer returns. Rows are the normalized billing items
// already stored by the Electron session; this module only turns those token
// counts into Cursor usage and keeps them out of any window the tokscale
// cache already covers.

const { localDayKey, normalizeTokscaleModelNameForClient } = require('../../history');
const { extractUsageFromTokscale, mergePeriods } = require('../../usage');

const BILLING_ITEMS_URL = 'https://grok.com/dashboard/api/dashboard/v2/query-billing-items';

function tokenCount(value) {
  const parsed = (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim())))
    ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid Cursor billing token count');
  return parsed;
}

function usageObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function field(source, names) {
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null && source[name] !== '') return source[name];
  }
  return 0;
}

function billingItemRow(item) {
  if (!item || typeof item !== 'object') return null;
  const product = String(item.product || item.Product || '').trim().toLowerCase();
  if (product !== 'cursor') return null;
  const model = normalizeTokscaleModelNameForClient(item.displayExtras?.model || item.model || item.Model || '', 'cursor');
  const eventTime = Date.parse(item.eventTime || item.event_time || item.timestamp || item['Event Time']);
  if (!model || !Number.isFinite(eventTime) || eventTime <= 0) return null;
  const usage = usageObject(item.usage || item.Usage);
  const inputTokens = tokenCount(field(usage, ['prompt-text-tokens', 'promptTextTokens', 'inputTokens']));
  const cacheReadTokens = tokenCount(field(usage, ['cached-prompt-text-tokens', 'cachedPromptTextTokens', 'cacheReadTokens']));
  const cacheWriteTokens = tokenCount(field(usage, ['cache-write-text-tokens', 'cacheWriteTextTokens', 'cacheWriteTokens']));
  const outputTokens = tokenCount(field(usage, ['completion-text-tokens', 'completionTextTokens', 'outputTokens']));
  const totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens)) throw new Error('Invalid Cursor billing token total');
  if (totalTokens <= 0) return null;
  const id = String(item.id || item.billingItemId || item['Billing Item ID'] || '');
  return { ...(id ? { id } : {}), eventTime, model, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens };
}

function billingRowKey(row) {
  return row.id || `${row.eventTime}:${row.model}:${row.inputTokens}:${row.cacheReadTokens}:${row.cacheWriteTokens}:${row.outputTokens}`;
}

function rowsFromBillingPayload(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload?.items || payload?.billingItems || payload?.rows || payload?.data || [];
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const rows = [];
  for (const item of list) {
    const id = String(item?.id || item?.billingItemId || item?.['Billing Item ID'] || '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const row = billingItemRow(item);
    if (row) rows.push(row);
  }
  return rows;
}

function nextPageToken(payload) {
  if (payload?.pagination?.hasMore === false) return '';
  const token = payload?.pagination?.nextCursor || payload?.nextPageToken || payload?.nextCursor || '';
  return typeof token === 'string' && token.trim() ? token.trim() : '';
}

function rowsInRange(rows, startMs, endMs) {
  return rows.filter((row) => row.eventTime >= startMs && row.eventTime < endMs);
}

// Same catalog-rate estimate native Cursor rows get from tokscale. Included
// billed $0 stays off the headline; missing rates stay unpriced, not $0.
function estimatedCost(usage, pricing) {
  if (!pricing) return { cost: 0, unpricedTokens: usage.total || 0 };
  let cost = 0;
  let unpricedTokens = 0;
  for (const [field, rate] of [
    ['input', 'inputCostPerToken'], ['cacheRead', 'cacheReadInputTokenCost'],
    ['cacheWrite', 'cacheCreationInputTokenCost'], ['output', 'outputCostPerToken']
  ]) {
    if (!usage[field]) continue;
    if (!Number.isFinite(pricing[rate]) || pricing[rate] < 0) unpricedTokens += usage[field];
    else cost += usage[field] * pricing[rate];
  }
  return { cost, unpricedTokens };
}

function pricedBillingEntry(row, pricingByModel) {
  const estimate = estimatedCost({
    input: row.inputTokens,
    cacheRead: row.cacheReadTokens,
    cacheWrite: row.cacheWriteTokens,
    output: row.outputTokens,
    total: row.totalTokens
  }, row.priceable === false ? null : pricingByModel?.[String(row.model || '').toLowerCase()] || null);
  return {
    client: 'cursor',
    model: row.model,
    totalTokens: row.totalTokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    cost: estimate.cost,
    ...(estimate.unpricedTokens > 0 ? { unpricedTokens: estimate.unpricedTokens } : {})
  };
}

function periodFromBillingRows(rows, pricingByModel) {
  if (!rows.length) return null;
  const period = extractUsageFromTokscale(rows.map((row) => pricedBillingEntry(row, pricingByModel)));
  return period.totalTokens > 0 ? period : null;
}

function startOfLocalDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

function startOfLocalMonth(date) {
  const copy = new Date(date);
  copy.setDate(1);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

function billingHistoryGraph(rows, pricingByModel) {
  const days = new Map();
  for (const row of rows) {
    const date = localDayKey(new Date(row.eventTime));
    if (!days.has(date)) days.set(date, { date, clients: [] });
    const estimate = estimatedCost({
      input: row.inputTokens, cacheRead: row.cacheReadTokens,
      cacheWrite: row.cacheWriteTokens, output: row.outputTokens, total: row.totalTokens
    }, row.priceable === false ? null : pricingByModel?.[String(row.model || '').toLowerCase()] || null);
    days.get(date).clients.push({
      client: 'cursor', modelId: row.model, cost: estimate.cost, messages: 1,
      ...(estimate.unpricedTokens > 0 ? { unpricedTokens: estimate.unpricedTokens } : {}),
      tokens: { input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens, cacheWrite: row.cacheWriteTokens }
    });
  }
  return { contributions: [...days.values()] };
}

function supplementCursorBilling(state, rows, now, pricingByModel) {
  const todayStart = startOfLocalDay(now);
  const tomorrow = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const todayExtra = periodFromBillingRows(rowsInRange(rows, todayStart, tomorrow.getTime()), pricingByModel);
  if (state.mode === 'anchor') {
    if (!todayExtra) return state;
    const todayPartitions = { ...(state.todayPartitions || {}) };
    todayPartitions.cursor = mergePeriods(todayPartitions.cursor, todayExtra);
    return { ...state, todayPartitions };
  }
  const monthExtra = periodFromBillingRows(rowsInRange(rows, startOfLocalMonth(now), Number.POSITIVE_INFINITY), pricingByModel);
  const allExtra = periodFromBillingRows(rows, pricingByModel);
  if (!todayExtra && !monthExtra && !allExtra) return state;
  return {
    ...state,
    today: todayExtra ? mergePeriods(state.today, todayExtra) : state.today,
    month: monthExtra ? mergePeriods(state.month, monthExtra) : state.month,
    allTime: allExtra ? mergePeriods(state.allTime, allExtra) : state.allTime,
    todayPartitions: todayExtra ? {
      ...(state.todayPartitions || {}),
      cursor: mergePeriods(state.todayPartitions?.cursor, todayExtra)
    } : state.todayPartitions
  };
}

module.exports = {
  BILLING_ITEMS_URL,
  pricedBillingEntry,
  billingHistoryGraph,
  billingRowKey,
  nextPageToken,
  rowsFromBillingPayload,
  supplementCursorBilling
};
