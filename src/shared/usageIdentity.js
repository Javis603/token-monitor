'use strict';

const { canonicalProjectKey } = require('./projectKey');

// Evidence is additive to the existing device contract. A missing, malformed or
// oversized claim never authorizes a deduction from accepted usage.
const { packFixedIdentity, unpackFixedIdentity, PERIODS, MAX_EVENTS, MODEL_FIELDS, ROOT_FIELDS,
  CLIENT_FIELDS, TIMING, SESSION_FIELDS: SESSION_COUNTERS, HISTORY_FIELDS: HISTORY_COUNTERS } = require('./usageIdentityCodec');
const ID = /^sha256:[a-f0-9]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COST_FIELDS = new Set(['cost', 'costUsd', 'clientCosts', 'modelCosts', 'clientModelCosts']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const PERIOD_COUNTERS = [...ROOT_FIELDS, ...TIMING];
const PERIOD_MAPS = [...CLIENT_FIELDS, ...MODEL_FIELDS];
const NESTED_MAPS = ['clientModels', 'clientModelCosts', 'clientModelUnpricedTokens'];

// Validate redundant internal maps before projecting them onto fixed rows. In
// particular, projection must not repair corrupt client/model attribution.
function packUsageIdentity(identity) {
  try {
    if (identity?.version !== 1 || identity.eventIdentityVersion !== 2 || identity.encoding) return null;
    const result = { version: 1, eventIdentityVersion: 2, periods: {} };
    let count = 0;
    const evidence = (value, history = false) => {
      if (!value || !Number.isFinite(Date.parse(value.capturedAt)) || !Array.isArray(value.events)) throw new Error('invalid capture');
      count += value.events.length;
      if (count > MAX_EVENTS) throw new Error('too many claims');
      const ids = new Set();
      return { capturedAt: new Date(value.capturedAt).toISOString(), events: value.events.map(event => {
        const header = eventHeader(event, value.capturedAt);
        if (!header || ids.has(header.id)) throw new Error('invalid event');
        ids.add(header.id);
        if (history) {
          if (!Array.isArray(event.days) || event.days.length > 64) throw new Error('invalid event days');
          const dates = new Set();
          return { ...header, days: event.days.map(day => {
            const usage = normalizedHistoryClaim(day.usage, day.usage);
            if (!DAY.test(day.date) || dates.has(day.date) || !usage) throw new Error('invalid day');
            dates.add(day.date);
            return { date: day.date, usage };
          }) };
        }
        const usage = normalizedPeriodClaim(event.usage, event.usage);
        if (!usage || Object.keys(usage.sessions).some(key => key !== `claude:${header.sessionId || ''}`)) throw new Error('invalid period claim');
        return { ...header, usage };
      }) };
    };
    for (const name of PERIODS) if (own(identity.periods, name)) result.periods[name] = evidence(identity.periods[name]);
    if (identity.history) result.history = evidence(identity.history, true);
    return packFixedIdentity(result);
  } catch { return null; }
}

function numeric(value, key) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('invalid counter');
  if (!/cost/i.test(key) && !Number.isSafeInteger(value)) throw new Error('invalid integer counter');
  return value;
}

function counters(value, fields) {
  const result = Object.create(null);
  for (const key of fields) if (own(value, key)) {
    const count = numeric(value[key], key);
    if (count) result[key] = count;
  }
  return result;
}

function map(value, fields, counterName = '') {
  const result = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > 512 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('invalid map key');
    const next = fields ? counters(entry, fields) : numeric(entry, counterName || key);
    if (typeof next === 'number' ? next > 0 : Object.keys(next).length > 0) result[key] = next;
  }
  return result;
}

