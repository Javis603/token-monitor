'use strict';

// Account-scoped accounting for the automatic cloud observer. Pure state logic:
// no filesystem, no timers, no IPC. The observer reports per-thread *cumulative*
// engine counters; this module converts that cumulative stream into
//   - a one-time lifetime baseline (TOTAL only), and
//   - observed monotonic increments dated by the observation that saw them
//     (today / month / allTime).
// Repeated cumulative snapshots are never summed, a decreasing counter never
// produces a negative contribution, and missing counters stay unknown. The
// resulting numbers are still engine-reported counts, not a billing claim, and
// carry no cost.
const { localDayKey } = require('../../history');
const { normalizeUsage } = require('./taskUsage');

const LEDGER_KIND = 'codex-cloud-usage-ledger';
const REPORT_KIND = 'codex-cloud-auto-watch';
const LEDGER_VERSION = 1;
const MAX_SCOPES = 4;
const MAX_THREADS = 5000;
const MAX_DAY_ENTRIES = 20000;
const DAY_WINDOW = 62;
const MAX_UI_THREADS = 1200;
const GAP_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^[a-f0-9]{64}$/;
const FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const CATEGORICAL = ['inputTokens', 'outputTokens', 'totalTokens'];
const OPTIONAL_FIELDS = ['cachedInputTokens', 'reasoningOutputTokens'];

