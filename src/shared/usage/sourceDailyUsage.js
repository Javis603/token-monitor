'use strict';

const { extractUsageFromTokscale, mergePeriods, emptyPeriod, normalizePeriod, normalizeClientName, normalizeModelNameForClient, applyProjectRollups, UNATTRIBUTED_USAGE_CLIENT } = require('../usage');
const { isDeepStrictEqual } = require('node:util');
const SESSION_METADATA_FIELDS = ['title', 'projectId', 'projectLabel', 'sessionKind', 'nativeSessionId', 't3ThreadId', 'startedAt', 'lastUsedAt',
  'contextTokens', 'contextWindow', 'turnEnded', 'waitingForInput', 'promptCache', 'liveActivity'];
const { legacyAllocationMatches, legacySessionAccounting, largerLegacyPeriod, rebucketSourceUsage } = require('./sourceLedger');
const { addArchivedSession } = require('./sessionUsageArchive');
const periodCache = new WeakMap();

function copySessionMetadata(row, prior) {
  if (!prior) return;
  for (const field of SESSION_METADATA_FIELDS) if (prior[field] !== undefined) row[field] = prior[field];
  if (prior.parentSessionId) {
    row.parentSessionId = prior.parentSessionId;
    if (prior.parentClient && prior.parentClient !== row.client) row.parentClient = prior.parentClient;
    else delete row.parentClient;
  }
}
function accountingMatches(current, previous) {
  return current && previous && ['totalTokens', 'costUsd', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'models', 'modelCosts']
    .every(field => isDeepStrictEqual(current[field], previous[field]));
}
function carryMatchingPerformance(period, native) {
  const keys = Object.keys(period.sessions);
  if (!accountingMatches(period, native) || !isDeepStrictEqual(keys.sort(), Object.keys(native?.sessions || {}).sort())
    || keys.some(key => !accountingMatches(period.sessions[key], native.sessions[key]))) {
    if (period.totalTokens > 0) { period.capabilities.throughput = false; delete period.modelThroughput; }
    return;
  }
  for (const key of keys) {
    period.sessions[key].timedDurationMs = native.sessions[key].timedDurationMs;
    period.sessions[key].timedOutputTokens = native.sessions[key].timedOutputTokens;
  }
  for (const field of ['timedTokens', 'timedOutputTokens', 'timedDurationMs', 'modelThroughput']) {
    if (native[field] !== undefined) period[field] = native[field];
  }
  period.capabilities.throughput = native.capabilities.throughput;
}
function inWindow(date, name, today, since, pastOnly) {
  return date <= today && (!pastOnly || date < today) && (name === 'today' ? date === today
    : name === 'month' ? date.slice(0, 7) === today.slice(0, 7) : !since || date >= since);
}
function snapshotPeriod(sourceUsage, snapshot, name, today, since, pastOnly = false) {
  let cache = periodCache.get(sourceUsage);
  if (!cache || cache.today !== today || cache.since !== since) {
    cache = { today, since, rows: new WeakMap() };
    periodCache.set(sourceUsage, cache);
  }
  let rowCache = cache.rows.get(snapshot);
  if (!rowCache) { rowCache = new Map(); cache.rows.set(snapshot, rowCache); }
  const key = `${name}:${pastOnly}`;
  if (!rowCache.has(key)) {
    const entries = (snapshot.days || []).filter(day => inWindow(day.date, name, today, since, pastOnly))
      .flatMap(day => (day.clients || []).map(row => ({ client: snapshot.client, sessionId: snapshot.sessionId,
        model: row.modelId, provider: row.providerId, input: row.tokens?.input, output: row.tokens?.output,
        cacheRead: row.tokens?.cacheRead, cacheWrite: row.tokens?.cacheWrite, reasoning: row.tokens?.reasoning,
        cost: row.cost, messages: row.messages,
        ...(row.pricing ? { pricing: row.pricing } : {}),
        ...(row.unpricedTokens !== undefined ? { unpricedTokens: row.unpricedTokens } : {}),
        ...(row.performance ? { performance: row.performance } : {}) })));
    rowCache.set(key, extractUsageFromTokscale({ entries }));
  }
  return structuredClone(rowCache.get(key));
}
function legacyDayPeriod(day) {
  const observations = Object.values(day.observations || {});
  const entries = observations.map(row => ({ client: row.client, model: row.modelId,
      provider: row.providerId, totalTokens: row.tokens,
      output: row.outputTokens || 0, cacheRead: row.cacheReadTokens || 0, cacheWrite: row.cacheWriteTokens || 0,
      cost: row.cost, messages: row.messages,
      ...(row.unpricedTokens > 0 ? { unpricedTokens: row.unpricedTokens } : {}) }));
  let period = extractUsageFromTokscale({ entries });
  for (const row of observations) {
    const remaining = Math.max(0, row.tokens - (row.outputTokens || 0) - (row.cacheReadTokens || 0) - (row.cacheWriteTokens || 0));
    const unclassified = Math.min(remaining, row.unclassifiedTokens ?? (row.tokenComponentsAvailable === true ? 0 : remaining));
    if (row.tokens > 0 && row.tokenComponentsAvailable !== true) period.capabilities.tokenComponents = false;
    if (!unclassified) continue;
    const client = normalizeClientName(row.client), model = normalizeModelNameForClient(row.modelId, client);
    period.unclassifiedTokens += unclassified;
    period.clientUnclassifiedTokens[client] = (period.clientUnclassifiedTokens[client] || 0) + unclassified;
    period.modelUnclassifiedTokens[model] = (period.modelUnclassifiedTokens[model] || 0) + unclassified;
  }
  const components = day.componentSummary;
  if (components) {
    period.capabilities.tokenComponents = components.tokenComponentsAvailable === true;
    for (const [field, byClient, byModel] of [['cacheReadTokens', 'clientCacheReads', 'modelCacheReads'],
      ['cacheWriteTokens', 'clientCacheWrites', 'modelCacheWrites'], ['outputTokens', 'clientOutputs', 'modelOutputs'],
      ['unclassifiedTokens', 'clientUnclassifiedTokens', 'modelUnclassifiedTokens']]) {
      period[field] = components[field] || 0;
      period[byClient] = Object.fromEntries(Object.entries(components.perClient || {}).map(([key, row]) => [key, row[field] || 0]));
      period[byModel] = Object.fromEntries(Object.entries(components.perModel || {}).map(([key, row]) => [key, row[field] || 0]));
    }
  }
  // Allocation describes this selected day; it contributes no second total.
  const allocation = emptyPeriod();
  for (const [key, row] of Object.entries(legacySessionAccounting(day.sessionAllocation))) addArchivedSession(allocation, row, key);
  period = normalizePeriod(period);
  if (legacyAllocationMatches(period, allocation, Math.max(observations.length, Object.keys(allocation.sessions).length))) period.sessions = allocation.sessions;
  return period;
}
function aggregatePeriod(days, name, today, since, nativeToday) {
  const selected = days.filter(day => inWindow(day.date, name, today, since, false));
  const periods = selected.map(day => {
    const period = legacyDayPeriod(day);
    return day.date === today && nativeToday && largerLegacyPeriod({ period: nativeToday }, { period }, 'allTime')
      ? nativeToday : period;
  });
  // A healthy native Today is an exact window observation even if the last
  // full scan had no usage today. It never allocates an undated lifetime floor.
  if (nativeToday && inWindow(today, name, today, since, false) && !selected.some(day => day.date === today)) periods.push(nativeToday);
  return mergePeriods(...periods);
}