function periodCounters(value) {
  const result = counters(value, PERIOD_COUNTERS);
  for (const key of PERIOD_MAPS) result[key] = map(value?.[key], null, key);
  for (const key of NESTED_MAPS) {
    result[key] = Object.create(null);
    for (const [client, models] of Object.entries(value?.[key] || {})) {
      // Counters from non-claiming clients are read only when bounding a claim.
      if (['__proto__', 'constructor', 'prototype'].includes(client)) throw new Error('invalid client');
      result[key][client] = map(models, null, key);
    }
  }
  if (value?.modelThroughput) result.modelThroughput = map(value.modelThroughput, ['timedTokens', 'timedOutputTokens', 'timedDurationMs']);
  result.sessions = map(value?.sessions, SESSION_COUNTERS);
  for (const [key, session] of Object.entries(result.sessions)) {
    session.models = map(value.sessions[key]?.models, null, 'tokens');
    session.modelCosts = map(value.sessions[key]?.modelCosts, null, 'cost');
    session.providers = map(value.sessions[key]?.providers, null, 'tokens');
  }
  result.projects = map(value?.projects, ['tokens', 'costUsd', 'unpricedTokens']);
  for (const [key, project] of Object.entries(result.projects)) project.clients = map(value.projects[key]?.clients, null, 'tokens');
  return result;
}

function historyCounters(value) {
  const result = counters(value, HISTORY_COUNTERS);
  result.perClient = map(value?.perClient, HISTORY_COUNTERS);
  result.perModel = map(value?.perModel, HISTORY_COUNTERS);
  return result;
}

function monthlyCounters(value) {
  const result = historyCounters(value);
  for (const key of HISTORY_COUNTERS) if (!['tokens', 'cost', 'unpricedTokens'].includes(key)) delete result[key];
  for (const row of Object.values(result.perClient)) {
    for (const key of Object.keys(row)) if (!['tokens', 'cost', 'unpricedTokens', 'messages'].includes(key)) delete row[key];
  }
  for (const row of Object.values(result.perModel)) {
    for (const key of Object.keys(row)) if (!['tokens', 'cost', 'unpricedTokens'].includes(key)) delete row[key];
  }
  return result;
}

function availableHistoryComponents(usage, accepted) {
  const fields = ['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens'];
  for (const field of fields) if (!own(accepted, field)) delete usage[field];
  for (const group of ['perClient', 'perModel']) {
    for (const [key, row] of Object.entries(usage[group])) {
      for (const field of fields) if (!own(accepted?.[group]?.[key], field)) delete row[field];
    }
  }
}

function addTree(target, source, cost = false) {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number') target[key] = numeric((target[key] || 0) + value, cost || COST_FIELDS.has(key) ? 'cost' : key);
    else addTree(target[key] ||= Object.create(null), value, cost || COST_FIELDS.has(key));
  }
  return target;
}

function within(claim, accepted, cost = false) {
  return Object.entries(claim).every(([key, value]) => {
    const money = cost || COST_FIELDS.has(key);
    const bound = accepted?.[key] || 0;
    return typeof value === 'number'
      ? value <= bound + (money ? 8 * Number.EPSILON * MAX_EVENTS * Math.max(value, bound) : 0)
      : within(value, bound, money);
  });
}

function copy(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copy);
  const result = Object.create(null);
  for (const [key, entry] of Object.entries(value)) result[key] = copy(entry);
  return result;
}

function deduct(target, claim) {
  for (const [key, value] of Object.entries(claim)) {
    if (typeof value === 'number') {
      if (own(target, key)) target[key] = Math.max(0, target[key] - value);
    } else if (target?.[key] && typeof target[key] === 'object') deduct(target[key], value);
  }
}

function pruneEmptyAttribution(period) {
  for (const field of PERIOD_MAPS) {
    for (const key of Object.keys(period[field] || {})) if (period[field][key] === 0) delete period[field][key];
  }
  for (const field of NESTED_MAPS) {
    for (const [key, models] of Object.entries(period[field] || {})) {
      for (const model of Object.keys(models)) if (models[model] === 0) delete models[model];
      if (!Object.keys(models).length) delete period[field][key];
    }
  }
  for (const [key, row] of Object.entries(period.projects || {})) {
    if (!row.tokens && !row.costUsd && !row.unpricedTokens) delete period.projects[key];
  }
  for (const [key, row] of Object.entries(period.sessions || {})) {
    if (!row.totalTokens && !row.costUsd && !row.unpricedTokens && !row.messageCount) delete period.sessions[key];
  }
  for (const [key, row] of Object.entries(period.modelThroughput || {})) {
    if (!row.timedTokens && !row.timedOutputTokens && !row.timedDurationMs) delete period.modelThroughput[key];
  }
}