function validThreadId(value) {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}
function validTimestamp(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : null;
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function safeAdd(left, right) {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : null;
}

// A stored counter set: mandatory input/output/total, optional cache/reasoning
// that may be null (unknown). totalTokens always equals inputTokens + outputTokens.
function countersFromUsage(usage) {
  if (!usage) return null;
  const inputTokens = safeCount(usage.inputTokens);
  const outputTokens = safeCount(usage.outputTokens);
  if (inputTokens === null || outputTokens === null) return null;
  const totalTokens = safeAdd(inputTokens, outputTokens);
  if (totalTokens === null) return null;
  if (usage.totalTokens != null && usage.totalTokens !== totalTokens) return null;
  const cachedInputTokens = usage.cachedInputTokens == null ? null : safeCount(usage.cachedInputTokens);
  const reasoningOutputTokens = usage.reasoningOutputTokens == null ? null : safeCount(usage.reasoningOutputTokens);
  if (usage.cachedInputTokens != null && cachedInputTokens === null) return null;
  if (usage.reasoningOutputTokens != null && reasoningOutputTokens === null) return null;
  if (cachedInputTokens !== null && cachedInputTokens > inputTokens) return null;
  if (reasoningOutputTokens !== null && reasoningOutputTokens > outputTokens) return null;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

function sanitizeCounters(value, { requireBaseline = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const counters = countersFromUsage(value);
  if (!counters) return null;
  if (requireBaseline && counters.inputTokens + counters.outputTokens <= 0) return null;
  return counters;
}

function countersEqual(left, right) {
  return Boolean(left && right) && FIELDS.every((field) => left[field] === right[field]);
}

function countersZero(counters) {
  return !counters || FIELDS.every((field) => (counters[field] || 0) === 0);
}

function emptyCounters() {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

function addCountersInto(target, source) {
  if (!source) return true;
  const result = {};
  for (const field of FIELDS) {
    if (OPTIONAL_FIELDS.includes(field) && (target[field] === null || source[field] === null)) {
      result[field] = null;
      continue;
    }
    const next = safeAdd(target[field] || 0, source[field] || 0);
    if (next === null) return false;
    result[field] = next;
  }
  Object.assign(target, result);
  return true;
}

function addCounters(left, right) {
  if (!left) return right ? { ...right } : null;
  if (!right) return { ...left };
  const sum = emptyCounters();
  return addCountersInto(sum, left) && addCountersInto(sum, right) ? sum : null;
}

// Delta between two cumulative snapshots. `reset` means at least one mandatory
// counter fell: the transition is ambiguous and contributes nothing. Null
// optional fields mean "not both known"; the increment stays partial.
function deltaCounters(next, previous) {
  if (!next || !previous) return { reset: true, partial: true, delta: null };
  for (const field of CATEGORICAL) {
    if (next[field] < previous[field]) return { reset: true, partial: false, delta: null };
  }
  const delta = emptyCounters();
  for (const field of CATEGORICAL) delta[field] = next[field] - previous[field];
  let partial = false;
  for (const field of OPTIONAL_FIELDS) {
    if (next[field] === null || previous[field] === null) { delta[field] = null; partial = true; continue; }
    if (next[field] < previous[field]) return { reset: true, partial: false, delta: null };
    delta[field] = next[field] - previous[field];
  }
  if (delta.cachedInputTokens !== null && delta.cachedInputTokens > delta.inputTokens) { delta.cachedInputTokens = null; partial = true; }
  if (delta.reasoningOutputTokens !== null && delta.reasoningOutputTokens > delta.outputTokens) { delta.reasoningOutputTokens = null; partial = true; }
  return { reset: false, partial, delta };
}

function sanitizeDelta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return countersFromUsage(value);
}

function normalizeThread(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (validThreadId(value.threadId || id) !== id) return null;
  const baseline = value.baseline == null ? null : sanitizeCounters(value.baseline);
  if (value.baseline != null && !baseline) return null;
  const observed = value.observed == null ? null : sanitizeCounters(value.observed);
  if (value.observed != null && !observed) return null;
  const increments = value.increments == null ? emptyCounters() : sanitizeDelta(value.increments);
  if (!increments) return null;
  const lifetime = addCounters(baseline, increments);
  if (!lifetime || (baseline || observed) && (!baseline || !observed || !CATEGORICAL.every((f) => lifetime[f] === observed[f]))) return null;
  const days = {};
  const dailySum = emptyCounters();
  if (value.days && typeof value.days === 'object' && !Array.isArray(value.days)) {
    for (const [key, raw] of Object.entries(value.days)) {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(key) ? new Date(`${key}T00:00:00Z`) : null;
      if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== key) return null;
      const day = sanitizeDelta(raw);
      if (!day || !addCountersInto(dailySum, day)) return null;
      days[key] = day;
    }
  }
  if (CATEGORICAL.some((f) => dailySum[f] > increments[f])) return null;
  const parents = Array.isArray(value.parentIds)
    ? [...new Set(value.parentIds.map(validThreadId).filter((p) => p && p !== id))].slice(0, 16) : [];
  return {
    threadId: id,
    firstObservedAt: isoOrNull(validTimestamp(value.firstObservedAt)),
    baseline,
    baselineAt: isoOrNull(validTimestamp(value.baselineAt)),
    baselineSource: value.baselineSource === 'previous-report' ? 'previous-report' : value.baseline ? 'report' : null,
    observed,
    observedAt: isoOrNull(validTimestamp(value.observedAt)),
    increments,
    days,
    parentUnknown: value.parentUnknown === true || (value.kind === 'aeon' && !Array.isArray(value.parentIds))
      || Array.isArray(value.parentIds) && (value.parentIds.length > 16 || value.parentIds.some((p) => p != null && p !== '' && !validThreadId(p))),
    kind: typeof value.kind === 'string' && ['aeon', 'aeon_child', 'subagent', 'user', 'dreaming', 'unknown'].includes(value.kind) ? value.kind : 'unknown',
    parentIds: parents,
    resetCount: safeCount(value.resetCount) || 0,
    overflowCount: safeCount(value.overflowCount) || 0,
    invalidObservations: safeCount(value.invalidObservations) || 0,
    partial: value.partial === true,
    bridged: value.bridged === true,
    lastIngestAt: isoOrNull(validTimestamp(value.lastIngestAt))
  };
}

// Accepts any persisted value (including a corrupt or foreign document) and
// returns a structurally valid ledger. Invalid entries are dropped, never
// merged: a dropped thread can be re-observed, but a malformed counter can
// never silently inflate a total.
function normalizeLedger(value) {
  const ledger = { version: LEDGER_VERSION, kind: LEDGER_KIND, updatedAt: null, scopes: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== LEDGER_VERSION || value.kind !== LEDGER_KIND
    || !value.scopes || typeof value.scopes !== 'object' || Array.isArray(value.scopes)) {
    return { ledger, valid: false };
  }
  ledger.updatedAt = isoOrNull(validTimestamp(value.updatedAt));
  let valid = true;
  for (const [fingerprint, raw] of Object.entries(value.scopes)) {
    if (!SCOPE.test(fingerprint) || !raw || typeof raw !== 'object' || Array.isArray(raw)
      || !raw.threads || typeof raw.threads !== 'object' || Array.isArray(raw.threads)) { valid = false; continue; }
    const threads = {};
    for (const [id, rawThread] of Object.entries(raw.threads)) {
      const threadId = validThreadId(id);
      const thread = threadId && Object.keys(threads).length < MAX_THREADS ? normalizeThread(rawThread, threadId) : null;
      if (thread) threads[threadId] = thread;
      else valid = false;
    }
    ledger.scopes[fingerprint] = { updatedAt: isoOrNull(validTimestamp(raw.updatedAt)), threads };
  }
  return { ledger, valid };
}

function parseReport(raw, scopeFingerprint) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'INVALID_REPORT' };
  if (raw.version !== LEDGER_VERSION || raw.kind !== REPORT_KIND) return { error: 'INVALID_REPORT' };
  if (!SCOPE.test(raw.scopeFingerprint || '') || raw.scopeFingerprint !== scopeFingerprint) return { error: 'ACCOUNT_MISMATCH' };
  const observedAt = validTimestamp(raw.observedAt);
  if (observedAt === null) return { error: 'INVALID_REPORT_TIME' };
  if (!Array.isArray(raw.threads) || raw.threads.length > MAX_THREADS) return { error: 'INVALID_REPORT' };
  const threads = new Map();
  for (const row of raw.threads) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { error: 'INVALID_THREAD_ROW' };
    const threadId = validThreadId(row.threadId);
    if (!threadId || threads.has(threadId)) return { error: 'DUPLICATE_OR_INVALID_THREAD' };
    const total = row.total == null ? null : normalizeUsage(row.total);
    const usable = total && row.status === 'observed' && !row.problem;
    threads.set(threadId, {
      threadId,
      observedAt: validTimestamp(row.observedAt),
      status: usable ? 'observed' : row.status === 'observed' && row.problem ? 'ambiguous' : typeof row.status === 'string' ? row.status : 'unknown',
      counters: usable ? countersFromUsage(total) : null,
      parentUnknown: row.parentConflict === true || [row.engineParentId, row.delegationParentId].some((v) => v != null && v !== '' && !validThreadId(v)),
      kind: ['aeon', 'aeon_child', 'subagent', 'user', 'dreaming'].includes(row.kind) ? row.kind : 'unknown',
      invalid: row.total != null && !total,
      parentIds: [validThreadId(row.engineParentId), validThreadId(row.delegationParentId)].filter(Boolean)
    });
  }
  return { observedAt, threads };
}

