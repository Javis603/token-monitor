'use strict';

const {
  normalizeModelAliases,
  normalizeModelAliasGrouping,
  inferModelAliases,
  createModelAliasResolver
} = require('./renderer/modelAliases');
const { historyRevision, num } = require('../shared/history');

const MODEL_MAP_FIELDS = [
  'models',
  'modelCosts',
  'modelCacheReads',
  'modelCacheWrites',
  'modelOutputs',
  'modelUnclassifiedTokens'
];

// Every projection below hands its input back BY REFERENCE when no alias touches
// it, the way projectLimitStatsForDisplay already does. electronPresentationStats
// runs twice per push (renderer + tray) plus on every tray/refresh site, so one
// alias that matches nothing in this payload must not clone the whole stats tree —
// that is the class of main-thread stall fixed in #143/#144.
function mapValues(value, project) {
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  let result = value;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const row = value[key];
    const projected = project(row);
    if (result !== value) { result[key] = projected; continue; }
    if (projected === row) continue;
    result = {};
    for (let seen = 0; seen < i; seen += 1) result[keys[seen]] = value[keys[seen]];
    result[key] = projected;
  }
  return result;
}

function mapRows(rows, project) {
  let result = rows;
  for (let i = 0; i < rows.length; i += 1) {
    const projected = project(rows[i]);
    if (projected === rows[i]) continue;
    if (result === rows) result = rows.slice();
    result[i] = projected;
  }
  return result;
}

function addModelId(modelIds, value) {
  if (typeof value !== 'string') return;
  const model = value.trim();
  if (model) modelIds.add(model);
}

function addModelMapIds(modelIds, value) {
  if (!value || typeof value !== 'object') return;
  for (const model of Object.keys(value)) addModelId(modelIds, model);
}

function addClientModelIds(modelIds, value) {
  if (!value || typeof value !== 'object') return;
  for (const models of Object.values(value)) addModelMapIds(modelIds, models);
}

function collectUsageModelIds(value, modelIds = new Set()) {
  if (!value || typeof value !== 'object') return modelIds;
  addModelId(modelIds, value.model);
  for (const field of MODEL_MAP_FIELDS) addModelMapIds(modelIds, value[field]);
  for (const field of ['clientModels', 'clientModelCosts']) addClientModelIds(modelIds, value[field]);
  for (const field of ['sessions', 'projects']) {
    for (const row of Object.values(value[field] || {})) collectUsageModelIds(row, modelIds);
  }
  return modelIds;
}

function collectHistoryModelIds(history, modelIds = new Set()) {
  if (!history || typeof history !== 'object') return modelIds;
  for (const field of ['daily', 'monthly']) {
    for (const row of Array.isArray(history[field]) ? history[field] : []) {
      addModelMapIds(modelIds, row?.perModel);
      addClientModelIds(modelIds, row?.clientModelCosts);
    }
  }
  addModelId(modelIds, history.summary?.favoriteModel);
  addClientModelIds(modelIds, history.summary?.clientModelCosts);
  for (const device of Array.isArray(history.deviceHistories) ? history.deviceHistories : []) {
    for (const period of Object.values(device?.periods || {})) collectUsageModelIds(period, modelIds);
    collectHistoryModelIds(device?.history, modelIds);
  }
  return modelIds;
}

function collectStatsModelIds(stats) {
  const modelIds = new Set();
  if (!stats || typeof stats !== 'object') return modelIds;
  for (const period of Object.values(stats.periods || {})) collectUsageModelIds(period, modelIds);
  for (const field of ['today', 'month', 'allTime']) collectUsageModelIds(stats[field], modelIds);
  for (const device of Array.isArray(stats.devices) ? stats.devices : []) {
    for (const period of Object.values(device?.periods || {})) collectUsageModelIds(period, modelIds);
    for (const field of ['today', 'month', 'allTime']) collectUsageModelIds(device?.[field], modelIds);
    collectHistoryModelIds(device?.history, modelIds);
    collectHistoryModelIds(device?.historyPreview, modelIds);
  }
  for (const row of Object.values(stats.allTimeSessionsView || {})) collectUsageModelIds(row, modelIds);
  for (const field of ['nativeSessions', 'nativeProjects']) {
    for (const period of Object.values(stats[field] || {})) {
      for (const row of Object.values(period || {})) collectUsageModelIds(row, modelIds);
    }
  }
  collectHistoryModelIds(stats.history, modelIds);
  collectHistoryModelIds(stats.historyPreview, modelIds);
  return modelIds;
}