function total(mapValue, cost = false) {
  return numeric(Object.values(mapValue || {}).reduce((sum, n) => sum + n, 0), cost ? 'cost' : 'tokens');
}
function equal(a, b) {
  if (Number.isSafeInteger(a || 0) && Number.isSafeInteger(b || 0)) return (a || 0) === (b || 0);
  return a === b || Math.abs((a || 0) - (b || 0)) <= 8 * Number.EPSILON * MAX_EVENTS * Math.max(a || 0, b || 0);
}

function sameCounters(left, right) {
  return [...new Set([...Object.keys(left || {}), ...Object.keys(right || {})])]
    .every(key => equal(left?.[key], right?.[key]));
}

function normalizedPeriodClaim(raw, accepted) {
  const claim = periodCounters(raw);
  // Root-only timing can describe a retained record with unavailable model
  // throughput, but cannot deduct root timing while leaving an exact model map.
  if (accepted?.modelThroughput && !claim.modelThroughput && TIMING.some(field => (claim[field] || 0) > 0)) return null;
  if (!equal(claim.totalTokens, claim.clients.claude) || !equal(claim.costUsd, claim.clientCosts.claude)
    || Object.keys(claim.clients).some(key => key !== 'claude')
    || Object.keys(claim.clientCosts).some(key => key !== 'claude')
    || !equal(claim.totalTokens, total(claim.models)) || !equal(claim.costUsd, total(claim.modelCosts, true))
    || !equal(claim.totalTokens, total(claim.clientModels.claude))
    || !equal(claim.costUsd, total(claim.clientModelCosts.claude, true))) return null;
  if (!sameCounters(claim.models, claim.clientModels.claude)
    || !sameCounters(claim.modelCosts, claim.clientModelCosts.claude)
    || !sameCounters(claim.modelUnpricedTokens, claim.clientModelUnpricedTokens.claude)) return null;
  for (const field of [...PERIOD_MAPS.filter(key => key.startsWith('client')), ...NESTED_MAPS]) {
    if (Object.keys(claim[field]).some(key => key !== 'claude')) return null;
  }
  for (const [scalar, clients, models] of [
    ['cacheReadTokens', 'clientCacheReads', 'modelCacheReads'],
    ['cacheWriteTokens', 'clientCacheWrites', 'modelCacheWrites'],
    ['outputTokens', 'clientOutputs', 'modelOutputs'],
    ['unclassifiedTokens', 'clientUnclassifiedTokens', 'modelUnclassifiedTokens'],
    ['unpricedTokens', 'clientUnpricedTokens', 'modelUnpricedTokens']
  ]) {
    if (!equal(claim[scalar], claim[clients].claude) || !equal(claim[scalar], total(claim[models]))
      || (claim[scalar] || 0) > (claim.totalTokens || 0) || !within(claim[models], claim.models)) return null;
  }
  if (!equal(claim.unpricedTokens, total(claim.clientModelUnpricedTokens.claude))
    || !within(claim.clientModelUnpricedTokens.claude || {}, claim.models)
    || (claim.timedTokens || 0) > (claim.totalTokens || 0)
    || (claim.timedOutputTokens || 0) > (claim.outputTokens || 0)
    || ['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens']
      .reduce((sum, field) => sum + (claim[field] || 0), 0) > (claim.totalTokens || 0)) return null;
  for (const [model, row] of Object.entries(claim.modelThroughput || {})) {
    if ((row.timedTokens || 0) > (claim.models[model] || 0)
      || (row.timedOutputTokens || 0) > (claim.modelOutputs[model] || 0)) return null;
  }
  for (const [model, tokens] of Object.entries(claim.models)) {
    if (['modelCacheReads', 'modelCacheWrites', 'modelOutputs', 'modelUnclassifiedTokens']
      .reduce((sum, field) => sum + (claim[field][model] || 0), 0) > tokens) return null;
  }
  if (claim.modelThroughput) for (const field of ['timedTokens', 'timedOutputTokens', 'timedDurationMs']) {
    if (!equal(claim[field], numeric(Object.values(claim.modelThroughput).reduce((sum, row) => sum + (row[field] || 0), 0), field))) return null;
  }
  for (const [key, session] of Object.entries(claim.sessions)) {
    if (!key.startsWith('claude:') || !equal(session.totalTokens, total(session.models))
      || !equal(session.costUsd, total(session.modelCosts, true))
      || ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
        .reduce((sum, field) => sum + (session[field] || 0), 0) > (session.totalTokens || 0)
      || (session.reasoningTokens || 0) > (session.outputTokens || 0)
      || (session.timedOutputTokens || 0) > (session.outputTokens || 0)
      || !within(session.models, claim.models) || !within(session.modelCosts, claim.modelCosts, true)
      || Object.keys(session.providers).length > 0 && !equal(session.totalTokens, total(session.providers))) return null;
  }
  const representedInput = Object.values(claim.sessions).reduce((sum, session) => sum + (session.inputTokens || 0), 0);
  const eventInput = (claim.totalTokens || 0) - ['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens']
    .reduce((sum, field) => sum + (claim[field] || 0), 0);
  if (representedInput > eventInput) return null;
  for (const project of Object.values(claim.projects)) {
    if (Object.keys(project.clients).some(client => client !== 'claude')
      || !equal(project.tokens, project.clients.claude)) return null;
  }
  for (const [table, fields] of [['sessions', SESSION_COUNTERS], ['projects', ['tokens', 'costUsd', 'unpricedTokens']]]) {
    for (const field of fields.filter(key => !['messageCount', 'inputTokens', 'reasoningTokens'].includes(key))) {
      const count = Object.values(claim[table]).reduce((sum, row) => sum + (row[field] || 0), 0);
      const bound = claim[field === 'tokens' ? 'totalTokens' : field] || 0;
      if (count > bound && !equal(count, bound)) return null;
    }
  }
  // Session/project detail can be deliberately omitted from a bounded upload.
  // Deduct only rows still represented in the accepted record, never synthesize them.
  for (const field of ['sessions', 'projects']) {
    for (const key of Object.keys(claim[field])) if (!own(accepted?.[field], key)) delete claim[field][key];
  }
  return claim;
}