function pruneLedger(ledger, now) {
  const cutoffKey = localDayKey(new Date(now - DAY_WINDOW * 86400000));
  let changed = false;
  for (const scope of Object.values(ledger.scopes)) {
    let entries = 0;
    for (const thread of Object.values(scope.threads)) {
      const keys = Object.keys(thread.days);
      for (const key of keys) {
        if (key < cutoffKey) { delete thread.days[key]; changed = true; }
      }
      entries += Object.keys(thread.days).length;
    }
    if (entries > MAX_DAY_ENTRIES) return null;
  }
  return changed;
}

function createScopeEntry(now) {
  return { updatedAt: isoOrNull(now), threads: {} };
}

function applyObservation(scope, row, { now, nowIso }) {
  const existing = scope.threads[row.threadId];
  if (!existing && !row.counters && (row.invalid || row.kind === 'unknown' && !row.parentIds.length)) return { changed: false };
  if (!existing) {
    if (Object.keys(scope.threads).length >= MAX_THREADS) return { changed: false, overflow: true };
    scope.threads[row.threadId] = {
      threadId: row.threadId,
      firstObservedAt: nowIso,
      baseline: row.counters ? { ...row.counters } : null,
      baselineAt: row.counters ? nowIso : null,
      baselineSource: row.counters ? 'report' : null,
      observed: row.counters ? { ...row.counters } : null,
      observedAt: row.counters ? nowIso : null,
      increments: emptyCounters(),
      days: {},
      kind: row.kind,
      parentUnknown: row.parentUnknown,
      parentIds: row.parentIds,
      resetCount: 0,
      overflowCount: 0,
      invalidObservations: 0,
      partial: false,
      bridged: false,
      lastIngestAt: nowIso
    };
    return { changed: true };
  }
  const parents = [...new Set([...existing.parentIds, ...row.parentIds])].sort();
  const metadataChanged = JSON.stringify(parents) !== JSON.stringify([...existing.parentIds].sort())
    || (row.parentUnknown && !existing.parentUnknown)
    || (row.kind !== 'unknown' && row.kind !== existing.kind);
  existing.parentIds = parents.slice(0, 16);
  existing.parentUnknown = existing.parentUnknown || row.parentUnknown || parents.length > 16;
  if (row.kind !== 'unknown') existing.kind = row.kind;
  if (!row.counters) {
    const ambiguous = row.invalid || row.status === 'ambiguous';
    const changed = metadataChanged || (ambiguous && !existing.partial);
    if (ambiguous) existing.partial = true;
    return { changed };
  }
  if (!existing.observed) {
    existing.baseline = { ...row.counters };
    existing.baselineAt = nowIso;
    existing.baselineSource = 'report';
    existing.observed = { ...row.counters };
    existing.observedAt = nowIso;
    existing.lastIngestAt = nowIso;
    return { changed: true };
  }
  // A repeated cumulative notice is not consumption: it never changes a total,
  // so it must not bump the revision (and therefore must not rewrite the file
  // or wake the UI). The per-thread "last observed" label comes from the live
  // observer report, not from this ledger.
  if (countersEqual(existing.observed, row.counters)) return { changed: metadataChanged };
  const eventMs = row.observedAt !== null && row.observedAt >= (validTimestamp(existing.observedAt) ?? 0) && row.observedAt <= now + 300000
    ? row.observedAt : now;
  const gap = existing.lastIngestAt ? now - (validTimestamp(existing.lastIngestAt) ?? now) : 0;
  const result = deltaCounters(row.counters, existing.observed);
  let changed = true;
  if (result.reset) {
    existing.resetCount += 1;
    existing.partial = true;
    // Keep the saved high-water anchor. A late/lower snapshot does not prove
    // a new generation, and returning to an old value is never new usage.
  } else {
    const nextIncrements = addCounters(existing.increments, sanitizeDelta(result.delta));
    if (!nextIncrements) {
      // An unsafe sum must never be stored partially: keep the previous
      // observation so the same delta cannot be re-added later either.
      existing.overflowCount += 1;
      existing.partial = true;
      changed = true;
    } else {
      existing.increments = nextIncrements;
      const dayKey = localDayKey(new Date(eventMs));
      const day = existing.days[dayKey] || (existing.days[dayKey] = emptyCounters());
      addCountersInto(day, result.delta);
      if (result.partial) existing.partial = true;
      if (gap > GAP_MS) existing.bridged = true;
      existing.observed = { ...row.counters };
      existing.observedAt = isoOrNull(eventMs);
    }
  }
  existing.lastIngestAt = nowIso;
  return { changed };
}