// Ownership is permanent, independent of this tick's read health and calendar.
// Full ticks always use accepted accounting, including partial native scans.
// Watch ticks retain the native exact delta until equivalent window proof exists.
function applySourceDailyUsage(summary, sourceUsage, options = {}) {
  if (sourceUsage?.version !== 2 || sourceUsage.accountingOwner !== 'app' || !Array.isArray(sourceUsage.sessions)) return;
  const selected = options.clients === undefined ? null : new Set(String(options.clients).split(',').map(normalizeClientName).filter(Boolean));
  const rawOwners = new Set((sourceUsage.ownedClients || []).filter(client => !selected || selected.has(normalizeClientName(client))));
  const owners = new Set([...rawOwners].map(normalizeClientName));
  const source = summary.sessionArchiveSource ||= {};
  // The domain boundary includes IDs unknown to this projection and zero IDs.
  source.ownedClients = [...owners];
  source.boundaryCheckedClients = [...new Set((sourceUsage.scopes || []).filter(scope => scope.mode === 'legacy' || scope.retainedBoundaryChecked === true)
    .flatMap(scope => scope.clients).map(normalizeClientName))];
  source.legacyClients = [...new Set((sourceUsage.scopes || []).filter(scope => scope.mode === 'legacy')
    .flatMap(scope => scope.clients).map(normalizeClientName))];
  source.managedKeys = [...new Set((sourceUsage.managedKeys || []).filter(key => {
    const split = key.indexOf(':');
    return owners.has(normalizeClientName(key.slice(0, split)));
  }).map(key => { const split = key.indexOf(':'); return `${normalizeClientName(key.slice(0, split))}:${key.slice(split + 1)}`; }))];
  if (!owners.size) return;
  const today = String(options.todayKey || '').slice(0, 10);
  const since = String(options.allTimeSince || '').slice(0, 10);
  const timeZone = options.timeZone || summary.periodWindows?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  // A stale cached projection never revokes ownership. The parent should
  // request a newly bucketed projection for a calendar change.
  if (sourceUsage.bucketTimezone !== timeZone) sourceUsage = rebucketSourceUsage(sourceUsage, timeZone);
  const full = options.replaceLive !== false && !options.nativeAnchor;
  const snapshots = sourceUsage.sessions.filter(row => rawOwners.has(row.client));
  const selectedScopes = sourceUsage.scopes.filter(scope => scope.clients.some(client => rawOwners.has(client)));
  const selectedAggregates = (sourceUsage.aggregates || []).filter(day => selectedScopes.some(scope => scope.id === day.scopeId));
  const lockedRawOwners = new Set(selectedScopes.filter(scope => scope.blockNativeWatch === true).flatMap(scope => scope.clients));
  const lockedOwners = new Set([...lockedRawOwners].map(normalizeClientName));
  const legacyPeriodIds = new Set((sourceUsage.legacyPeriods || []).map(boundary => boundary.scopeId));
  const nativeLegacyRaw = new Set(sourceUsage.scopes.filter(scope => scope.mode === 'legacy'
    && legacyPeriodIds.has(scope.id) && !scope.blockNativeWatch).flatMap(scope => scope.clients).filter(client => rawOwners.has(client)));
  const metadata = new Map();
  const nativeTodayPeriod = options.nativePeriods?.today || summary.today;
  for (const name of ['allTime', 'month', 'today']) {
    for (const [key, row] of Object.entries(summary[name]?.sessions || {})) metadata.set(key, row);
  }
  for (const name of ['today', 'month', 'allTime']) {
    if (!summary[name]) continue;
    const native = options.nativePeriods?.[name] || summary[name];
    const live = new Set(Object.keys(native.sessions || {}));
    for (const key of Object.keys(options.nativeAnchor?.[name]?.sessions || {})) live.add(key);
    const rawLive = options.nativeRawPresence?.[name] ? new Set(options.nativeRawPresence[name]) : null;
    const rawAnchor = options.nativeAnchor?.nativeRawPresence?.[name] ? new Set(options.nativeAnchor.nativeRawPresence[name]) : null;
    if (rawLive && rawAnchor) for (const key of rawAnchor) rawLive.add(key);
    if (!options.nativePeriods) for (const key of source.presentKeys || []) live.add(key);
    const observed = [];
    const retained = [];
    const legacyPeriodScopes = new Set();
    const legacyPeriodOwners = new Set();
    for (const boundary of sourceUsage.legacyPeriods || []) {
      if (!boundary.clients.some(client => rawOwners.has(client))) continue;
      legacyPeriodScopes.add(boundary.scopeId);
      const boundaryOwners = new Set(boundary.clients.map(normalizeClientName));
      boundaryOwners.forEach(client => legacyPeriodOwners.add(client));
      const window = boundary.periods[name];
      const period = window && (name === 'allTime' || name === 'today' && window.day === today
        || name === 'month' && window.month === today.slice(0, 7)) ? structuredClone(window.period) : emptyPeriod();
      const nativeToday = !full && boundary.clients.some(client => nativeLegacyRaw.has(client))
        ? mergePeriods(...onlyClients(nativeTodayPeriod, boundaryOwners)) : null;
      const allocated = aggregatePeriod(selectedAggregates.filter(day => day.scopeId === boundary.scopeId), name, today, since, nativeToday);
      // These are overlapping observations of one legacy boundary, not an
      // inferred additive union. Undated allTime never creates a daily bucket.
      let selectedPeriod = largerLegacyPeriod({ period: allocated }, { period }, 'allTime') ? allocated : period;
      if (!full && boundary.clients.some(client => nativeLegacyRaw.has(client))) {
        const candidate = mergePeriods(...onlyClients(native, boundaryOwners));
        if (largerLegacyPeriod({ period: candidate }, { period: selectedPeriod }, 'allTime')) selectedPeriod = candidate;
      }
      for (const [key, row] of Object.entries(selectedPeriod.sessions)) {
        copySessionMetadata(row, metadata.get(key));
        row.retained = true;
        row.sourceState = 'unknown';
        for (const field of ['contextTokens', 'contextWindow', 'turnEnded', 'waitingForInput', 'promptCache', 'liveActivity']) delete row[field];
      }
      retained.push(selectedPeriod);
    }
    for (const snapshot of snapshots) {
      if (legacyPeriodScopes.has(snapshot.scopeId)) continue;
      const key = `${normalizeClientName(snapshot.client)}:${snapshot.sessionId}`;
      const rawKey = `${snapshot.client}:${snapshot.sessionId}`;
      const isLive = rawLive ? rawLive.has(rawKey) : live.has(key);
      const inAnchor = rawAnchor ? rawAnchor.has(rawKey) : options.nativeAnchor?.[name]?.sessions?.[key];
      const replaceAccounting = full || lockedOwners.has(normalizeClientName(snapshot.client));
      const pastOnly = !replaceAccounting && name !== 'today' && isLive && options.nativeAnchor && !inAnchor;
      if (!replaceAccounting && isLive && !pastOnly) continue;
      const period = snapshotPeriod(sourceUsage, snapshot, name, today, since, pastOnly);
      const row = period.sessions[key];
      if (row) {
        copySessionMetadata(row, metadata.get(key));
        if (!replaceAccounting || !isLive || snapshot.sourceState !== 'present') {
          row.sourceState = snapshot.sourceState === 'missing' ? 'missing' : 'unknown';
          row.retained = true;
          for (const field of ['contextTokens', 'contextWindow', 'turnEnded', 'waitingForInput', 'promptCache', 'liveActivity']) delete row[field];
          if (row.sourceState === 'missing') row.archived = true;
        }
      }
      if (replaceAccounting && isLive && snapshot.sourceState === 'present') observed.push({ rawClient: snapshot.client, period });
      else {
        if (period.totalTokens > 0) { period.capabilities.throughput = false; delete period.modelThroughput; }
        retained.push(period);
      }
    }
    if (full) {
      const rawPartitions = options.nativeRawPartitions?.[name];
      const partitions = options.nativePartitions?.[name];
      const untouched = rawPartitions
        ? Object.entries(rawPartitions).filter(([raw]) => !owners.has(normalizeClientName(raw))).map(([, period]) => period)
        : partitions ? Object.entries(partitions).filter(([client]) => !owners.has(client) && client !== UNATTRIBUTED_USAGE_CLIENT).map(([, period]) => period)
          : Object.entries(native.sessions || {}).filter(([, row]) => !owners.has(row.client)).length === 0
            && Object.keys(native.clients || {}).every(client => owners.has(client)) ? []
            : fallbackUntouched(native, new Set([...owners, UNATTRIBUTED_USAGE_CLIENT]));
      const acceptedRaw = Object.fromEntries([...rawOwners].map(raw => {
        const period = nativeLegacyRaw.has(raw)
          ? structuredClone(rawPartitions ? rawPartitions[raw] || emptyPeriod()
            : partitions?.[normalizeClientName(raw)] || mergePeriods(...onlyClients(native, new Set([normalizeClientName(raw)]))))
          : mergePeriods(...observed.filter(row => row.rawClient === raw).map(row => row.period));
        carryMatchingPerformance(period, rawPartitions?.[raw] || partitions?.[normalizeClientName(raw)]);
        return [raw, period];
      }));
      const acceptedNative = mergePeriods(...untouched, ...Object.values(acceptedRaw));
      for (const [key, row] of Object.entries(acceptedNative.sessions)) {
        copySessionMetadata(row, native.sessions?.[key] || metadata.get(key));
        if (!owners.has(row.client) && accountingMatches(row, native.sessions?.[key])) {
          row.timedDurationMs = native.sessions[key].timedDurationMs;
          row.timedOutputTokens = native.sessions[key].timedOutputTokens;
        }
      }
      if (options.nativePeriods) options.nativePeriods[name] = acceptedNative;
      // Maintain the existing exact anchor contract. Parent snapshots these
      // periods; retained absent IDs are added only to the display below.
      if (rawPartitions) for (const [raw, period] of Object.entries(acceptedRaw)) rawPartitions[raw] = period;
      if (partitions && name === 'today') for (const client of owners) {
        partitions[client] = mergePeriods(...Object.entries(acceptedRaw).filter(([raw]) => normalizeClientName(raw) === client).map(([, period]) => period));
      }
      if (rawPartitions && options.nativeRawPresence) options.nativeRawPresence[name] = Object.entries(rawPartitions)
        .flatMap(([raw, period]) => Object.values(period.sessions || {}).map(row => `${raw}:${row.sessionId}`));
      const aggregate = aggregatePeriod(selectedAggregates.filter(day => !legacyPeriodScopes.has(day.scopeId)), name, today, since);
      const displayNative = nativeLegacyRaw.size
        ? mergePeriods(...fallbackUntouched(acceptedNative, new Set([...nativeLegacyRaw].map(normalizeClientName)))) : acceptedNative;
      summary[name] = mergePeriods(displayNative, ...retained, aggregate, options.supplementalPeriods?.[name] || emptyPeriod());
    } else {
      const replacedOwners = new Set([...lockedOwners, ...legacyPeriodOwners]);
      // An unattributed observation can overlap every owned domain. It cannot
      // be added to retained accepted counters as if it were another source.
      if (replacedOwners.size) replacedOwners.add(UNATTRIBUTED_USAGE_CLIENT);
      const base = replacedOwners.size ? mergePeriods(...fallbackUntouched(native, replacedOwners)) : native;
      const aggregate = aggregatePeriod(selectedAggregates.filter(day => !legacyPeriodScopes.has(day.scopeId)
        && selectedScopes.some(scope => scope.id === day.scopeId && scope.blockNativeWatch)), name, today, since);
      summary[name] = mergePeriods(base, ...observed.map(row => row.period), ...retained, aggregate, options.supplementalPeriods?.[name] || emptyPeriod());
    }
  }
  if (full) applyProjectRollups(summary);
}