function eventHeader(event, capturedAt) {
  if (!ID.test(event?.id) || !['native', 'mirror'].includes(event.observationKind)) return null;
  if (own(event, 'capturedAt') && (typeof event.capturedAt !== 'string' || event.capturedAt.length > 32
    || !Number.isFinite(Date.parse(event.capturedAt)) || Date.parse(event.capturedAt) > Date.parse(capturedAt))) return null;
  return { id: event.id, observationKind: event.observationKind,
    ...(own(event, 'capturedAt') ? { capturedAt: new Date(event.capturedAt).toISOString() } : {}),
    ...(typeof event.sessionId === 'string' && event.sessionId.length <= 256 ? { sessionId: event.sessionId } : {}) };
}

function residualComponentsFit(tokens, components, claimedTokens, claimedComponents) {
  const remaining = (tokens || 0) - (claimedTokens || 0);
  let known = 0;
  for (const [field, value] of Object.entries(components)) {
    const residual = value - (claimedComponents[field] || 0);
    if (residual < 0) return false;
    known += residual;
  }
  return remaining >= 0 && known <= remaining;
}

function periodResidualFits(claim, accepted) {
  const fields = ['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens'];
  if (!residualComponentsFit(accepted.totalTokens, Object.fromEntries(fields.map(field => [field, accepted[field] || 0])),
    claim.totalTokens, claim)) return false;
  for (const [tokens, maps] of [['clients', ['clientCacheReads', 'clientCacheWrites', 'clientOutputs', 'clientUnclassifiedTokens']],
    ['models', ['modelCacheReads', 'modelCacheWrites', 'modelOutputs', 'modelUnclassifiedTokens']]]) {
    for (const key of Object.keys(claim[tokens] || {})) {
      if (!residualComponentsFit(accepted[tokens]?.[key], Object.fromEntries(maps.map(field => [field, accepted[field]?.[key] || 0])),
        claim[tokens][key], Object.fromEntries(maps.map(field => [field, claim[field]?.[key] || 0])))) return false;
    }
  }
  return true;
}

function historyResidualFits(claim, accepted) {
  const fields = ['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens'];
  const fits = (row, bound) => residualComponentsFit(bound?.tokens,
    Object.fromEntries(fields.filter(field => own(bound, field)).map(field => [field, bound[field]])), row?.tokens, row || {});
  return fits(claim, accepted) && ['perClient', 'perModel'].every(group =>
    Object.entries(claim[group] || {}).every(([key, row]) => fits(row, accepted?.[group]?.[key])));
}