function seedFromPrevious(ledger, scopeFingerprint, previousRows, now, nowIso) {
  const scope = ledger.scopes[scopeFingerprint];
  let changed = false;
  for (const [threadId, row] of previousRows) {
    const priorMetadata = scope.threads[threadId];
    if (priorMetadata?.observed || !row.counters) continue;
    if (Object.keys(scope.threads).length >= MAX_THREADS) break;
    scope.threads[threadId] = {
      threadId,
      firstObservedAt: nowIso,
      baseline: { ...row.counters },
      baselineAt: isoOrNull(row.observedAt) || nowIso,
      baselineSource: 'previous-report',
      observed: { ...row.counters },
      observedAt: isoOrNull(row.observedAt) || nowIso,
      increments: emptyCounters(),
      days: {},
      parentIds: [...new Set([...(priorMetadata?.parentIds || []), ...row.parentIds])],
      kind: priorMetadata?.kind && priorMetadata.kind !== 'unknown' ? priorMetadata.kind : row.kind,
      parentUnknown: priorMetadata?.parentUnknown || row.parentUnknown,
      resetCount: 0,
      overflowCount: 0,
      invalidObservations: 0,
      partial: false,
      bridged: false,
      lastIngestAt: null
    };
    changed = true;
  }
  return changed;
}

/**
 * Fold one observer report (plus an optional validated prior-run report used
 * only as a baseline seed for threads the current report no longer lists) into
 * the persisted ledger. Returns a new ledger object; the input is not mutated.
 */
