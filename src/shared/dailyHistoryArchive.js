'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { sharedDataDir, writeJsonAtomic } = require('./config');
const {
  normalizeTokscaleClientName, normalizeTokscaleModelNameForClient,
  normalizeTokscaleModelComponentSummary, num, sumOutputTokens, sumTokens
} = require('./history');
const {
  CLIENT_IDENTITY_GENERATION, CLIENT_IDENTITY_SPLITS, isPreSplitEntry
} = require('./clientIdentitySplits');

const ARCHIVE_VERSION = 1;
const archiveReadCache = new Map();
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const { emptyPeriod } = require('./usage');
const { addArchivedSession, isSessionUsageArchiveEvidence } = require('./usage/sessionUsageArchive');
const { captureSourceLedger, legacyCostsEqual, legacyDaysMatch, legacySessionAccounting, selectLegacyDay, largerLegacyPeriod, normalizeSourceLedger, projectSourceLedger, sourceSnapshotsFromGraphs } = require('./usage/sourceLedger');

function sourceProjectionClient(value) {
  const client = normalizeTokscaleClientName(value);
  return client?.startsWith('cc-mirror/') ? 'claude' : client === '9router' ? 'gjc' : client;
}

function observationKey(value) {
  return JSON.stringify([
    sourceProjectionClient(value?.client) || 'unknown',
    normalizeTokscaleModelNameForClient(value?.modelId || value?.model || value?.model_id || 'unknown', value?.client)
  ]);
}

function sourceObservationKey(value) {
  return JSON.stringify([value.client, value.modelId]);
}

function providerSet(...values) {
  return [...new Set(values.flatMap(value => String(value || '').split(',').map(id => id.trim()).filter(Boolean)))].sort().join(', ');
}

function normalizeObservation(value, sourceIdentity = false) {
  if (!value || typeof value !== 'object') return null;
  const client = (sourceIdentity ? sourceClient(value.client) : sourceProjectionClient(value.client)) || 'unknown';
  const modelId = normalizeTokscaleModelNameForClient(value.modelId || value.model || value.model_id || 'unknown', normalizeTokscaleClientName(client));
  const tokens = Math.max(0, Math.round(num(value.tokens)));
  const cost = Math.max(0, num(value.cost));
  const messages = Math.max(0, Math.round(num(value.messages)));
  const unpricedTokens = Math.min(tokens, Math.max(0, Math.round(num(value.unpricedTokens ?? value.pricing?.unpricedTokens))));
  const reasoningTokens = Math.max(0, Math.round(num(value.reasoningTokens ?? value.reasoning_tokens)));
  const rawCacheReadTokens = Math.max(0, Math.round(num(value.cacheReadTokens ?? value.cache_read_tokens)));
  const rawCacheWriteTokens = Math.max(0, Math.round(num(value.cacheWriteTokens ?? value.cache_write_tokens)));
  const rawOutputTokens = Math.max(0, Math.round(num(value.outputTokens ?? value.output_tokens)));
  const rawComponentTokens = rawCacheReadTokens + rawCacheWriteTokens + rawOutputTokens;
  const componentsFit = rawComponentTokens <= tokens;
  const cacheReadTokens = componentsFit ? rawCacheReadTokens : 0;
  const cacheWriteTokens = componentsFit ? rawCacheWriteTokens : 0;
  const outputTokens = componentsFit ? rawOutputTokens : 0;
  const componentTokens = cacheReadTokens + cacheWriteTokens + outputTokens;
  const hasExplicitUnclassified = Object.prototype.hasOwnProperty.call(value, 'unclassifiedTokens')
    || Object.prototype.hasOwnProperty.call(value, 'unclassified_tokens');
  const unclassifiedTokens = Math.min(Math.max(0, tokens - componentTokens), Math.max(0, Math.round(
    hasExplicitUnclassified
      ? num(value.unclassifiedTokens ?? value.unclassified_tokens)
      : (value.tokenComponentsAvailable === true && componentsFit ? 0 : tokens)
  )));
  // A zero-token synthetic observation has an exact zero component breakdown
  // even when it predates the provenance field. Do not let bookkeeping-only
  // rows make an otherwise exact fixed-range breakdown unavailable.
  const tokenComponentsAvailable = componentsFit
    && componentTokens + unclassifiedTokens <= tokens
    && unclassifiedTokens === 0
    && (tokens === 0 || value.tokenComponentsAvailable === true);
  if (tokens === 0 && cost === 0 && messages === 0) return null;
  return {
    client,
    modelId,
    ...(providerSet(value.providerId || value.provider_id)
      ? { providerId: providerSet(value.providerId || value.provider_id) }
      : {}),
    tokens,
    cost,
    messages,
    ...(unpricedTokens > 0 ? { unpricedTokens } : {}),
    ...(typeof value.pricingRevision === 'string' ? { pricingRevision: value.pricingRevision } : {}),
    ...(unclassifiedTokens > 0 ? { unclassifiedTokens } : {}),
    ...(tokenComponentsAvailable ? { tokenComponentsAvailable: true } : {}),
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {})
  };
}

function addObservation(previous, candidate) {
  if (!previous) return candidate;
  return normalizeObservation({
    ...candidate,
    providerId: providerSet(candidate.providerId, previous.providerId),
    tokens: previous.tokens + candidate.tokens,
    cost: previous.cost + candidate.cost,
    messages: previous.messages + candidate.messages,
    unpricedTokens: num(previous.unpricedTokens) + num(candidate.unpricedTokens),
    reasoningTokens: num(previous.reasoningTokens) + num(candidate.reasoningTokens),
    tokenComponentsAvailable: previous.tokenComponentsAvailable === true
      && candidate.tokenComponentsAvailable === true,
    cacheReadTokens: num(previous.cacheReadTokens) + num(candidate.cacheReadTokens),
    cacheWriteTokens: num(previous.cacheWriteTokens) + num(candidate.cacheWriteTokens),
    outputTokens: num(previous.outputTokens) + num(candidate.outputTokens),
    unclassifiedTokens: num(previous.unclassifiedTokens) + num(candidate.unclassifiedTokens)
  }, true);
}

function normalizeComponentValues(value, totalTokens, exact) {
  const cacheReadTokens = Math.max(0, Math.round(num(value?.cacheReadTokens)));
  const cacheWriteTokens = Math.max(0, Math.round(num(value?.cacheWriteTokens)));
  const outputTokens = Math.max(0, Math.round(num(value?.outputTokens)));
  if (cacheReadTokens + cacheWriteTokens + outputTokens > totalTokens) return null;
  const unclassifiedTokens = Math.min(
    totalTokens - cacheReadTokens - cacheWriteTokens - outputTokens,
    Math.max(0, Math.round(num(value?.unclassifiedTokens
      ?? (exact ? 0 : totalTokens - cacheReadTokens - cacheWriteTokens - outputTokens))))
  );
  return {
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(unclassifiedTokens > 0 ? { unclassifiedTokens } : {})
  };
}

