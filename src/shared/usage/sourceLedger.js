'use strict';

// The scanner owns identities/read evidence. This document owns accounting.
// Nothing in this module infers dedup families from App presentation aliases.
const { isDeepStrictEqual } = require('node:util');
const { normalizeClientName, normalizePeriod } = require('../usage');
const { classifySessionSourcePath, ownedSessionSourcePath } = require('./sessionSourceState');
const { isSessionUsageArchiveEntryEvidence } = require('./sessionUsageArchive');
const canonicalLedgers = new WeakSet();
const projections = new WeakMap();
const projectionLedgers = new WeakMap();
const formatters = new Map();
const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];
const LEGACY_SESSION_FIELDS = ['client', 'sessionId', 'totalTokens', 'costUsd', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'unclassifiedTokens', 'models', 'modelCosts'];

// Regrouping n nonnegative monetary terms can change the last few binary
// digits. This is a relative summation allowance, never a dollar floor or a
// rounding of the selected observation. Integers and identities stay exact.
function legacyCostsEqual(left, right, terms = 1, scale = Math.max(left, right)) {
  return Number.isFinite(left) && Number.isFinite(right) && left >= 0 && right >= 0
    && Number.isFinite(scale) && scale >= 0 && Number.isSafeInteger(terms) && terms >= 0
    && (left === right || Math.abs(left - right) <= 8 * Number.EPSILON * Math.max(1, terms) * scale);
}

function legacyCostMapsEqual(left = {}, right = {}, tokens = {}, terms = 1, residualScale = 0) {
  const scale = Math.max(Object.values(left).reduce((sum, cost) => sum + cost, 0),
    Object.values(right).reduce((sum, cost) => sum + cost, 0), residualScale);
  return Object.keys({ ...left, ...right }).every(key => {
    if (Object.hasOwn(left, key) && Object.hasOwn(right, key)) return legacyCostsEqual(left[key], right[key], terms);
    return key === 'unknown' && !tokens[key] && legacyCostsEqual(left[key] ?? right[key], 0, terms, scale);
  });
}