function ingestObservation(ledger, { scopeFingerprint, report, previousReport = null, now = Date.now() } = {}) {
  if (!SCOPE.test(scopeFingerprint || '')) return { ledger, changed: false, status: 'NO_ACCOUNT' };
  const parsed = parseReport(report, scopeFingerprint);
  if (parsed.error) return { ledger, changed: false, status: parsed.error };
  if (parsed.observedAt > now + 300000) return { ledger, changed: false, status: 'INVALID_REPORT_TIME' };
  const nowIso = new Date(now).toISOString();
  const state = JSON.parse(JSON.stringify(ledger));
  const fresh = !state.scopes[scopeFingerprint];
  if (fresh && Object.keys(state.scopes).length >= MAX_SCOPES) return { ledger, changed: false, status: 'SCOPE_CAPACITY' };
  const scope = state.scopes[scopeFingerprint] || (state.scopes[scopeFingerprint] = createScopeEntry(now));
  let changed = false;
  let observedThreads = 0;
  let invalidThreads = 0;
  for (const row of parsed.threads.values()) {
    const result = applyObservation(scope, row, { now, nowIso });
    if (result.changed) changed = true;
    if (result.overflow) return { ledger, changed: false, status: 'STORAGE_LIMIT' };
    if (row.counters) observedThreads += 1;
    else invalidThreads += row.invalid ? 1 : 0;
  }
  if (fresh && previousReport) {
    const previous = parseReport(previousReport, scopeFingerprint);
    if (!previous.error && previous.observedAt <= parsed.observedAt) {
      const seedRows = new Map();
      for (const [id, row] of previous.threads) if (row.counters) seedRows.set(id, row);
      if (seedFromPrevious(state, scopeFingerprint, seedRows, now, nowIso)) changed = true;
    }
  }
  if (changed) {
    if (pruneLedger(state, now) === null) return { ledger, changed: false, status: 'STORAGE_LIMIT' };
    scope.updatedAt = nowIso;
    state.updatedAt = nowIso;
  }
  return { ledger: state, changed, status: 'OK', observedThreads, invalidThreads };
}

/**
 * Presentation-safe account summary. Contains no scope fingerprint, no paths
 * and no credentials. `localThreadIds` are canonical Codex thread UUIDs
 * already counted from local sessions: those cloud threads are excluded from
 * every contribution so local requests, cost and period values stay the single
 * source for that thread.
 */