function observationTokenMaps(observations) {
  const perClient = {};
  const perModel = {};
  let totalTokens = 0;
  for (const observation of Object.values(observations || {})) {
    const tokens = Math.max(0, Math.round(num(observation?.tokens)));
    totalTokens += tokens;
    perClient[observation.client] = num(perClient[observation.client]) + tokens;
    perModel[observation.modelId] = num(perModel[observation.modelId]) + tokens;
  }
  return { totalTokens, perClient, perModel };
}

function normalizeComponentSummary(value, observations) {
  if (!value || typeof value !== 'object') return null;
  const exact = value.tokenComponentsAvailable === true;
  const tokenMaps = observationTokenMaps(observations);
  const totals = normalizeComponentValues(value, tokenMaps.totalTokens, exact);
  if (!totals) return null;

  const normalizeMap = (source, tokensByKey) => {
    const result = {};
    for (const [key, tokens] of Object.entries(tokensByKey)) {
      const normalized = normalizeComponentValues(source?.[key], tokens, exact);
      if (!normalized) return null;
      if (Object.keys(normalized).length > 0) result[key] = normalized;
    }
    return result;
  };
  const foldComponentMapByClient = (map) => {
    if (!map || typeof map !== 'object') return map;
    const folded = {};
    for (const [rawClient, comp] of Object.entries(map)) {
      const client = normalizeTokscaleClientName(rawClient) || rawClient;
      if (!folded[client]) {
        folded[client] = { ...comp };
      } else {
        folded[client] = {
          cacheReadTokens: num(folded[client].cacheReadTokens) + num(comp?.cacheReadTokens),
          cacheWriteTokens: num(folded[client].cacheWriteTokens) + num(comp?.cacheWriteTokens),
          outputTokens: num(folded[client].outputTokens) + num(comp?.outputTokens),
          unclassifiedTokens: num(folded[client].unclassifiedTokens) + num(comp?.unclassifiedTokens)
        };
      }
    }
    return folded;
  };
  const perClient = normalizeMap(foldComponentMapByClient(value.perClient), tokenMaps.perClient);
  const perModel = normalizeMap(value.perModel, tokenMaps.perModel);
  if (!perClient || !perModel) return null;
  return {
    tokenComponentsAvailable: exact
      && num(totals.unclassifiedTokens) === 0
      && Object.values(perClient).every((entry) => num(entry.unclassifiedTokens) === 0)
      && Object.values(perModel).every((entry) => num(entry.unclassifiedTokens) === 0),
    ...totals,
    perClient,
    perModel
  };
}

function normalizeDay(value, fallbackDate = '', sourceIdentity = false) {
  const date = String(value?.date || fallbackDate).slice(0, 10);
  if (!DAY_KEY_RE.test(date)) return null;
  const observations = {};
  const source = Array.isArray(value?.observations)
    ? value.observations
    : Object.values(value?.observations || {});
  for (const raw of source) {
    const observation = normalizeObservation(raw, sourceIdentity);
    if (!observation) continue;
    const key = sourceIdentity ? sourceObservationKey(observation) : observationKey(observation);
    observations[key] = addObservation(observations[key], observation);
  }
  if (Object.keys(observations).length === 0 && num(value?.activeTimeMs) <= 0) return null;
  const componentSummary = normalizeComponentSummary(
    normalizeTokscaleModelComponentSummary(value?.componentSummary, source), observations
  );
  return {
    date,
    activeTimeMs: Math.max(0, Math.round(num(value?.activeTimeMs))),
    // Provenance travels with the day. An archive written before the split has
    // no marker, which is what makes it recognizable as merged-era; a day this
    // version writes carries the current generation and is taken at face value.
    ...(value?.clientIdentityGeneration !== undefined
      ? { clientIdentityGeneration: num(value.clientIdentityGeneration) }
      : {}),
    observations,
    ...(componentSummary ? { componentSummary } : {})
  };
}

function normalizeDailyHistoryArchive(value) {
  const normalized = { version: ARCHIVE_VERSION, days: {} };
  if (typeof value?.pricingRevision === 'string') normalized.pricingRevision = value.pricingRevision;
  if (value?.timeMetrics && typeof value.timeMetrics === 'object') normalized.timeMetrics = graphTimeMetrics([value], 0);
  const source = value?.days && typeof value.days === 'object' ? value.days : {};
  for (const [date, rawDay] of Object.entries(source)) {
    const day = normalizeDay(rawDay, date);
    if (day) normalized.days[day.date] = day;
  }
  const liveSource = value?.liveDays && typeof value.liveDays === 'object' ? value.liveDays : {};
  const liveDays = {};
  for (const [date, rawDay] of Object.entries(liveSource)) {
    const day = normalizeDay(rawDay, date);
    if (day) liveDays[day.date] = day;
  }
  if (Object.keys(liveDays).length > 0) normalized.liveDays = liveDays;
  if (value?.unresolvedDays && typeof value.unresolvedDays === 'object') {
    normalized.unresolvedDays = {};
    for (const [date, rawDay] of Object.entries(value.unresolvedDays)) {
      const day = normalizeDay(rawDay, date, true);
      if (day) normalized.unresolvedDays[date] = day;
    }
  }
  if (value?.sourceLedger !== undefined) {
    normalized.sourceLedger = recoverLegacyDayAllocations(normalizeSourceLedger(value.sourceLedger));
    return normalized;
  }
  return normalized;
}

function sourceClient(value) {
  if (typeof value !== 'string') return null;
  const client = value.trim();
  return client && /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9_.-]+)?$/i.test(client)
    && !['unknown', 'synthetic', 'null', 'undefined'].includes(client.toLowerCase()) ? client : null;
}

function sourceDays(value, client) {
  if (!Array.isArray(value)) return null;
  if (value.some(row => !DAY_KEY_RE.test(String(row?.date || '')) || !Array.isArray(row?.clients)
    || row.clients.some(entry => sourceClient(entry?.client) !== client))) return null;
  const days = Object.fromEntries(observationsFromGraphs({ contributions: value }, { sourceIdentity: true }));
  const result = {};
  for (const [date, rawDay] of Object.entries(days)) {
    if (!rawDay || typeof rawDay !== 'object' || !DAY_KEY_RE.test(date)
      || !rawDay.observations || typeof rawDay.observations !== 'object') return null;
    const day = normalizeDay(rawDay, date, true);
    if (day) result[day.date] = day;
  }
  return result;
}

function mergeUnresolvedDays(target, source) {
  for (const [date, rawDay] of Object.entries(source || {})) {
    const day = normalizeDay(rawDay, date, true);
    if (!day) continue;
    const previous = target[date] || { date, activeTimeMs: 0, observations: {} };
    const observations = { ...previous.observations };
    for (const [key, observation] of Object.entries(day.observations)) {
      observations[key] = observation;
    }
    target[date] = { ...day, activeTimeMs: Math.max(previous.activeTimeMs, day.activeTimeMs), observations };
  }
}