function foldModelMap(value, resolve) {
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (!keys.some((model) => resolve(model) !== model)) return value;
  const result = new Map();
  for (const model of keys) {
    const key = resolve(model);
    result.set(key, (result.get(key) || 0) + num(value[model]));
  }
  return Object.fromEntries(result);
}

function foldClientModelMaps(map, resolve) {
  return mapValues(map, (row) => foldModelMap(row, resolve));
}

function projectNestedUsage(map, resolve) {
  return mapValues(map, (row) => projectUsage(row, resolve));
}

// field -> how that field's models are regrouped. Flat rather than grouped so the
// hot loop below stays a plain indexed walk: it runs once per session and per
// project of every period of every device.
const USAGE_PROJECTIONS = [
  ...MODEL_MAP_FIELDS.map((field) => [field, foldModelMap]),
  ['clientModels', foldClientModelMaps],
  ['clientModelCosts', foldClientModelMaps],
  ['sessions', projectNestedUsage],
  ['projects', projectNestedUsage]
];

function projectUsage(value, resolve) {
  if (!value || typeof value !== 'object') return value;
  let result = value;
  if (typeof value.model === 'string') {
    const model = resolve(value.model);
    if (model !== value.model) {
      result = { ...value };
      result.model = model;
    }
  }
  for (let i = 0; i < USAGE_PROJECTIONS.length; i += 1) {
    const field = USAGE_PROJECTIONS[i][0];
    const map = value[field];
    if (!map) continue;
    const projected = USAGE_PROJECTIONS[i][1](map, resolve);
    if (projected === map) continue;
    if (result === value) result = { ...value };
    result[field] = projected;
  }
  return result;
}

function unclassifiedTokens(bucket) {
  if (Object.hasOwn(bucket || {}, 'unclassifiedTokens')) return num(bucket.unclassifiedTokens);
  return bucket?.tokenComponentsAvailable === true ? 0 : num(bucket?.tokens);
}

function mergeHistoryModel(previous, bucket) {
  const merged = { ...previous };
  for (const [field, value] of Object.entries(bucket || {})) {
    if (typeof value === 'number') merged[field] = num(previous?.[field]) + num(value);
    else if (field === 'tokenComponentsAvailable') {
      merged[field] = value === true && previous?.[field] !== false;
    } else if (!Object.hasOwn(merged, field)) {
      merged[field] = value;
    }
  }
  if (previous) {
    merged.unclassifiedTokens = unclassifiedTokens(previous) + unclassifiedTokens(bucket);
  }
  return merged;
}

function projectHistoryRow(row, resolve) {
  if (!row || typeof row !== 'object') return row;
  const regroups = row.perModel && Object.keys(row.perModel).some((model) => resolve(model) !== model);
  const clientModelCosts = row.clientModelCosts
    ? mapValues(row.clientModelCosts, (models) => foldModelMap(models, resolve))
    : row.clientModelCosts;
  if (!regroups && clientModelCosts === row.clientModelCosts) return row;
  const result = { ...row };
  if (regroups) {
    const grouped = new Map();
    for (const [model, bucket] of Object.entries(row.perModel)) {
      const key = resolve(model);
      grouped.set(key, mergeHistoryModel(grouped.get(key), bucket));
    }
    result.perModel = Object.fromEntries(grouped);
  }
  if (row.clientModelCosts) result.clientModelCosts = clientModelCosts;
  return result;
}

function favoriteModel(models) {
  let favorite = '';
  let mostTokens = -1;
  for (const [model, tokens] of Object.entries(models || {})) {
    const value = num(tokens);
    if (value > mostTokens) {
      favorite = model;
      mostTokens = value;
    }
  }
  return favorite;
}

function modelTokenTotals(rows) {
  const totals = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const [model, bucket] of Object.entries(row?.perModel || {})) {
      totals.set(model, (totals.get(model) || 0) + num(bucket?.tokens));
    }
  }
  return Object.fromEntries(totals);
}