function summarize(ledger, { scopeFingerprint, localThreadIds = [], localThreadUsage = {}, now = Date.now(), status = { state: 'active', reason: null } } = {}) {
  const todayKey = localDayKey(new Date(now)), monthPrefix = todayKey.slice(0, 7);
  const localIds = new Set([...localThreadIds, ...Object.keys(localThreadUsage)].map(validThreadId).filter(Boolean));
  const base = {
    version: 1, state: status.state === 'active' ? 'active' : 'inactive', reason: status.reason || null,
    updatedAt: ledger.updatedAt, observedAt: null,
    periods: { today: periodSummary(), month: periodSummary(), allTime: periodSummary() },
    baselineTokens: 0, observedTokens: 0, excludedThreads: 0,
    excludedReasons: { matchedLocal: 0, parentOverlap: 0, unsafeCounter: 0 },
    partialThreads: 0, bridgedThreads: 0, unknownCost: false, threads: {}, billingRows: []
  };
  const scope = SCOPE.test(scopeFingerprint || '') ? ledger.scopes[scopeFingerprint] : null;
  if (!scope) return base;
  const rows = Object.values(scope.threads);
  const hasCounters = (t) => !countersZero(t.baseline) || !countersZero(t.increments);
  const candidates = new Set(rows.filter(hasCounters).map((t) => t.threadId));
  const uiRows = [];
  for (const thread of rows) {
    if (hasCounters(thread)) base.unknownCost = true;
    const parentRisk = thread.parentUnknown || thread.parentIds.some((p) => localIds.has(p) || candidates.has(p));
    let reason = parentRisk ? 'parentOverlap' : null;
    const lifetime = addCounters(thread.baseline, thread.increments);
    const month = emptyCounters();
    for (const [key, day] of Object.entries(thread.days)) if (key.startsWith(monthPrefix)) addCountersInto(month, day);
    const counts = { allTime: lifetime || emptyCounters(), today: thread.days[todayKey] || emptyCounters(), month };
    let partial = thread.partial || thread.parentUnknown || !lifetime;
    const matched = localIds.has(thread.threadId);
    const contributed = {};
    for (const [period, counters] of Object.entries(counts)) {
      let value = reason ? emptyCounters() : counters;
      if (matched && !reason) {
        const local = safeCount(localThreadUsage[thread.threadId]?.[period]);
        if (local === null) { value = emptyCounters(); partial = partial || counters.totalTokens > 0; }
        else if (local > 0) {
          // Only the comparable total is known. Do not prorate or invent the
          // input/cache/output split of the cloud remainder.
          value = { inputTokens: 0, outputTokens: 0, cachedInputTokens: null, reasoningOutputTokens: null,
            totalTokens: Math.max(0, counters.totalTokens - local) };
          if (value.totalTokens > 0) partial = true;
        }
      }
      contributed[period] = value;
    }
    if (!reason && Object.values(contributed).some((v) => v.totalTokens > 0)
      && Object.entries(contributed).some(([period, value]) => FIELDS.some((field) => safeAdd(base.periods[period][field] || 0, value[field] || 0) === null))) {
      reason = 'unsafeCounter'; partial = true;
      for (const period of Object.keys(contributed)) contributed[period] = emptyCounters();
    }
    const anyIncluded = Object.values(contributed).some((v) => v.totalTokens > 0);
    if (matched && !reason && !anyIncluded) reason = 'matchedLocal';
    const credited = contributed.allTime.totalTokens || 0;
    for (const [period, value] of Object.entries(contributed)) {
      addPeriod(base.periods[period], value);
      if (value.totalTokens > 0) base.periods[period].threadCount += 1;
      if (value.cachedInputTokens === null || value.reasoningOutputTokens === null || (value.totalTokens > 0 && value.inputTokens + value.outputTokens !== value.totalTokens)) base.periods[period].partialComponents = true;
    }
    const localLifetime = matched ? safeCount(localThreadUsage[thread.threadId]?.allTime) : 0;
    const baseline = Math.min(credited, Math.max(0, (thread.baseline?.totalTokens || 0) - (localLifetime || 0)));
    base.baselineTokens += baseline;
    base.observedTokens += credited - baseline;
    if (thread.observedAt && (!base.observedAt || thread.observedAt > base.observedAt)) base.observedAt = thread.observedAt;
    if (reason) { base.excludedThreads += 1; base.excludedReasons[reason] += 1; }
    if (partial) base.partialThreads += 1;
    if (thread.bridged) base.bridgedThreads += 1;
    const billingParents = thread.parentUnknown ? [...thread.parentIds, 'unknown'] : thread.parentIds;
    base.billingRows.push({ threadId: thread.threadId, kind: thread.kind, parentIds: billingParents });
    uiRows.push({ threadId: thread.threadId, kind: thread.kind, parentIds: thread.parentIds, parentUnknown: thread.parentUnknown === true,
      status: reason === 'matchedLocal' ? 'matched-local' : reason === 'parentOverlap' ? 'parent-overlap' : reason === 'unsafeCounter' ? 'unknown' : 'included',
      partial, bridged: thread.bridged, includedTokens: credited, baselineTokens: baseline, observedTokens: credited - baseline,
      resetCount: thread.resetCount, overflowCount: thread.overflowCount, lastObservedAt: thread.observedAt });
  }
  uiRows.sort((a, b) => b.includedTokens - a.includedTokens || a.threadId.localeCompare(b.threadId));
  for (const row of uiRows.slice(0, MAX_UI_THREADS)) base.threads[row.threadId] = row;
  return base;
}

function periodSummary() {
  return { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, threadCount: 0 };
}

function addPeriod(target, counters) {
  if (!counters) return;
  for (const field of FIELDS) target[field] = safeAdd(target[field] || 0, counters[field] || 0) ?? target[field];
}

module.exports = {
  LEDGER_KIND,
  LEDGER_VERSION,
  MAX_SCOPES,
  MAX_THREADS,
  GAP_MS,
  countersFromUsage,
  countersEqual,
  deltaCounters,
  normalizeLedger,
  parseReport,
  ingestObservation,
  summarize,
  validThreadId,
  addCounters,
  emptyCounters
};