function legacyDaysMatch(left, right, terms = 1) {
  if (left.date !== right.date || !isDeepStrictEqual(left.componentSummary, right.componentSummary)) return false;
  const a = left.observations || {}, b = right.observations || {};
  terms = Math.max(terms, Object.keys(a).length, Object.keys(b).length);
  return Object.keys({ ...a, ...b }).every(key => {
    const first = a[key], second = b[key];
    if (first && second) {
      const { cost: x, ...identity } = first, { cost: y, ...other } = second;
      return isDeepStrictEqual(identity, other) && legacyCostsEqual(x, y, terms);
    }
    const row = first || second;
    if (row.client !== 'unknown' && row.modelId !== 'unknown' || row.tokens !== 0 || row.messages !== 0
      || row.providerId || row.pricingRevision
      || ['outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'unclassifiedTokens', 'reasoningTokens'].some(field => row[field])) return false;
    const scale = Math.max(...[a, b].map(observations => Object.values(observations)
      .filter(other => row.client === 'unknown' || other.client === row.client).reduce((sum, other) => sum + other.cost, 0)));
    return legacyCostsEqual(row.cost, 0, terms, scale);
  });
}

function legacyAllocationMatches(period, allocation, terms) {
  const exact = ['totalTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'unclassifiedTokens',
    'clients', 'models', 'clientModels', 'clientOutputs', 'clientCacheReads', 'clientCacheWrites', 'clientUnclassifiedTokens',
    'modelOutputs', 'modelCacheReads', 'modelCacheWrites', 'modelUnclassifiedTokens'];
  if (exact.some(field => !isDeepStrictEqual(period[field], allocation[field]))
    || !legacyCostsEqual(period.costUsd, allocation.costUsd, terms)
    || !legacyCostMapsEqual(period.clientCosts, allocation.clientCosts, period.clients, terms)
    || !legacyCostMapsEqual(period.modelCosts, allocation.modelCosts, period.models, terms)) return false;
  return Object.keys({ ...period.clientModelCosts, ...allocation.clientModelCosts }).every(client =>
    legacyCostMapsEqual(period.clientModelCosts[client], allocation.clientModelCosts[client], period.clientModels[client], terms,
      client === 'unknown' && !period.clients[client] ? Math.max(period.costUsd, allocation.costUsd) : 0));
}

function legacySessionAccounting(value) {
  const select = row => Object.fromEntries(LEGACY_SESSION_FIELDS.filter(field => row[field] !== undefined).map(field => [field, row[field]]));
  const sessions = Object.fromEntries(Object.entries(value || {}).filter(([key, row]) => rawClient(row?.client)
    && sessionId(row.sessionId) && key === `${row.client}:${row.sessionId}`).map(([key, row]) => [key, select(row)]));
  return Object.fromEntries(Object.entries(normalizePeriod({ sessions }).sessions).map(([key, row]) => [key, select(row)]));
}

function retainedLegacyDay(day) {
  const { sessionAllocation, ...accounting } = day;
  const record = value => value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const valid = record(sessionAllocation) && Reflect.ownKeys(sessionAllocation).every(key => {
    const row = sessionAllocation[key];
    return typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(sessionAllocation, key)
      && isSessionUsageArchiveEntryEvidence(key, { client: row?.client, sessionId: row?.sessionId, periods: { today: row } })
      && ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'unclassifiedTokens']
        .every(field => row[field] === undefined || Number.isSafeInteger(row[field]) && row[field] >= 0);
  });
  // Invalid optional attribution cannot change the retained observation or
  // its ownership. Leave allocation unknown rather than sanitize a bad row.
  return { ...accounting, ...(valid ? { sessionAllocation: legacySessionAccounting(sessionAllocation) } : {}) };
}

// A day's allocation belongs to its whole observation. Equal totals alone
// cannot attach sessions from a competing model/cost/component observation.
function selectLegacyDay(previous, candidate) {
  if (!previous) return candidate;
  const totals = day => Object.values(day.observations || {}).reduce((sum, row) => ({
    tokens: sum.tokens + (row.tokens || 0), cost: sum.cost + (row.cost || 0) }), { tokens: 0, cost: 0 });
  const next = totals(candidate), old = totals(previous);
  if (next.tokens > old.tokens || next.tokens === old.tokens && next.cost > old.cost) return candidate;
  if (!previous.sessionAllocation && candidate.sessionAllocation
    && legacyDaysMatch(previous, candidate, Object.keys(candidate.sessionAllocation).length)) {
    return { ...previous, sessionAllocation: candidate.sessionAllocation };
  }
  return previous;
}

function legacyPeriods(value) {
  const periods = {};
  for (const name of ['today', 'month', 'allTime']) {
    const row = value?.[name];
    if (!row) continue;
    if (!row.period || typeof row.period !== 'object'
      || (name === 'today' && !/^\d{4}-\d{2}-\d{2}$/.test(row.day))
      || (name === 'month' && !/^\d{4}-\d{2}$/.test(row.month))) throw new Error('Invalid retained legacy period evidence');
    const sessions = legacySessionAccounting(row.period.sessions);
    periods[name] = { ...(name === 'today' ? { day: row.day } : name === 'month' ? { month: row.month } : {}),
      period: normalizePeriod({ ...row.period, sessions }) };
  }
  return periods;
}

function largerLegacyPeriod(candidate, previous, name) {
  if (!previous) return true;
  const field = name === 'today' ? 'day' : 'month';
  if (name !== 'allTime' && candidate[field] !== previous[field]) return candidate[field] > previous[field];
  return candidate.period.totalTokens > previous.period.totalTokens
    || candidate.period.totalTokens === previous.period.totalTokens && candidate.period.costUsd > previous.period.costUsd;
}

function advanceLegacyBoundary(scope, boundary) {
  const periods = legacyPeriods(boundary?.periods);
  scope.legacyPeriods ||= {};
  for (const [name, candidate] of Object.entries(periods)) {
    if (largerLegacyPeriod(candidate, scope.legacyPeriods[name], name)) scope.legacyPeriods[name] = candidate;
  }
  scope.legacyDays ||= {};
  for (const [date, day] of Object.entries(boundary?.days || {})) {
    scope.legacyDays[date] = structuredClone(selectLegacyDay(scope.legacyDays[date], day));
  }
  Object.assign(scope.sessions, boundary?.sessions);
  // This is a whole native observation of an exclusive legacy boundary, not
  // an event migration. Keep native delta anchors available for healthy watch.
  scope.blockNativeWatch = false;
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0')
    && !['__proto__', 'constructor', 'prototype'].includes(value);
}
function rawClient(value) {
  return identifier(value) && /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9_.-]+)?$/i.test(value)
    && !['unknown', 'synthetic', 'null', 'undefined'].includes(value.toLowerCase());
}
function sessionId(value) {
  // Session IDs are values inside a client-prefixed owner key, never bare map
  // keys. A legitimate SID such as __proto__ is safe in codex:__proto__.
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0')
    && !['unknown', 'unknown-session'].includes(value.toLowerCase());
}
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
function dayKey(time, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(time)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function contribution(value) {
  if (!Number.isSafeInteger(value?.timestamp) || !Number.isFinite(new Date(value.timestamp).getTime())
    || !identifier(value.modelId) || typeof value.providerId !== 'string' || !value.tokens
    || TOKEN_FIELDS.some(field => !Number.isSafeInteger(value.tokens[field]) || value.tokens[field] < 0)
    || !Number.isFinite(value.cost) || value.cost < 0 || !Number.isSafeInteger(value.messages) || value.messages < 0) return null;
  const optional = {};
  if (value.unpricedTokens !== undefined) {
    if (!Number.isSafeInteger(value.unpricedTokens) || value.unpricedTokens < 0) return null;
    optional.unpricedTokens = value.unpricedTokens;
  }
  if (value.pricing !== undefined) {
    const fields = ['unpricedTokens', 'unpricedMessages'];
    if (!value.pricing || fields.some(field => !Number.isSafeInteger(value.pricing[field]) || value.pricing[field] < 0)) return null;
    optional.pricing = Object.fromEntries(fields.map(field => [field, value.pricing[field]]));
  }
  if (value.performance !== undefined) {
    const fields = ['timedTokens', 'timedOutputTokens', 'totalDurationMs'];
    if (!value.performance || fields.some(field => !Number.isSafeInteger(value.performance[field]) || value.performance[field] < 0)) return null;
    optional.performance = Object.fromEntries(fields.map(field => [field, value.performance[field]]));
    if (value.performance.sampleCount !== undefined) {
      if (!Number.isSafeInteger(value.performance.sampleCount) || value.performance.sampleCount < 0) return null;
      optional.performance.sampleCount = value.performance.sampleCount;
    }
  }
  return { timestamp: value.timestamp, modelId: value.modelId, providerId: value.providerId,
    tokens: Object.fromEntries(TOKEN_FIELDS.map(field => [field, value.tokens[field]])), cost: value.cost, messages: value.messages, ...optional };
}
function observationKind(value) {
  return ['native', 'mirror'].includes(value) ? { observationKind: value } : {};
}
function markCanonical(ledger) {
  canonicalLedgers.add(ledger);
  return ledger;
}

function normalizeSourceLedger(value) {
  if (value && canonicalLedgers.has(value)) return value;
  if (value === undefined) return markCanonical({ version: 2, scopes: {} });
  if (value?.version !== 2 || !value.scopes || typeof value.scopes !== 'object' || Array.isArray(value.scopes)) {
    throw new Error('Invalid source ledger document; retained ownership cannot be reset');
  }
  const ledger = { version: 2, scopes: {} };
  for (const [id, row] of Object.entries(value.observations || {})) {
    if (!identifier(id) || !timestamp(row?.capturedAt) || !Array.isArray(row.clients) || row.clients.some(client => !rawClient(client))) continue;
    ledger.observations ||= {};
    ledger.observations[id] = { capturedAt: row.capturedAt, clients: row.clients, reason: String(row.reason || 'unresolved') };
  }
  for (const [id, scope] of Object.entries(value.scopes)) {
    if (!identifier(id) || !['ledger', 'legacy'].includes(scope?.mode) || !Array.isArray(scope.clients)
      || !scope.clients.length || scope.clients.some(client => !rawClient(client)) || !scope.sessions || typeof scope.sessions !== 'object' || Array.isArray(scope.sessions)
      || !scope.events || typeof scope.events !== 'object' || Array.isArray(scope.events)
      || (scope.mode === 'ledger' && (!timestamp(scope.acceptedAt) || scope.eventIdentityVersion !== 2
        || scope.proof?.fullHistory !== true || scope.proof.readStatus !== 'complete' || scope.proof.identityStatus !== 'exact'))) {
      throw new Error('Invalid source ledger scope; retained ownership cannot be reset');
    }
    const next = { mode: scope.mode, clients: [...new Set(scope.clients)].sort(), sessions: {}, events: {},
      ...(timestamp(scope.acceptedAt) ? { acceptedAt: scope.acceptedAt } : {}),
      ...(timestamp(scope.observationFrontier) ? { observationFrontier: scope.observationFrontier } : {}),
      ...(scope.mode === 'ledger' ? { eventIdentityVersion: 2, proof: { fullHistory: true, readStatus: 'complete', identityStatus: 'exact',
        ...(scope.proof.retainedBoundaryChecked === true ? { retainedBoundaryChecked: true } : {}) } } : {}),
      ...(scope.reason ? { reason: String(scope.reason) } : {}),
      ...(scope.legacyDays ? { legacyDays: Object.fromEntries(Object.entries(scope.legacyDays).map(([date, day]) => [date, retainedLegacyDay(day)])) } : {}),
      ...(scope.mode === 'legacy' && scope.legacyPeriods ? { legacyPeriods: legacyPeriods(scope.legacyPeriods) } : {}),
      ...(scope.unresolvedBoundary === true ? { unresolvedBoundary: true } : {}),
      ...(scope.blockNativeWatch === true || scope.mode === 'legacy' && scope.blockNativeWatch !== false ? { blockNativeWatch: true }
        : scope.mode === 'legacy' ? { blockNativeWatch: false } : {}) };
    for (const [key, row] of Object.entries(scope.sessions)) {
      if (!rawClient(row?.client) || !sessionId(row.sessionId) || key !== `${row.client}:${row.sessionId}`
        || !next.clients.includes(row.client)) throw new Error('Invalid source ledger inventory');
      const sourcePath = ownedSessionSourcePath(row.sourcePath);
      next.sessions[key] = { client: row.client, sessionId: row.sessionId,
        sourceState: row.sourceState === 'present' ? 'present' : row.sourceState === 'missing' && sourcePath ? 'missing' : 'unknown',
        ...(sourcePath ? { sourcePath } : {}),
        ...(timestamp(row.sourceObservedAt) ? { sourceObservedAt: row.sourceObservedAt } : {}) };
    }
    for (const [uid, event] of Object.entries(scope.events)) {
      const rows = Array.isArray(event?.contributions) ? event.contributions.map(contribution) : null;
      if (!identifier(uid) || !next.sessions[event?.ownerKey] || !rows || rows.some(row => !row)) {
        throw new Error('Invalid source ledger claim; retained accounting cannot be discarded');
      }
      // Proof observation time follows the event, not a later scope inventory
      // check. Legacy present inventory can certify its original capture only.
      const owner = next.sessions[event.ownerKey];
      const capturedAt = timestamp(event.capturedAt) ? event.capturedAt
        : owner.sourceState === 'present' && owner.sourceObservedAt === scope.acceptedAt ? scope.acceptedAt : null;
      next.events[uid] = { ownerKey: event.ownerKey, contributions: rows, ...observationKind(event.observationKind),
        ...(timestamp(capturedAt) && Date.parse(capturedAt) <= Date.parse(scope.acceptedAt)
          ? { capturedAt: new Date(capturedAt).toISOString() } : {}) };
    }
    ledger.scopes[id] = next;
  }
  return markCanonical(ledger);
}

function scansFromGraphs(graphs) {
  const scans = [];
  for (const graph of (Array.isArray(graphs) ? graphs : [graphs]).filter(Boolean)) {
    const source = graph.sourceUsage;
    if (source?.version !== 2 || source.accountingOwner === 'app' || !timestamp(source.capturedAt)
      || !Array.isArray(source.scopes) || !Array.isArray(source.sessions)) continue;
    const counts = new Map();
    for (const scope of source.scopes) counts.set(scope?.id, (counts.get(scope?.id) || 0) + 1);
    for (const scope of source.scopes) {
      if (!identifier(scope?.id) || !Array.isArray(scope.clients) || !scope.clients.length
        || scope.clients.some(client => !rawClient(client))) continue;
      const clients = [...new Set(scope.clients)].sort();
      const selected = new Set(source.replacementClients || []);
      const partial = new Set(source.partialClients || []);
      let reason = source.eventIdentityVersion !== 2 ? 'unsupported-identity-version'
        : source.fullHistory !== true ? 'partial-history'
          : scope.readStatus !== 'complete' ? `read-${scope.readStatus === 'partial' ? 'partial' : 'unknown'}`
            : scope.identityStatus !== 'exact' ? 'unresolved-identity'
              : clients.some(client => !selected.has(client) || partial.has(client)) ? 'partial-client-scope' : '';
      if (counts.get(scope.id) > 1) reason = 'duplicate-scope';
      const inventory = {};
      const events = {};
      for (const row of source.sessions.filter(row => row?.scopeId === scope.id)) {
        const key = `${row.client}:${row.sessionId}`;
        if (!clients.includes(row.client) || !sessionId(row.sessionId) || !Array.isArray(row.events) || inventory[key]) {
          reason = 'identity-gap'; continue;
        }
        inventory[key] = { client: row.client, sessionId: row.sessionId, sourceState: 'present', sourceObservedAt: source.capturedAt };
        for (const event of row.events) {
          const rows = Array.isArray(event?.contributions) ? event.contributions.map(contribution) : null;
          if (!identifier(event?.id) || !rows || rows.some(row => !row) || events[event.id]) { reason = 'identity-gap'; continue; }
          events[event.id] = { ownerKey: key, contributions: rows, ...observationKind(event.observationKind),
            capturedAt: new Date(source.capturedAt).toISOString() };
        }
      }
      if (clients.some(client => Number(source.rowsWithoutIdentity?.[client] || 0) !== 0)) reason = 'identity-gap';
      // A row cannot escape validation by naming a non-inventoried scope.
      if (source.sessions.some(row => clients.includes(row?.client) && !source.scopes.some(scope => scope?.id === row.scopeId))) reason = 'identity-gap';
      scans.push({ id: scope.id, clients, capturedAt: source.capturedAt, reason, sessions: inventory, events, graph });
    }
  }
  return scans;
}

function sourceSnapshotsFromGraphs(graphs) {
  const sessions = new Map();
  for (const scan of scansFromGraphs(graphs)) if (!scan.reason) {
    for (const [key, row] of Object.entries(scan.sessions)) sessions.set(key, { ...row, scopeId: scan.id,
      capturedAt: scan.capturedAt, eventIdentityVersion: 2 });
  }
  return sessions;
}

function frontier(scope) {
  return Math.max(Date.parse(scope?.acceptedAt) || 0, Date.parse(scope?.observationFrontier) || 0);
}
function hasUsage(days) {
  return Object.values(days || {}).some(day => Object.values(day.observations || {}).some(row => row.tokens || row.cost || row.messages));
}
function scopeDays(scope, timeZone) {
  const owners = new Map();
  for (const event of Object.values(scope.events)) {
    let days = owners.get(event.ownerKey);
    if (!days) { days = new Map(); owners.set(event.ownerKey, days); }
    const row = scope.sessions[event.ownerKey];
    for (const value of event.contributions) {
      const date = dayKey(value.timestamp, timeZone);
      let day = days.get(date);
      if (!day) { day = { date, clients: [] }; days.set(date, day); }
      day.clients.push({ client: row.client, modelId: value.modelId, providerId: value.providerId,
        tokens: value.tokens, cost: value.cost, messages: value.messages,
        ...(value.pricing ? { pricing: value.pricing, unpricedTokens: value.pricing.unpricedTokens } : {}),
        ...(value.unpricedTokens !== undefined ? { unpricedTokens: value.unpricedTokens } : {}),
        ...(value.performance ? { performance: value.performance } : {}) });
    }
  }
  return owners;
}

function migrationMatches(scope, scan) {
  return !scope.unresolvedBoundary && !hasUsage(scope.legacyDays)
    && scope.clients.every(client => scan.clients.includes(client));
}

function captureSourceLedger(value, graphs, options = {}) {
  let ledger = normalizeSourceLedger(value);
  let copied = false;
  const edit = () => {
    if (!copied) { ledger = structuredClone(ledger); copied = true; }
  };
  const rejectedGraphs = new Set();
  const rejectedClients = new Set();
  const accepted = new Map();
  const scans = scansFromGraphs(graphs).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  // Presentation aliases never change exact claim identities. They do define
  // the boundary of older stores, which cannot distinguish those raw clients.
  const canonicalClient = options.canonicalClient || normalizeClientName;
  const canonicalOverlap = (left, right) => left.some(client => right.some(other => canonicalClient(client) === canonicalClient(other)));
  for (const scan of scans) {
    const previous = ledger.scopes[scan.id];
    const canonicalOwned = Object.values(ledger.scopes).some(scope => scope.mode === 'ledger'
      && scope.proof.retainedBoundaryChecked === true && canonicalOverlap(scope.clients, scan.clients));
    const overlaps = Object.entries(ledger.scopes).filter(([id, scope]) => id !== scan.id
      && (scope.mode === 'legacy' ? canonicalOverlap(scope.clients, scan.clients) : scope.clients.some(client => scan.clients.includes(client))));
    const time = Date.parse(scan.capturedAt);
    if (Math.max(frontier(previous), Date.parse(ledger.observations?.[scan.id]?.capturedAt) || 0, ...overlaps.map(([, scope]) => frontier(scope))) > time) {
      rejectedGraphs.add(scan.graph); scan.clients.forEach(client => rejectedClients.add(client)); continue;
    }
    let reason = scan.reason;
    if (options.nativeRawClients === null) reason ||= 'native-accounting-unavailable';
    const observedClients = new Set([...(options.nativeRawClients || []),
      ...(Array.isArray(scan.graph.contributions) ? scan.graph.contributions : [])
        .flatMap(day => (Array.isArray(day?.clients) ? day.clients : []).map(row => row?.client)).filter(rawClient)]);
    const unresolvedPeer = scans.some(other => other.graph === scan.graph && other.id !== scan.id
      && (other.reason || scan.reason) && canonicalOverlap(scan.clients, other.clients))
      || [...observedClients].some(client => canonicalOverlap(scan.clients, [client])
        && !scans.some(other => other.graph === scan.graph && other.clients.includes(client) && !other.reason));
    if (unresolvedPeer) reason ||= 'canonical-legacy-scope';
    if (overlaps.some(([, scope]) => scope.mode === 'ledger')) reason = 'scope-identity-change';
    if (previous?.mode === 'ledger' && !isDeepStrictEqual(previous.clients, scan.clients)) reason = 'scope-client-change';
    const legacy = [...overlaps, ...(previous?.mode === 'legacy' ? [[scan.id, previous]] : [])];
    if (!previous && !legacy.length && !canonicalOwned && options.retainedBoundaryChecked !== true) reason ||= 'retained-evidence-unavailable';
    const boundary = options.legacyBoundary?.(scan.clients, scan.graph);
    // Aggregate history supplies no identity proof, even when its totals match.
    if (!previous && !legacy.length && !canonicalOwned && boundary?.hasRetainedUsage) reason ||= 'unresolved-legacy-boundary';
    if (previous?.mode === 'ledger' && previous.proof.retainedBoundaryChecked !== true && boundary?.hasRetainedUsage) {
      reason ||= 'unresolved-legacy-boundary';
    }
    if (!reason && legacy.some(([, scope]) => !migrationMatches(scope, scan))) reason = 'unresolved-legacy-boundary';
    if (previous?.acceptedAt === scan.capturedAt && previous.mode === 'ledger') {
      const same = Object.keys(scan.sessions).every(key => previous.sessions[key])
        && Object.entries(scan.events).every(([uid, event]) => isDeepStrictEqual(previous.events[uid], event))
        && Object.entries(previous.events).every(([uid, event]) => !scan.sessions[event.ownerKey] || scan.events[uid]);
      if (same && !reason && !previous.blockNativeWatch) continue;
      if (!same) reason ||= 'conflicting-revision';
    }
    edit();
    if (reason) {
      ledger.observations ||= {};
      ledger.observations[scan.id] = { capturedAt: scan.capturedAt, clients: scan.clients, reason };
      const scope = ledger.scopes[scan.id];
      const healthyLegacyObservation = reason === 'unresolved-legacy-boundary' && !scan.reason && !unresolvedPeer
        && options.retainedBoundaryChecked === true;
      // Healthy legacy graphs can advance dated aggregates, but their event
      // identities still cannot migrate this unresolved accounting boundary.
      const observedBoundary = healthyLegacyObservation
        ? options.legacyBoundary?.(scan.clients, scan.graph, true) || boundary : boundary;
      if (scope) {
        scope.observationFrontier = scan.capturedAt; scope.reason = reason;
        scope.blockNativeWatch = true;
        if (healthyLegacyObservation && scope.mode === 'legacy' && scope.unresolvedBoundary
          && (scope.legacyPeriods || observedBoundary?.periods)) {
          advanceLegacyBoundary(scope, observedBoundary);
        }
      }
      else if (!overlaps.length && !unresolvedPeer && options.retainedBoundaryChecked === true && boundary?.hasRetainedUsage) ledger.scopes[scan.id] = {
        mode: 'legacy', clients: [...new Set([...scan.clients, ...(boundary.clients || [])])].sort(),
        sessions: observedBoundary.sessions || {}, events: {}, observationFrontier: scan.capturedAt, reason,
        legacyDays: observedBoundary.days || {}, ...(observedBoundary.periods ? { legacyPeriods: legacyPeriods(observedBoundary.periods) } : {}),
        unresolvedBoundary: true, blockNativeWatch: true };
      if (!scope && healthyLegacyObservation && ledger.scopes[scan.id]?.legacyPeriods) {
        ledger.scopes[scan.id].blockNativeWatch = false;
      }
      for (const [id] of overlaps) {
        ledger.scopes[id].observationFrontier = scan.capturedAt;
        ledger.scopes[id].reason = reason;
        ledger.scopes[id].blockNativeWatch = true;
      }
      // A rejected raw sibling cannot escape through the shared canonical
      // native watch partition. This does not merge its event claim domain.
      for (const scope of Object.values(ledger.scopes)) {
        if (scope.mode !== 'ledger' || !canonicalOverlap(scope.clients, scan.clients) || frontier(scope) > time) continue;
        scope.observationFrontier = scan.capturedAt;
        scope.reason = reason;
        scope.blockNativeWatch = true;
      }
      continue;
    }
    const scope = previous?.mode === 'ledger' ? ledger.scopes[scan.id] : { mode: 'ledger', clients: scan.clients, sessions: {}, events: {} };
    for (const [id, old] of legacy) {
      // Empty inventories still permanently belong to the migrated domain.
      for (const [key, row] of Object.entries(old.sessions)) scope.sessions[key] ||= { client: row.client, sessionId: row.sessionId,
        sourceState: 'unknown', ...(row.sourcePath ? { sourcePath: row.sourcePath } : {}) };
      delete ledger.scopes[id];
    }
    for (const [uid, event] of Object.entries(scope.events)) if (scan.sessions[event.ownerKey]) delete scope.events[uid];
    for (const [key, row] of Object.entries(scan.sessions)) {
      const sourcePath = ownedSessionSourcePath(options.sourcePaths?.[key]) || scope.sessions[key]?.sourcePath;
      scope.sessions[key] = { ...row, ...(sourcePath ? { sourcePath } : {}) };
    }
    // A claim is indexed by this opaque scope + event UID. Reassigning it
    // replaces both owner and priced contributions in the same document.
    Object.assign(scope.events, scan.events);
    for (const [key, row] of Object.entries(scope.sessions)) {
      if (scan.sessions[key]) continue;
      const sourcePath = ownedSessionSourcePath(options.sourcePaths?.[key]) || row.sourcePath;
      row.sourceState = classifySessionSourcePath(sourcePath, options.sourceStateDeps) === 'missing' ? 'missing' : 'unknown';
      row.sourceObservedAt = scan.capturedAt;
      if (sourcePath) row.sourcePath = sourcePath;
    }
    if (ledger.observations) delete ledger.observations[scan.id];
    scope.acceptedAt = scan.capturedAt;
    scope.observationFrontier = scan.capturedAt;
    scope.eventIdentityVersion = 2;
    scope.proof = { fullHistory: true, readStatus: 'complete', identityStatus: 'exact',
      ...(options.retainedBoundaryChecked === true || canonicalOwned || previous?.proof?.retainedBoundaryChecked === true || legacy.length
        ? { retainedBoundaryChecked: true } : {}) };
    delete scope.reason;
    delete scope.blockNativeWatch;
    delete scope.legacyDays;
    delete scope.legacyPeriods;
    delete scope.unresolvedBoundary;
    ledger.scopes[scan.id] = scope;
    accepted.set(scan.id, scan);
  }
  // Even unavailable exports advance the local observation frontier, without
  // changing mode/claims. An older scan finishing later must not restore them.
  for (const graph of (Array.isArray(graphs) ? graphs : [graphs]).filter(Boolean)) {
    if (scans.some(scan => scan.graph === graph)) continue;
    const capturedAt = graph.sourceUsage?.capturedAt || graph.meta?.generatedAt || graph.meta?.generated_at;
    if (!timestamp(capturedAt)) continue;
    for (const [id, scope] of Object.entries(ledger.scopes)) {
      if (Date.parse(capturedAt) < frontier(scope)) { rejectedGraphs.add(graph); continue; }
      if (Date.parse(capturedAt) === frontier(scope)) continue;
      edit();
      ledger.scopes[id].observationFrontier = capturedAt;
      ledger.scopes[id].reason = graph.sourceUsage ? 'unsupported-export' : 'aggregate-only';
      if (scope.mode === 'legacy') ledger.scopes[id].blockNativeWatch = true;
    }
  }
  return { ledger: copied ? markCanonical(ledger) : ledger, accepted, rejectedGraphs, rejectedClients };
}

function projectSourceLedger(value, options = {}) {
  const ledger = normalizeSourceLedger(value);
  const timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cached = projections.get(ledger);
  if (cached?.timeZone === timeZone) return cached.projection;
  const ownedClients = new Set();
  const managedKeys = new Set();
  const sessions = [];
  const aggregates = [];
  const retainedPeriods = [];
  const scopes = [];
  for (const [id, scope] of Object.entries(ledger.scopes)) {
    scope.clients.forEach(client => ownedClients.add(client));
    scopes.push({ id, mode: scope.mode, clients: scope.clients, acceptedAt: scope.acceptedAt,
      observationFrontier: scope.observationFrontier, ...(scope.blockNativeWatch ? { blockNativeWatch: true } : {}), ...(scope.proof ? { ...scope.proof } : {}), ...(scope.reason ? { reason: scope.reason } : {}) });
    const daysByOwner = scope.mode === 'ledger' ? scopeDays(scope, timeZone) : null;
    for (const [key, row] of Object.entries(scope.sessions)) {
      managedKeys.add(key);
      sessions.push({ client: row.client, sessionId: row.sessionId, scopeId: id, mode: scope.mode,
        sourceState: row.sourceState, days: daysByOwner ? [...(daysByOwner.get(key)?.values() || [])] : [] });
    }
    if (scope.legacyDays) aggregates.push(...Object.values(scope.legacyDays).map(day => ({ ...day, scopeId: id })));
    if (scope.legacyPeriods) retainedPeriods.push({ scopeId: id, clients: scope.clients, periods: scope.legacyPeriods });
  }
  const projection = { version: 2, accountingOwner: 'app', bucketTimezone: timeZone,
    ownedClients: [...ownedClients].sort(), managedKeys: [...managedKeys].sort(), scopes, sessions, aggregates, legacyPeriods: retainedPeriods };
  projections.set(ledger, { timeZone, projection });
  projectionLedgers.set(projection, ledger);
  return projection;
}

function rebucketSourceUsage(projection, timeZone) {
  const ledger = projectionLedgers.get(projection);
  return ledger ? projectSourceLedger(ledger, { timeZone }) : projection;
}

// Only an in-process projection can expose its accepted ledger. Deserializing
// an aggregate projection never reconstructs event identity or read authority.
function getSourceLedger(projection) {
  return projectionLedgers.get(projection) || null;
}

module.exports = { getSourceLedger, legacyCostsEqual, legacyDaysMatch, legacyAllocationMatches, legacySessionAccounting, selectLegacyDay, largerLegacyPeriod, rebucketSourceUsage, captureSourceLedger, normalizeSourceLedger, projectSourceLedger, sourceSnapshotsFromGraphs };