function normalizePeriodEvidence(raw, accepted) {
  if (!raw || !Number.isFinite(Date.parse(raw.capturedAt)) || !Array.isArray(raw.events) || raw.events.length > MAX_EVENTS) return null;
  const ids = new Set();
  const events = [];
  const sum = Object.create(null);
  for (const event of raw.events) {
    const header = eventHeader(event, raw.capturedAt);
    const usage = normalizedPeriodClaim(event?.usage, accepted);
    if (!header || !usage || ids.has(header.id)) return null;
    const sessionKey = `claude:${header.sessionId || ''}`;
    if (Object.keys(event.usage?.sessions || {}).some(key => key !== sessionKey)) return null;
    const project = canonicalProjectKey(accepted?.sessions?.[sessionKey]?.projectLabel);
    if (project && Object.keys(usage.projects).some(key => key !== project)) return null;
    if (accepted?.sessions?.[sessionKey] && !project && Object.keys(usage.projects).length) return null;
    ids.add(header.id);
    addTree(sum, usage);
    events.push({ ...header, usage });
  }
  const bound = periodCounters(accepted);
  // Retained records can keep root timing while deliberately omitting optional
  // model throughput. Keep the claim's internally conserved timing for stable
  // normalize/pack round trips, but never require or create an unavailable map.
  const bounded = { ...sum };
  if (!accepted?.modelThroughput) delete bounded.modelThroughput;
  if (!within(bounded, bound) || !periodResidualFits(sum, bound)) return null;
  return { capturedAt: new Date(raw.capturedAt).toISOString(), events };
}

function normalizedHistoryClaim(value, accepted) {
  const usage = historyCounters(value);
  if (!equal(usage.tokens, usage.perClient.claude?.tokens) || !equal(usage.cost, usage.perClient.claude?.cost)
    || Object.keys(usage.perClient).some(key => key !== 'claude')
    || !equal(usage.tokens, numeric(Object.values(usage.perModel).reduce((sum, row) => sum + (row.tokens || 0), 0), 'tokens'))
    || !equal(usage.cost, numeric(Object.values(usage.perModel).reduce((sum, row) => sum + (row.cost || 0), 0), 'cost'))) return null;
  for (const field of HISTORY_COUNTERS.filter(key => !['tokens', 'cost'].includes(key))) {
    const component = ['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens'].includes(field);
    const rootAvailable = !component || own(accepted, field);
    const clientAvailable = !component || own(accepted?.perClient?.claude, field);
    const modelsAvailable = !component || Object.keys(usage.perModel).every(model => own(accepted?.perModel?.[model], field));
    if (rootAvailable && clientAvailable && !equal(usage[field], usage.perClient.claude?.[field])
      || field !== 'messages' && rootAvailable && modelsAvailable && !equal(usage[field], numeric(Object.values(usage.perModel).reduce((sum, row) => sum + (row[field] || 0), 0), field))
      || field !== 'messages' && (usage[field] || 0) > (usage.tokens || 0)) return null;
  }
  if (['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens']
    .reduce((sum, field) => sum + (usage[field] || 0), 0) > (usage.tokens || 0)) return null;
  for (const row of [...Object.values(usage.perClient), ...Object.values(usage.perModel)]) {
    if (['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens']
      .reduce((sum, field) => sum + (row[field] || 0), 0) > (row.tokens || 0)) return null;
  }
  return usage;
}