// Legacy aggregates cannot be proven disjoint by comparing numeric totals.
// Keep one whole daily observation behind an exclusive boundary until identity
// evidence can reconcile it; never add it to an event ledger during migration.
function retainedSessionBoundary(sessionArchive, families) {
  const periods = {};
  const sessions = {};
  const days = {};
  const dayPeriods = {};
  const clients = new Set();
  for (const entry of Object.values(sessionArchive?.sessions || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const client = sourceProjectionClient(entry.client);
    if (!families.has(client)) continue;
    if (Object.values(entry.periods || {}).some(row => num(row?.totalTokens) > 0 || num(row?.costUsd) > 0)) clients.add(client);
    const key = `${client}:${entry.sessionId}`;
    sessions[key] = { client, sessionId: entry.sessionId, sourceState: 'unknown' };
    for (const name of ['today', 'month', 'allTime']) {
      const session = entry.periods?.[name];
      if (!session) continue;
      // Only stored window metadata allocates a short period. capturedAt is
      // collection time, not evidence that allTime usage happened on that day.
      const window = entry.periodWindows?.[name] || {};
      const bucket = name === 'today' ? window.day || entry.day : name === 'month' ? window.month || entry.month : '';
      if (name === 'today' && !DAY_KEY_RE.test(bucket) || name === 'month' && !/^\d{4}-\d{2}$/.test(bucket)) continue;
      const row = { ...session, client, sessionId: entry.sessionId };
      if (name === 'today') {
        addArchivedSession(dayPeriods[bucket] ||= emptyPeriod(), row, key);
      }
      const field = name === 'today' ? 'day' : 'month';
      if (!periods[name] || name !== 'allTime' && bucket > periods[name][field]) {
        periods[name] = { ...(name === 'allTime' ? {} : { [field]: bucket }), period: emptyPeriod() };
      }
      if (name === 'allTime' || periods[name][field] === bucket) addArchivedSession(periods[name].period, row, key);
    }
  }
  for (const [date, period] of Object.entries(dayPeriods)) {
    const day = allocatedLegacyDay(period, date);
    if (day) days[date] = day;
  }
  return { periods, sessions, clients: [...clients], days, hasUsage: clients.size > 0 };
}

function allocatedLegacyDay(period, date) {
  const day = periodLiveDay(period, date);
  return day && { ...day, sessionAllocation: legacySessionAccounting(period.sessions) };
}

// R3 stored whole dated periods as well as days. Recover only their complete
// matching observation, never a lifetime total or an unrelated generic row.
function recoverLegacyDayAllocations(ledger) {
  let recovered = ledger;
  for (const [id, scope] of Object.entries(ledger.scopes)) {
    if (scope.mode !== 'legacy') continue;
    for (const [date, day] of Object.entries(scope.legacyDays || {})) {
      if (!day.sessionAllocation) continue;
      const period = emptyPeriod();
      for (const [key, session] of Object.entries(day.sessionAllocation)) addArchivedSession(period, session, key);
      const candidate = allocatedLegacyDay(period, date);
      if (candidate && legacyDaysMatch(candidate, day, Object.keys(day.sessionAllocation).length)) continue;
      if (recovered === ledger) recovered = { ...ledger, scopes: { ...ledger.scopes } };
      const { sessionAllocation: _allocation, ...unallocated } = day;
      recovered.scopes[id] = { ...recovered.scopes[id], legacyDays: { ...recovered.scopes[id].legacyDays, [date]: unallocated } };
    }
    const window = scope.legacyPeriods?.today;
    const day = window && recovered.scopes[id].legacyDays?.[window.day];
    if (!day || day.sessionAllocation) continue;
    const candidate = allocatedLegacyDay(window.period, window.day);
    if (!candidate) continue;
    const selected = selectLegacyDay(day, candidate);
    // Compatibility recovery may enrich a match, never replace accounting.
    if (selected === day || selected === candidate) continue;
    if (recovered === ledger) recovered = { ...ledger, scopes: { ...ledger.scopes } };
    recovered.scopes[id] = { ...recovered.scopes[id], legacyDays: { ...recovered.scopes[id].legacyDays, [window.day]: selected } };
  }
  return recovered === ledger ? ledger : normalizeSourceLedger(recovered);
}

function legacyBoundary(archive, clients, options = {}) {
  const families = new Set(clients.map(sourceProjectionClient));
  const select = days => Object.fromEntries(Object.entries(days || {}).map(([date, day]) => {
    const normalized = normalizeDay({ ...day, observations: Object.values(day.observations || {})
      .filter(row => families.has(sourceProjectionClient(row.client))) }, date, true);
    if (normalized && day.sessionAllocation) normalized.sessionAllocation = legacySessionAccounting(Object.fromEntries(
      Object.entries(day.sessionAllocation).filter(([, row]) => families.has(sourceProjectionClient(row.client)))));
    return [date, normalized];
  }).filter(([, day]) => day));
  const retained = {};
  const legacy = Object.values(archive.sourceLedger?.scopes || {}).filter(scope => scope.mode === 'legacy' && scope.legacyPeriods
    && scope.clients.some(client => families.has(sourceProjectionClient(client))));
  for (const source of [archive.days, archive.liveDays, archive.unresolvedDays, ...legacy.map(scope => scope.legacyDays)]) {
    for (const [date, day] of Object.entries(select(source))) {
      retained[date] = selectLegacyDay(retained[date], day);
    }
  }
  const generic = retainedSessionBoundary(options.sessionUsageArchive, families);
  for (const scope of legacy) {
    for (const [name, candidate] of Object.entries(scope.legacyPeriods)) {
      if (largerLegacyPeriod(candidate, generic.periods[name], name)) generic.periods[name] = candidate;
    }
    Object.assign(generic.sessions, scope.sessions);
    generic.clients = [...new Set([...generic.clients, ...scope.clients])];
  }
  for (const [date, day] of Object.entries(generic.days)) {
    retained[date] = selectLegacyDay(retained[date], day);
  }
  const hasRetainedUsage = generic.hasUsage || Object.values(generic.periods).some(row => row.period.totalTokens > 0 || row.period.costUsd > 0)
    || Object.values(retained).some(day => dayTokens(day) > 0 || dayCost(day) > 0);
  if (hasRetainedUsage && options.nativePeriods) {
    // Once persisted evidence establishes a legacy boundary, preserve its
    // ordinary whole-period maximum. A transient native observation alone can
    // never establish that boundary or authorize exact ledger migration.
    const entries = {};
    for (const name of ['today', 'month', 'allTime']) {
      for (const [key, session] of Object.entries(options.nativePeriods[name]?.sessions || {})) {
        const entry = entries[key] ||= { client: session.client, sessionId: session.sessionId, periods: {}, periodWindows: {} };
        entry.periods[name] = session;
        entry.periodWindows[name] = name === 'today' ? { day: options.todayKey } : name === 'month' ? { month: options.todayKey?.slice(0, 7) } : {};
      }
    }
    const native = retainedSessionBoundary({ sessions: entries }, families);
    for (const [name, candidate] of Object.entries(native.periods)) {
      if (largerLegacyPeriod(candidate, generic.periods[name], name)) generic.periods[name] = candidate;
    }
    Object.assign(generic.sessions, native.sessions);
    generic.clients = [...new Set([...generic.clients, ...native.clients])];
    for (const [date, day] of Object.entries(native.days)) {
      retained[date] = selectLegacyDay(retained[date], day);
    }
  }
  if (hasRetainedUsage && options.healthyLegacyGraph) {
    const incoming = Object.fromEntries(observationsFromGraphs(options.healthyLegacyGraph, { sourceIdentity: true }));
    for (const [date, day] of Object.entries(select(incoming))) {
      // Preserve the whole native observation, including its session allocation,
      // on equal accounting. Aggregate graph metadata cannot prove that allocation.
      retained[date] = selectLegacyDay(retained[date], day);
    }
  }
  const days = retained;
  return { days, hasRetainedUsage, hasUsage: hasRetainedUsage,
    ...(Object.keys(generic.periods).length ? { periods: generic.periods, sessions: generic.sessions, clients: generic.clients } : {}) };
}

function captureSourceDailyHistory(archive, graphs, options) {
  const retainedBoundaryChecked = isSessionUsageArchiveEvidence(options.sessionUsageArchive);
  const boundaryOptions = retainedBoundaryChecked ? options : { ...options, sessionUsageArchive: undefined };
  const result = captureSourceLedger(archive.sourceLedger, graphs, {
    ...options, timeZone: options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    retainedBoundaryChecked,
    canonicalClient: sourceProjectionClient,
    legacyBoundary: (clients, graph, healthyLegacyObservation) => legacyBoundary(archive, clients,
      healthyLegacyObservation ? { ...boundaryOptions, healthyLegacyGraph: graph } : boundaryOptions)
  });
  if (Object.keys(result.ledger.scopes).length || Object.keys(result.ledger.observations || {}).length) archive.sourceLedger = result.ledger;
  const clients = new Set(Object.values(result.ledger.scopes).flatMap(scope => scope.clients).map(sourceProjectionClient));
  if (clients.size) {
    archive.unresolvedDays ||= {};
    removeSourceClients(archive.days, clients, archive.unresolvedDays);
    removeSourceClients(archive.liveDays, clients, archive.unresolvedDays);
  }
  return { ...result, size: result.accepted.size, values: () => [...result.accepted.values()]
    .map(scan => ({ ...scan, replacementAuthority: true })) };
}

function removeSourceClients(days, clients, unresolved) {
  if (!clients.size) return;
  for (const [date, day] of Object.entries(days || {})) {
    const keep = {};
    const moved = {};
    for (const [key, observation] of Object.entries(day.observations)) {
      (clients.has(sourceProjectionClient(observation.client)) ? moved : keep)[key] = observation;
    }
    if (!Object.keys(moved).length) continue;
    if (unresolved) mergeUnresolvedDays(unresolved, { [date]: { ...day, observations: moved } });
    if (Object.keys(keep).length || num(day.activeTimeMs) > 0) days[date] = { ...day, observations: keep, componentSummary: undefined };
    else delete days[date];
  }
}

function graphsArray(graphs) {
  return (Array.isArray(graphs) ? graphs : [graphs]).filter((graph) => graph && typeof graph === 'object');
}

// A day that was first observed while two clients shared one row keeps that
// merged identity: the archived row already contains both products' usage, so
// replaying a post-split scan of the same day as two rows would count the split
// client twice. Folding is decided by the day's own provenance rather than by
// its current contents, because "holds the merged id and not the split id" is a
// legal post-split state: a day whose first scan sees only Pi looks exactly like
// a merged-era day, and folding it would permanently absorb Oh My Pi into Pi for
// every later scan of that day. A day with no generation marker predates the
// split and is the only kind that may be folded; a day this version wrote carries
// the current generation and is taken at face value.
function foldClientForDate(client, date, options = {}) {
  if (!client) return client;
  const day = options.archive?.days?.[date];
  if (!day || !isPreSplitEntry(day)) return client;
  for (const { merged, split } of CLIENT_IDENTITY_SPLITS) {
    if (client !== split) continue;
    return merged;
  }
  return client;
}

function observationsFromGraphs(graphs, options = {}) {
  const days = new Map();
  for (const graph of graphsArray(graphs)) {
    for (const row of (Array.isArray(graph.contributions) ? graph.contributions : [])) {
      const date = String(row?.date || '').slice(0, 10);
      if (!DAY_KEY_RE.test(date)) continue;
      const day = days.get(date) || { date, activeTimeMs: 0, observations: {} };
      if (!options.rejectedGraphs?.has(graph)) day.activeTimeMs += Math.max(0, Math.round(num(row.activeTimeMs ?? row.active_time_ms)));
      for (const raw of (Array.isArray(row?.clients) ? row.clients : [])) {
        const canonicalClient = sourceProjectionClient(raw?.client);
        const client = (options.sourceIdentity ? sourceClient(raw?.client) : foldClientForDate(canonicalClient, date, options)) || 'unknown';
        const candidate = normalizeObservation({
          ...raw,
          client,
          tokens: sumTokens(raw?.tokens, canonicalClient),
          reasoningTokens: raw?.tokens?.reasoning,
          tokenComponentsAvailable: raw?.tokenComponentsAvailable !== false,
          cacheReadTokens: raw?.tokens?.cacheRead ?? raw?.tokens?.cache_read,
          cacheWriteTokens: raw?.tokens?.cacheWrite ?? raw?.tokens?.cache_write,
          outputTokens: sumOutputTokens(raw?.tokens, canonicalClient)
        }, options.sourceIdentity);
        if (!candidate) continue;
        const key = options.sourceIdentity ? sourceObservationKey(candidate) : observationKey(candidate);
        day.observations[key] = addObservation(day.observations[key], candidate);
      }
      days.set(date, day);
    }
  }
  return days;
}

function shouldReplaceObservation(previous, incoming) {
  if (!previous) return true;
  if (incoming.tokens !== previous.tokens) return incoming.tokens > previous.tokens;
  if (incoming.messages !== previous.messages) return incoming.messages > previous.messages;
  // Equal usage can legitimately receive corrected pricing or richer metadata.
  // Replace the whole observation so token and cost values always share a source.
  return true;
}

function captureDailyHistoryArchive(existingArchive, graphs, options = {}) {
  const archive = normalizeDailyHistoryArchive(existingArchive);
  const sourceScans = captureSourceDailyHistory(archive, graphs, options);
  const reprice = options.reprice === true;
  if (typeof options.pricingRevision === 'string') {
    // Stamp each retained observation before adopting the new revision. A
    // source absent from this scan must still be repriced when it reappears.
    const previousRevision = archive.pricingRevision ?? 'legacy';
    for (const day of Object.values(archive.liveDays || {})) {
      for (const observation of Object.values(day.observations)) {
        observation.pricingRevision ??= previousRevision;
      }
    }
  }
  const todayKey = String(options.todayKey || '').slice(0, 10);
  const hasTodayKey = DAY_KEY_RE.test(todayKey);
  const incomingDays = observationsFromGraphs(graphs, { sourceIdentity: true, rejectedGraphs: sourceScans.rejectedGraphs });
  const managedClients = new Set(Object.values(archive.sourceLedger?.scopes || {}).flatMap(scope => scope.clients));
  const managedFamilies = new Set([...managedClients].map(sourceProjectionClient));
  for (const [date, day] of incomingDays) {
    for (const [key, observation] of Object.entries(day.observations)) {
      if (managedClients.has(observation.client) || sourceScans.rejectedClients.has(observation.client)
        || (observation.client === sourceProjectionClient(observation.client) && managedFamilies.has(observation.client))) delete day.observations[key];
      else observation.client = foldClientForDate(sourceProjectionClient(observation.client), date, { archive });
    }
    const normalized = normalizeDay(day, date);
    if (normalized) incomingDays.set(date, normalized);
    if (!Object.keys(day.observations).length && day.activeTimeMs <= 0) incomingDays.delete(date);
  }

  // A failed/empty graph did not confirm any current prices. Keep the old
  // revision so a later successful scan still reconciles retained live costs.
  if ((incomingDays.size > 0 || [...sourceScans.values()].some(scan => scan.replacementAuthority))
    && typeof options.pricingRevision === 'string') archive.pricingRevision = options.pricingRevision;
  const timingGraphs = graphsArray(graphs).filter(graph => !sourceScans.rejectedGraphs.has(graph));
  const timeMetrics = graphTimeMetrics(timingGraphs, 0);
  if (timeMetrics && (sourceScans.size > 0 || !timingGraphs.some(graph => graph.sourceUsage))) archive.timeMetrics = timeMetrics;

  for (const [date, incoming] of incomingDays) {
    if (hasTodayKey && date > todayKey) continue;
    const existing = archive.days[date] || null;
    const previous = existing || { date, activeTimeMs: 0, observations: {} };
    // A day already stored without a marker predates the split, so it keeps that
    // status: its observations genuinely span both products and must keep folding.
    // Anything else is written at the current generation, which is what stops a
    // post-split day from being absorbed into the merged id when Pi happens to be
    // scanned first.
    const legacy = existing !== null && isPreSplitEntry(existing);
    const next = {
      date,
      activeTimeMs: Math.max(previous.activeTimeMs, incoming.activeTimeMs),
      ...(legacy ? {} : { clientIdentityGeneration: CLIENT_IDENTITY_GENERATION }),
      observations: { ...previous.observations }
    };
    for (const [key, observation] of Object.entries(incoming.observations)) {
      if (shouldReplaceObservation(previous.observations[key], observation)) {
        next.observations[key] = observation;
      }
    }
    const normalized = normalizeDay(next, date);
    if (normalized) archive.days[date] = normalized;
    // When the collector rescans with current pricing, matching source usage
    // owns its price (including explicit zero). Keep archive-only usage and
    // richer live metadata, but do not let an older live cost undo repricing.
    const liveDay = archive.liveDays?.[date];
    if (liveDay && (reprice || typeof options.pricingRevision === 'string')) {
      archive.liveDays[date] = withReconciledGraphCosts(liveDay, incoming, liveDay, reprice, options.pricingRevision);
    }
  }

  // Presentation and sync windows are intentionally applied later by
  // normalizeHistory(). The local archive keeps every observed past day so a
  // future year selector can read it without depending on source transcripts.
  if (hasTodayKey) {
    for (const date of Object.keys(archive.days)) {
      if (date > todayKey) delete archive.days[date];
    }
  }
  return archive;
}

function periodLiveDay(period, date) {
  if (!period || typeof period !== 'object' || !DAY_KEY_RE.test(date)) return null;
  const observations = new Map();
  const addObservation = (client, modelId, tokens, cost) => {
    const observation = {
      client,
      modelId,
      tokens: Math.max(0, Math.round(num(tokens))),
      cost: Math.max(0, num(cost)),
      messages: 0
    };
    const key = observationKey(observation);
    const previous = observations.get(key);
    if (!previous) {
      observations.set(key, observation);
      return;
    }
    previous.tokens += observation.tokens;
    previous.cost += observation.cost;
  };
  const clientModels = period.clientModels && typeof period.clientModels === 'object'
    ? period.clientModels
    : {};
  const clientModelCosts = period.clientModelCosts && typeof period.clientModelCosts === 'object'
    ? period.clientModelCosts
    : {};
  const clients = period.clients && typeof period.clients === 'object' ? period.clients : {};
  const clientCosts = period.clientCosts && typeof period.clientCosts === 'object' ? period.clientCosts : {};
  const clientIds = new Set([...Object.keys(clientModels), ...Object.keys(clients), ...Object.keys(clientCosts)]);

  for (const client of clientIds) {
    const models = clientModels[client] && typeof clientModels[client] === 'object'
      ? clientModels[client]
      : {};
    const modelIds = [...new Set([...Object.keys(models), ...Object.keys(clientModelCosts[client] || {})])];
    let modeledTokens = 0;
    let modeledCost = 0;
    for (const modelId of modelIds) {
      const modelTokens = Math.max(0, Math.round(num(models[modelId])));
      const modelCost = Math.max(0, num(clientModelCosts[client]?.[modelId]));
      addObservation(client, modelId, modelTokens, modelCost);
      modeledTokens += modelTokens;
      modeledCost += modelCost;
    }
    const clientTokens = Math.max(0, Math.round(num(clients[client])));
    const clientCost = Math.max(0, num(clientCosts[client]));
    const remainderTokens = Math.max(0, clientTokens - modeledTokens);
    const terms = Math.max(modelIds.length, Object.keys(period.sessions || {}).length);
    const remainderCost = legacyCostsEqual(clientCost, modeledCost, terms) ? 0 : Math.max(0, clientCost - modeledCost);
    if (modelIds.length === 0 || remainderTokens > 0 || remainderCost > 0) {
      addObservation(client, 'unknown', remainderTokens, remainderCost);
    }
  }

  const totalTokens = Math.max(0, Math.round(num(period.totalTokens)));
  const totalCost = Math.max(0, num(period.costUsd));
  const observed = [...observations.values()];
  const observedTokens = observed.reduce((sum, observation) => sum + observation.tokens, 0);
  const observedCost = observed.reduce((sum, observation) => sum + observation.cost, 0);
  const remainderCost = legacyCostsEqual(totalCost, observedCost, Math.max(observed.length, Object.keys(period.sessions || {}).length))
    ? 0 : Math.max(0, totalCost - observedCost);
  if (totalTokens > observedTokens || remainderCost > 0) {
    addObservation(
      'unknown',
      'unknown',
      Math.max(0, totalTokens - observedTokens),
      remainderCost
    );
  }

  const hasKnownComponents = num(period.cacheReadTokens)
    + num(period.cacheWriteTokens)
    + num(period.outputTokens) > 0;
  const componentSummary = totalTokens > 0
    && (period.capabilities?.tokenComponents === true || hasKnownComponents)
    ? {
        tokenComponentsAvailable: period.capabilities?.tokenComponents === true,
        cacheReadTokens: num(period.cacheReadTokens),
        cacheWriteTokens: num(period.cacheWriteTokens),
        outputTokens: num(period.outputTokens),
        unclassifiedTokens: num(period.unclassifiedTokens),
        perClient: Object.fromEntries([...clientIds].map((client) => [client, {
          cacheReadTokens: num(period.clientCacheReads?.[client]),
          cacheWriteTokens: num(period.clientCacheWrites?.[client]),
          outputTokens: num(period.clientOutputs?.[client]),
          unclassifiedTokens: num(period.clientUnclassifiedTokens?.[client])
        }])),
        perModel: Object.fromEntries(Object.keys(period.models || {}).map((model) => [model, {
          cacheReadTokens: num(period.modelCacheReads?.[model]),
          cacheWriteTokens: num(period.modelCacheWrites?.[model]),
          outputTokens: num(period.modelOutputs?.[model]),
          unclassifiedTokens: num(period.modelUnclassifiedTokens?.[model])
        }]))
      }
    : null;
  const day = normalizeDay({
    date,
    activeTimeMs: 0,
    observations: [...observations.values()],
    ...(componentSummary ? { componentSummary } : {})
  }, date);
  return day && Object.keys(day.observations).length > 0 ? day : null;
}

function dayTokens(day) {
  return Object.values(day?.observations || {}).reduce((sum, observation) => sum + num(observation.tokens), 0);
}

function dayCost(day) {
  return Object.values(day?.observations || {}).reduce((sum, observation) => sum + num(observation.cost), 0);
}

function dayComponentQuality(day) {
  if (day?.componentSummary?.tokenComponentsAvailable === true) return 2;
  if (day?.componentSummary) return 1;
  const usage = Object.values(day?.observations || {}).filter((observation) => num(observation.tokens) > 0);
  if (usage.length === 0 || usage.every((observation) => observation.tokenComponentsAvailable === true)) return 2;
  return usage.some((observation) => (
    num(observation.cacheReadTokens) > 0
    || num(observation.cacheWriteTokens) > 0
    || num(observation.outputTokens) > 0
  )) ? 1 : 0;
}

function liveDayIsGreater(incoming, previous) {
  const incomingTokens = dayTokens(incoming);
  const previousTokens = dayTokens(previous);
  if (incomingTokens !== previousTokens) return incomingTokens > previousTokens;
  const qualityDifference = dayComponentQuality(incoming) - dayComponentQuality(previous);
  if (qualityDifference !== 0) return qualityDifference > 0;
  // Equal usage can receive a corrected price in either direction. The later
  // live observation is authoritative once its provenance quality is equal.
  return dayCost(incoming) !== dayCost(previous);
}

// A changed pricing revision makes matching graph usage authoritative, even
// when its new cost is zero. Otherwise preserve live prices, with Cursor's
// existing positive-graph-price preference and live fallback for missing cost.
function withReconciledGraphCosts(day, graphDay, liveDay, reprice = false, pricingRevision) {
  let changed = false;
  const observations = Object.fromEntries(Object.entries(day.observations).map(([key, observation]) => {
    const graphObservation = graphDay.observations[key];
    const liveObservation = liveDay.observations[key];
    const revisionChanged = typeof pricingRevision === 'string'
      && liveObservation?.pricingRevision !== pricingRevision;
    const useGraphPrice = reprice || revisionChanged;
    const isCursor = normalizeTokscaleClientName(observation.client) === 'cursor';
    if ((!useGraphPrice && typeof pricingRevision !== 'string' && !isCursor)
      || !graphObservation
      || !liveObservation
      || num(graphObservation.tokens) !== num(liveObservation.tokens)) {
      return [key, observation];
    }
    const cost = useGraphPrice || (isCursor && num(graphObservation.cost) > 0)
      ? graphObservation.cost : liveObservation.cost;
    if (num(cost) === num(observation.cost)
      && (typeof pricingRevision !== 'string' || observation.pricingRevision === pricingRevision)) return [key, observation];
    changed = true;
    return [key, {
      ...observation, cost,
      ...(typeof pricingRevision === 'string' ? { pricingRevision } : {})
    }];
  }));
  return changed ? { ...day, observations } : day;
}

function mergeLiveDayMetadata(liveDay, previousDay) {
  if (!previousDay) return liveDay;
  const observations = Object.fromEntries(Object.entries(liveDay.observations).map(([key, observation]) => {
    const previous = previousDay.observations[key];
    if (!previous) return [key, observation];
    if (liveDay.componentSummary) {
      return [key, {
        ...observation,
        messages: Math.max(observation.messages, previous.messages),
        ...(Math.max(num(observation.reasoningTokens), num(previous.reasoningTokens)) > 0
          ? { reasoningTokens: Math.max(num(observation.reasoningTokens), num(previous.reasoningTokens)) }
          : {})
      }];
    }
    const incomingTokens = num(observation.tokens);
    const previousTokens = num(previous.tokens);
    const canRetainPreviousComponents = incomingTokens >= previousTokens;
    const previousUnclassified = Math.min(previousTokens, num(previous.unclassifiedTokens));
    const unclassifiedTokens = canRetainPreviousComponents
      ? previousUnclassified + (incomingTokens - previousTokens)
      : incomingTokens;
    return [key, {
      ...observation,
      messages: Math.max(observation.messages, previous.messages),
      ...(canRetainPreviousComponents && previousTokens - previousUnclassified > 0 ? {
        cacheReadTokens: num(previous.cacheReadTokens),
        cacheWriteTokens: num(previous.cacheWriteTokens),
        outputTokens: num(previous.outputTokens)
      } : {}),
      unclassifiedTokens,
      tokenComponentsAvailable: unclassifiedTokens === 0,
      ...(Math.max(num(observation.reasoningTokens), num(previous.reasoningTokens)) > 0
        ? { reasoningTokens: Math.max(num(observation.reasoningTokens), num(previous.reasoningTokens)) }
        : {})
    }];
  }));
  return {
    ...liveDay,
    activeTimeMs: Math.max(liveDay.activeTimeMs, previousDay.activeTimeMs),
    observations
  };
}

function captureLiveDailyHistory(existingArchive, period, options = {}) {
  const archive = normalizeDailyHistoryArchive(existingArchive);
  const date = String(options.todayKey || '').slice(0, 10);
  if (DAY_KEY_RE.test(date) && archive.liveDays) {
    for (const liveDate of Object.keys(archive.liveDays)) {
      if (liveDate > date) delete archive.liveDays[liveDate];
    }
  }
  const incoming = periodLiveDay(period, date);
  if (!incoming) return archive;
  const sourceFamilies = new Set(Object.values(archive.sourceLedger?.scopes || {}).flatMap(scope => scope.clients).map(sourceProjectionClient));
  for (const [key, observation] of Object.entries(incoming.observations)) {
    if (sourceFamilies.has(observation.client)) delete incoming.observations[key];
  }
  if (!Object.keys(incoming.observations).length) return archive;
  if (sourceFamilies.size) delete incoming.componentSummary;
  if (typeof options.pricingRevision === 'string') {
    for (const observation of Object.values(incoming.observations)) {
      observation.pricingRevision = options.pricingRevision;
    }
  }
  const previous = archive.liveDays?.[date];
  const equalUsage = previous && dayTokens(incoming) === dayTokens(previous);
  // Revision provenance comes from the retained rows, not a missing model key.
  // Equal totals can also be reattributed by a parser correction independently
  // of pricing. Keep the incoming identities and merge only matching metadata.
  const revisionChanged = equalUsage && typeof options.pricingRevision === 'string'
    && Object.values(previous.observations).some(observation => (
      observation.pricingRevision !== options.pricingRevision
    ));
  const attributionChanged = equalUsage && (
    Object.keys(incoming.observations).length !== Object.keys(previous.observations).length
    || Object.entries(incoming.observations).some(([key, observation]) => (
      observation.tokens !== previous.observations[key]?.tokens
    ))
  );
  if (!previous || liveDayIsGreater(incoming, previous) || revisionChanged || attributionChanged) {
    let selected = incoming;
    if (equalUsage && dayComponentQuality(incoming) < dayComponentQuality(previous)) {
      selected = mergeLiveDayMetadata(incoming, previous);
      // A whole-day component summary is reusable only for identical attribution.
      if (!attributionChanged && previous.componentSummary) {
        selected.componentSummary = previous.componentSummary;
      }
    }
    archive.liveDays = { ...(archive.liveDays || {}), [date]: selected };
  }
  return archive;
}

function graphTimeMetrics(graphs, activeTimeMs) {
  const source = graphsArray(graphs)
    .map((graph) => graph.timeMetrics ?? graph.time_metrics)
    .find((value) => value && typeof value === 'object');
  if (!source) return null;
  return {
    ...source,
    totalActiveTimeMs: Math.max(
      num(source.totalActiveTimeMs ?? source.total_active_time_ms),
      activeTimeMs
    )
  };
}

function dayContribution(day) {
  return {
    date: day.date,
    activeTimeMs: day.activeTimeMs,
    ...(day.componentSummary ? { tokenComponentSummary: day.componentSummary } : {}),
    clients: Object.values(day.observations || {}).map(observation => ({
      client: observation.client, modelId: observation.modelId,
      ...(observation.providerId ? { providerId: observation.providerId } : {}),
      tokens: {
        input: Math.max(0, observation.tokens - num(observation.outputTokens)
          - num(observation.cacheReadTokens) - num(observation.cacheWriteTokens)),
        output: num(observation.outputTokens), cacheRead: num(observation.cacheReadTokens),
        cacheWrite: num(observation.cacheWriteTokens), reasoning: 0
      },
      tokenComponentsAvailable: observation.tokenComponentsAvailable === true,
      ...(num(observation.unclassifiedTokens) > 0 ? { unclassifiedTokens: num(observation.unclassifiedTokens) } : {}),
      cost: observation.cost, messages: observation.messages,
      ...(observation.unpricedTokens > 0 ? { unpricedTokens: observation.unpricedTokens } : {})
    }))
  };
}

function graphFromDailyHistoryArchive(graphs, archive, options = {}) {
  const normalizedArchive = options.canonical === true ? archive : graphsArray(graphs).length
    ? captureDailyHistoryArchive(archive, graphs, options) : normalizeDailyHistoryArchive(archive);
  const currentDays = new Map();
  const todayKey = String(options.todayKey || '').slice(0, 10);
  const hasTodayKey = DAY_KEY_RE.test(todayKey);

  for (const [date, day] of Object.entries(normalizedArchive.days)) {
    if (hasTodayKey && date > todayKey) continue;
    currentDays.set(date, day);
  }
  for (const [date, liveDay] of Object.entries(normalizedArchive.liveDays || {})) {
    if (hasTodayKey && date > todayKey) continue;
    const previous = currentDays.get(date);
    if (!previous) {
      currentDays.set(date, liveDay);
    } else {
      const selected = liveDayIsGreater(liveDay, previous) ? mergeLiveDayMetadata(liveDay, previous) : previous;
      currentDays.set(date, withReconciledGraphCosts(selected, previous, liveDay, options.reprice === true));
    }
  }

  const sourceUsage = normalizedArchive.sourceLedger ? projectSourceLedger(normalizedArchive.sourceLedger, options) : null;
  const projected = Object.fromEntries(currentDays);
  removeSourceClients(projected, new Set((sourceUsage?.ownedClients || []).map(sourceProjectionClient)));
  currentDays.clear();
  for (const [date, day] of Object.entries(projected)) currentDays.set(date, day);
  const sourceDaysToProject = [
    ...(sourceUsage?.sessions || []).flatMap(row => Object.values(sourceDays(row.days, row.client) || {})),
    ...(sourceUsage?.aggregates || [])
  ];
  for (const sourceDay of sourceDaysToProject) {
    const date = sourceDay.date;
    if (hasTodayKey && date > todayKey) continue;
    const day = currentDays.get(date) || { date, activeTimeMs: 0, observations: {} };
    for (const observation of Object.values(sourceDay.observations || {})) {
      const canonical = normalizeObservation(observation);
      if (!canonical) continue;
      const key = observationKey(canonical);
      day.observations[key] = addObservation(day.observations[key], canonical);
    }
    delete day.componentSummary;
    currentDays.set(date, day);
  }

  const contributions = [...currentDays.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map(day => dayContribution({ ...day, observations: Object.values(day.observations)
      .sort((left, right) => sourceObservationKey(left).localeCompare(sourceObservationKey(right))) }));
  const activeTimeMs = contributions.reduce((sum, day) => sum + num(day.activeTimeMs), 0);
  const timeMetrics = graphTimeMetrics([normalizedArchive], activeTimeMs);
  return { contributions, ...(timeMetrics ? { timeMetrics } : {}),
    ...(sourceUsage ? { sourceUsage } : {}) };
}

function dailyHistoryArchivePath(options = {}) {
  return options.path || path.join(sharedDataDir(options), 'daily-history-archive.json');
}

function validateDailyHistoryArchiveDocument(value, filePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Could not parse JSON in ${filePath}: archive root must be an object`);
  }
  for (const key of ['days', 'liveDays', 'unresolvedDays', 'sourceLedger']) {
    if (Object.prototype.hasOwnProperty.call(value, key)
      && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) {
      throw new Error(`Could not parse JSON in ${filePath}: ${key} must be an object`);
    }
  }
  return value;
}

function readDailyHistoryArchive(options = {}) {
  const filePath = dailyHistoryArchivePath(options);
  if (typeof options.readJson === 'function') {
    return normalizeDailyHistoryArchive(
      validateDailyHistoryArchiveDocument(options.readJson(filePath, {}), filePath)
    );
  }
  let content;
  let signature;
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const cached = archiveReadCache.get(filePath);
    if (options.fresh !== true && cached?.signature === signature) return cached.archive;
    content = fs.readFileSync(filePath, 'utf8');
    if (cached?.signature === signature && cached.content === content) return cached.archive;
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeDailyHistoryArchive({});
    throw error;
  }
  if (!content.trim()) {
    throw new Error(`Could not parse JSON in ${filePath}: archive is empty`);
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const parseError = new Error(`Could not parse JSON in ${filePath}: ${error.message}`);
    parseError.cause = error;
    throw parseError;
  }
  const archive = normalizeDailyHistoryArchive(validateDailyHistoryArchiveDocument(parsed, filePath));
  if (archiveReadCache.size >= 64) archiveReadCache.clear();
  archiveReadCache.set(filePath, { signature, archive, content });
  return archive;
}

function writeDailyHistoryArchive(archive, options = {}) {
  const write = options.writeJsonAtomic || writeJsonAtomic;
  write(dailyHistoryArchivePath(options), normalizeDailyHistoryArchive(archive));
  archiveReadCache.delete(dailyHistoryArchivePath(options));
}

function clearDailyHistoryArchive(options = {}) {
  const unlink = options.unlinkSync || fs.unlinkSync;
  try {
    unlink(dailyHistoryArchivePath(options));
    archiveReadCache.delete(dailyHistoryArchivePath(options));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function mergeLiveDaysIntoArchive(existingArchive, liveDays) {
  const archive = normalizeDailyHistoryArchive(existingArchive);
  const incoming = normalizeDailyHistoryArchive({ liveDays }).liveDays || {};
  removeSourceClients(incoming, new Set(Object.values(archive.sourceLedger?.scopes || {}).flatMap(scope => scope.clients).map(sourceProjectionClient)));
  for (const [date, liveDay] of Object.entries(incoming)) {
    const previous = archive.liveDays?.[date];
    if (!previous || liveDayIsGreater(liveDay, previous)) {
      archive.liveDays = { ...(archive.liveDays || {}), [date]: liveDay };
    }
  }
  return archive;
}

function archiveWriteEnabled(options = {}) {
  return typeof options.writeEnabled === 'function'
    ? options.writeEnabled() !== false
    : options.writeEnabled !== false;
}

function retainDailyHistory(graphs, options = {}) {
  const previous = readDailyHistoryArchive(options);
  let committedArchive = previous;
  const pendingLocks = new Set((options.sourceArchiveSnapshot?.scopes || [])
    .filter(scope => scope.blockNativeWatch === true).map(scope => scope.id));
  const priorScopes = new Map((options.sourceArchiveSnapshot?.scopes || []).map(scope => [scope.id, scope]));
  const knownHealthy = (id, scope) => {
    const prior = priorScopes.get(id);
    // Prior watch eligibility survives a timeout, but cannot grant replacement
    // authority or override a newer disk observation/lock.
    return prior && prior.blockNativeWatch !== true && prior.mode === scope.mode
      && isDeepStrictEqual(prior.clients, scope.clients)
      && Boolean(prior.acceptedAt || prior.observationFrontier)
      && prior.acceptedAt === scope.acceptedAt && prior.observationFrontier === scope.observationFrontier;
  };
  const lockArchive = (archive) => {
    for (const [id, scope] of Object.entries(archive.sourceLedger?.scopes || {})) {
      if (scope.blockNativeWatch || options.sourceGraphUnavailable && !knownHealthy(id, scope)) pendingLocks.add(id);
    }
    if (!pendingLocks.size) return archive;
    const locked = normalizeDailyHistoryArchive(structuredClone(archive));
    for (const [id, scope] of Object.entries(locked.sourceLedger?.scopes || {})) {
      if (pendingLocks.has(id)) scope.blockNativeWatch = true;
    }
    return locked;
  };
  const releasesWatchLock = archive => [...pendingLocks].some(id =>
    archive.sourceLedger?.scopes[id] && !archive.sourceLedger.scopes[id].blockNativeWatch);
  const requiresWrite = (before, after) => !isDeepStrictEqual(before, after) || releasesWatchLock(after);
  // Only persisted aggregates can establish a legacy migration boundary.
  // This tick's transient native Today overlay is folded after acceptance.
  const capture = (archive) => mergeLiveDaysIntoArchive(
    captureDailyHistoryArchive(lockArchive(archive), graphs, options), options.liveDays
  );
  let next = capture(previous);
  let committed = false;
  // Ownership can change while a graph scan is running (for example, a
  // headless agent starts after Electron's collector tick begins). Resolve a
  // lazy guard immediately before the write instead of freezing it at startup.
  if (archiveWriteEnabled(options) && requiresWrite(previous, next)) {
    // The graph scan can take long enough for the other collector to update the
    // shared archive. Rebase on the latest file immediately before writing so
    // this scan cannot put that newer observation back on disk.
    const latest = readDailyHistoryArchive({ ...options, fresh: true });
    committedArchive = latest;
    next = capture(latest);
    if (archiveWriteEnabled(options) && requiresWrite(latest, next)) {
      try {
        writeDailyHistoryArchive(next, options);
        committed = true;
      } catch (error) {
        // A failed commit grants no new authority. Keep committed accounting,
        // with in-memory watch locks until a later full scan can commit again.
        const committed = normalizeDailyHistoryArchive(structuredClone(latest));
        const scopes = Object.values(committed.sourceLedger?.scopes || {});
        if (scopes.length) {
          for (const scope of scopes) scope.blockNativeWatch = true;
          error.retainedGraph = graphFromDailyHistoryArchive([], committed, { ...options, canonical: true });
        }
        throw error;
      }
    }
  }
  // A complete reread of identical accounting must still commit before it can
  // release a process-local rejection lock. A disabled writer grants no release.
  if (!committed && releasesWatchLock(next)) next = lockArchive(committedArchive);
  return graphFromDailyHistoryArchive([], next, { ...options, canonical: true });
}

function retainLiveDailyHistory(period, options = {}) {
  const projection = options.sourceProjection;
  if (projection?.version === 2 && projection.accountingOwner === 'app') {
    const owned = new Set((projection.ownedClients || []).map(sourceProjectionClient));
    const clients = Object.keys(period?.clients || {});
    const costs = Object.keys(period?.clientCosts || {});
    // Nothing from this tick belongs to generic daily retention. In particular
    // activity-only ticks must not read/normalize the retained event ledger.
    if (clients.every(client => owned.has(sourceProjectionClient(client)))
      && costs.every(client => owned.has(sourceProjectionClient(client)))
      && clients.reduce((sum, client) => sum + num(period.clients[client]), 0) === num(period?.totalTokens)
      && Math.abs(costs.reduce((sum, client) => sum + num(period.clientCosts[client]), 0) - num(period?.costUsd)) < 1e-9) {
      return { version: ARCHIVE_VERSION, days: {}, liveDays: options.liveDays || {} };
    }
  }
  const previous = readDailyHistoryArchive(options);
  const capture = (archive) => captureLiveDailyHistory(
    mergeLiveDaysIntoArchive(archive, options.liveDays),
    period,
    options
  );
  let next = capture(previous);
  if (archiveWriteEnabled(options) && !isDeepStrictEqual(previous, next)) {
    const latest = readDailyHistoryArchive({ ...options, fresh: true });
    next = capture(latest);
    if (archiveWriteEnabled(options) && !isDeepStrictEqual(latest, next)) {
      writeDailyHistoryArchive(next, options);
    }
  }
  return next;
}

module.exports = {
  sourceSnapshotsFromGraphs,
  captureDailyHistoryArchive,
  clearDailyHistoryArchive,
  dailyHistoryArchivePath,
  graphFromDailyHistoryArchive,
  captureLiveDailyHistory,
  normalizeDailyHistoryArchive,
  observationKey,
  readDailyHistoryArchive,
  retainDailyHistory,
  retainLiveDailyHistory,
  shouldReplaceObservation,
  writeDailyHistoryArchive
};