function groupedLeader(rows, resolve) {
  const totals = modelTokenTotals(rows);
  if (Object.keys(totals).length === 0) return null;
  return favoriteModel(foldModelMap(totals, resolve));
}

// `summary.favoriteModel` is ranked over a different window depending on who built
// the History, and the producer is not recoverable from the payload — so each call
// site states which it is rather than letting this module guess:
//
//  - 'aggregate': aggregateHistory() -> mergeHistories(), which ranks the grouped
//    leader over its 370-day-CAPPED daily tier. Every complete-history resolution
//    (local / embedded / remote / empty) and every Hub /api/history goes through it,
//    so this one is unambiguous: re-rank over `daily`.
//  - 'device': a posted device record. That is normalizeHistory() — ranked over the
//    UNCAPPED contribution set, i.e. `monthly` — for a device with a single graph
//    source, but mergeHistories() (capped `daily`) for a device that merges several,
//    which collector.js does whenever proma/qoderCn sit alongside tokscale. Not
//    decidable here, so re-rank only when both windows agree on the grouped leader
//    and otherwise keep the stored leader.
//  - 'preview': historyPreview() strips per-model attribution, so there is nothing
//    to re-rank. Rename the stored leader into its group and stop — notably do NOT
//    reach for all-time `models`, whose lifetime ranking is not the window an
//    aggregate preview's summary was ranked over.
//
// In every mode, a window without per-model rows re-ranks nothing: grouping regroups
// what is there, it never invents a leader the attribution cannot support.
function projectedLeader(history, resolve, semantics, renamed) {
  const fromDaily = groupedLeader(history.daily, resolve);
  if (semantics === 'aggregate') return fromDaily === null ? renamed : fromDaily;
  const fromMonthly = groupedLeader(history.monthly, resolve);
  if (fromDaily === null || fromMonthly === null) return fromDaily ?? fromMonthly ?? renamed;
  return fromDaily === fromMonthly ? fromDaily : renamed;
}

function projectSummary(history, resolve, semantics) {
  const summary = history.summary;
  const original = typeof summary.favoriteModel === 'string' ? summary.favoriteModel : '';
  const clientModelCosts = summary.clientModelCosts
    ? mapValues(summary.clientModelCosts, (models) => foldModelMap(models, resolve))
    : summary.clientModelCosts;
  // No leader means no per-model rows anywhere: nothing to re-rank, and inventing
  // one here would fill in a value the producer deliberately left empty.
  const favorite = original
    ? (semantics === 'preview' ? resolve(original) : projectedLeader(history, resolve, semantics, resolve(original)))
    : summary.favoriteModel;
  if (favorite === summary.favoriteModel && clientModelCosts === summary.clientModelCosts) return summary;
  const result = { ...summary };
  result.favoriteModel = favorite;
  if (summary.clientModelCosts) result.clientModelCosts = clientModelCosts;
  return result;
}

function projectHistory(history, resolve, semantics) {
  if (!history || typeof history !== 'object') return history;
  let result = history;
  const set = (field, projected) => {
    if (projected === history[field]) return;
    if (result === history) result = { ...history };
    result[field] = projected;
  };
  for (const field of ['daily', 'monthly']) {
    if (Array.isArray(history[field])) set(field, mapRows(history[field], (row) => projectHistoryRow(row, resolve)));
  }
  if (history.summary) set('summary', projectSummary(history, resolve, semantics));
  if (Array.isArray(history.deviceHistories)) {
    set('deviceHistories', mapRows(history.deviceHistories, (device) => {
      const periods = device.periods ? mapValues(device.periods, (period) => projectUsage(period, resolve)) : device.periods;
      const nested = projectHistory(device.history, resolve, 'device');
      if (periods === device.periods && nested === device.history) return device;
      return {
        ...device,
        ...(device.periods ? { periods } : {}),
        ...(nested === undefined ? {} : { history: nested })
      };
    }));
  }
  return result;
}