function normalizeHistoryEvidence(raw, accepted) {
  if (!accepted || !raw || !Number.isFinite(Date.parse(raw.capturedAt)) || !Array.isArray(raw.events) || raw.events.length > MAX_EVENTS) return null;
  const daily = new Map((accepted.daily || []).map(day => [day.date, day]));
  const monthly = new Map((accepted.monthly || []).map(month => [month.month, month]));
  const ids = new Set();
  const events = [];
  const days = new Map();
  const months = new Map();
  for (const event of raw.events) {
    const header = eventHeader(event, raw.capturedAt);
    if (!header || ids.has(header.id) || !Array.isArray(event.days) || event.days.length > 64) return null;
    ids.add(header.id);
    const rows = [];
    const eventDays = new Set();
    for (const day of event.days) {
      if (!DAY.test(day?.date) || eventDays.has(day.date)) return null;
      eventDays.add(day.date);
      const usage = normalizedHistoryClaim(day.usage, daily.get(day.date) || day.usage);
      if (!usage) return null;
      if (daily.has(day.date)) availableHistoryComponents(usage, daily.get(day.date));
      if (daily.has(day.date)) addTree(days.get(day.date) || (days.set(day.date, Object.create(null)), days.get(day.date)), usage);
      const month = day.date.slice(0, 7);
      addTree(months.get(month) || (months.set(month, Object.create(null)), months.get(month)), usage);
      rows.push({ date: day.date, usage });
    }
    events.push({ ...header, days: rows });
  }
  for (const [date, sum] of days) if (!within(sum, historyCounters(daily.get(date)))
    || !historyResidualFits(sum, daily.get(date))) return null;
  for (const [month, sum] of months) {
    if (!within(monthlyCounters(sum), monthlyCounters(monthly.get(month))) || !historyResidualFits(sum, monthly.get(month))) return null;
  }
  return { capturedAt: new Date(raw.capturedAt).toISOString(), events };
}

function normalizeUsageIdentity(raw, record) {
  if (raw?.version !== 1 || raw.eventIdentityVersion !== 2) return null;
  if (raw.encoding) {
    raw = unpackFixedIdentity(raw);
    if (!raw) return null;
  }
  try {
    const result = { version: 1, eventIdentityVersion: 2, periods: {} };
    for (const name of PERIODS) {
      const evidence = normalizePeriodEvidence(raw.periods?.[name], record.periods?.[name] || record[name]);
      if (evidence) result.periods[name] = evidence;
    }
    const history = normalizeHistoryEvidence(raw.history, record.history);
    if (history) result.history = history;
    const count = Object.values(result.periods).reduce((n, evidence) => n + evidence.events.length, history?.events.length || 0);
    return count <= MAX_EVENTS && (Object.keys(result.periods).length || history) ? result : null;
  } catch { return null; }
}

function preferred(a, b) {
  const nativeA = a.event.observationKind === 'native';
  const nativeB = b.event.observationKind === 'native';
  if (nativeA !== nativeB) return nativeA ? a : b;
  if (a.capturedAt !== b.capturedAt) return a.capturedAt > b.capturedAt ? a : b;
  return a.deviceId.localeCompare(b.deviceId) <= 0 ? a : b;
}

function losers(records, evidenceFor, eligible = () => true) {
  const byId = new Map();
  records.forEach((record, index) => {
    if (!eligible(record)) return;
    const evidence = evidenceFor(record);
    for (const event of evidence?.events || []) {
      const claim = { index, event, capturedAt: event.capturedAt || evidence.capturedAt, deviceId: record.deviceId || String(index) };
      const group = byId.get(event.id) || [];
      group.push(claim); byId.set(event.id, group);
    }
  });
  const result = [];
  for (const group of byId.values()) {
    if (group.length < 2) continue;
    const winner = group.reduce(preferred);
    for (const claim of group) if (claim !== winner) result.push(claim);
  }
  return result;
}

function reconcilePeriodIdentities(records, name, eligible) {
  const result = records.map(record => record.periods[name]);
  const changed = new Set();
  for (const loser of losers(records, record => record.usageIdentity?.periods?.[name], eligible)) {
    if (!changed.has(loser.index)) { result[loser.index] = copy(result[loser.index]); changed.add(loser.index); }
    deduct(result[loser.index], loser.event.usage);
  }
  for (const index of changed) pruneEmptyAttribution(result[index]);
  return result;
}

function reconcileHistoryIdentities(records) {
  const result = records.map(record => record.history);
  const changed = new Set();
  for (const loser of losers(records, record => record.usageIdentity?.history)) {
    if (!changed.has(loser.index)) { result[loser.index] = copy(result[loser.index]); changed.add(loser.index); }
    const history = result[loser.index];
    for (const { date, usage } of loser.event.days) {
      const day = history?.daily?.find(row => row.date === date);
      if (day) deduct(day, usage);
      const month = history?.monthly?.find(row => row.month === date.slice(0, 7));
      if (month) deduct(month, usage);
    }
  }
  return result;
}

module.exports = { packUsageIdentity, normalizeUsageIdentity, reconcilePeriodIdentities, reconcileHistoryIdentities };