function onlyClients(period, selected) {
  const clients = [...Object.keys(period.clients || {}), ...Object.keys(period.clientCosts || {}),
    ...Object.values(period.sessions || {}).map(row => row.client)];
  return fallbackUntouched(period, new Set(clients.filter(client => !selected.has(client))));
}

function fallbackUntouched(native, owners) {
  const clients = new Set([...Object.keys(native.clients || {}), ...Object.keys(native.clientCosts || {}),
    ...Object.values(native.sessions || {}).map(row => row.client)]);
  return [...clients].filter(client => !owners.has(client)).map(client => {
    const period = emptyPeriod();
    period.totalTokens = native.clients?.[client] || 0;
    period.costUsd = native.clientCosts?.[client] || 0;
    period.clients[client] = period.totalTokens;
    period.clientCosts[client] = period.costUsd;
    for (const [total, byClient] of [['cacheReadTokens', 'clientCacheReads'], ['cacheWriteTokens', 'clientCacheWrites'],
      ['outputTokens', 'clientOutputs'], ['unclassifiedTokens', 'clientUnclassifiedTokens']]) {
      period[total] = native[byClient]?.[client] || 0;
      if (period[total]) period[byClient][client] = period[total];
    }
    period.models = { ...native.clientModels?.[client] };
    period.modelCosts = { ...native.clientModelCosts?.[client] };
    for (const [field, total] of [['models', period.totalTokens], ['modelCosts', period.costUsd]]) {
      const known = Object.values(period[field]).reduce((sum, value) => sum + value, 0);
      if (known > total + 1e-9) period[field] = { unknown: total };
      else if (total > known) period[field].unknown = (period[field].unknown || 0) + total - known;
    }
    period.clientModels[client] = { ...period.models };
    period.clientModelCosts[client] = { ...period.modelCosts };
    period.sessions = structuredClone(Object.fromEntries(Object.entries(native.sessions || {}).filter(([, row]) => row.client === client)));
    for (const row of Object.values(period.sessions)) {
      period.timedDurationMs += row.timedDurationMs || 0;
      period.timedOutputTokens += row.timedOutputTokens || 0;
    }
    period.capabilities.tokenComponents = native.capabilities?.tokenComponents === true;
    period.capabilities.throughput = native.capabilities?.throughput === true;
    return period;
  });
}

module.exports = { applySourceDailyUsage };