// Automatic grouping is opt-in (`modelAliasGrouping`, default 'off'). 'duplicates'
// only acts when two spellings of one model are both present — which is also the case
// where the difference between them can be real, two supply channels for the same
// model billed separately — so it is a choice rather than a default. 'prefix' goes
// further and shortens a provider-qualified name that stands alone. Manual aliases
// are outside the setting: an alias the user typed is always applied.
function aliasPlan(modelIds, aliases, grouping) {
  const explicit = normalizeModelAliases(aliases);
  const automatic = inferModelAliases(modelIds, grouping);
  return {
    explicit,
    automatic,
    active: Object.keys(explicit).length > 0 || Object.keys(automatic).length > 0,
    resolve: createModelAliasResolver(explicit, modelIds, grouping)
  };
}

// Collecting the observed model ids walks the whole payload, so it is skipped
// outright when automatic grouping is off — which is the default path.
function projectModelAliasHistory(history, aliases, options = {}) {
  if (!history || typeof history !== 'object') return history;
  const grouping = normalizeModelAliasGrouping(options.grouping);
  const plan = aliasPlan(grouping === 'off' ? [] : [...collectHistoryModelIds(history)], aliases, grouping);
  return plan.active ? projectHistory(history, plan.resolve, 'aggregate') : history;
}

function projectModelAliasStats(stats, aliases, options = {}) {
  if (!stats || typeof stats !== 'object') return stats;
  const grouping = normalizeModelAliasGrouping(options.grouping);
  const plan = aliasPlan(grouping === 'off' ? [] : [...collectStatsModelIds(stats)], aliases, grouping);
  if (!plan.active) return stats;

  const projectRecord = (record) => {
    let result = record;
    const set = (field, projected) => {
      if (projected === record[field]) return;
      if (result === record) result = { ...record };
      result[field] = projected;
    };
    if (record.periods) set('periods', mapValues(record.periods, (period) => projectUsage(period, plan.resolve)));
    for (const field of ['today', 'month', 'allTime']) {
      if (record[field]) set(field, projectUsage(record[field], plan.resolve));
    }
    // In a stats payload `history` only ever appears on a device record: getStats()
    // puts the aggregate's compact preview at the root and no full history.
    if (record.history) set('history', projectHistory(record.history, plan.resolve, 'device'));
    if (record.historyPreview) set('historyPreview', projectHistory(record.historyPreview, plan.resolve, 'preview'));
    return result;
  };

  const projected = projectRecord(stats);
  // The root always gains modelAliasSourceIds below, so it is the one object this
  // projection cannot hand back by reference; a single shallow copy is the cost.
  const result = projected === stats ? { ...stats } : projected;
  const pricingSourceIds = new Set();
  for (const period of ['today', 'month', 'allTime']) {
    addModelMapIds(pricingSourceIds, stats.periods?.[period]?.models);
    addModelMapIds(pricingSourceIds, stats[period]?.models);
  }
  result.modelAliasSourceIds = [...pricingSourceIds].sort();

  if (Array.isArray(stats.devices)) result.devices = mapRows(stats.devices, projectRecord);
  if (stats.allTimeSessionsView) {
    result.allTimeSessionsView = mapValues(stats.allTimeSessionsView, (session) => projectUsage(session, plan.resolve));
  }
  for (const field of ['nativeSessions', 'nativeProjects']) {
    if (stats[field]) {
      result[field] = mapValues(stats[field], (period) => mapValues(period, (row) => projectUsage(row, plan.resolve)));
    }
  }

  const revision = historyRevision({
    summary: {
      modelAliases: plan.explicit,
      automaticModelAliases: plan.automatic
    }
  });
  // Renderer history caches must invalidate when the grouping changes even if the
  // offline hub/archive revision has not. Raw revisions stay untouched, and an
  // ABSENT revision stays absent: homeHistorySignature() reads emptiness as "no
  // revision available, fall back to the preview payload", so inventing one here
  // would pin Home's signature to a constant and freeze its history for good
  // against a hub that sends no revision.
  for (const field of ['historyRevision', 'deviceHistoryRevision']) {
    if (stats[field]) result[field] = `${stats[field]}:aliases:${revision}`;
  }
  return result;
}

module.exports = {
  normalizeModelAliases,
  normalizeModelAliasGrouping,
  inferModelAliases,
  createModelAliasResolver,
  projectModelAliasStats,
  projectModelAliasHistory
};
