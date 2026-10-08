'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ingestObservation,
  normalizeLedger,
  parseReport,
  summarize,
  validThreadId,
  LEDGER_KIND,
  LEDGER_VERSION
} = require('../../src/shared/providers/codex/cloudAccounting');

const SCOPE = 'a'.repeat(64);
const SCOPE_B = 'b'.repeat(64);
const TID = '01900000-0000-7000-8000-000000000001';
const CHILD = '01900000-0000-7000-8000-000000000002';
const OTHER = '01900000-0000-7000-8000-000000000003';
const LEDGER = () => ({ version: LEDGER_VERSION, kind: LEDGER_KIND, updatedAt: null, scopes: {} });
const usage = (input, output, { cached = 0, reasoning = 0 } = {}) => ({
  inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: input + output
});
function report(threads, at, extra = {}) {
  const observedAt = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  return {
    version: 1, kind: 'codex-cloud-auto-watch', scopeFingerprint: SCOPE, observedAt,
    threads: threads.map((t) => ({
      threadId: t.threadId || TID,
      status: t.status || 'observed',
      total: t.total === undefined ? usage(100, 10) : t.total,
      observedAt: t.observedAt === undefined ? observedAt : t.observedAt,
      ...(t.extra || {})
    })),
    ...extra
  };
}
function ingest(ledger, rows, at, options = {}) {
  return ingestObservation(ledger, {
    scopeFingerprint: options.scope || SCOPE,
    report: options.raw || report(rows, at),
    previousReport: options.previous || null,
    now: at instanceof Date ? at.getTime() : at
  });
}
function sum(ledger, options = {}) {
  return summarize(ledger, {
    scopeFingerprint: options.scope || SCOPE,
    localThreadIds: options.local || [],
    now: options.now instanceof Date ? options.now.getTime() : options.now,
    status: options.status
  });
}
// Local wall-clock dates so the tests are timezone-independent.
const day = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0, 0);

test('a first cumulative snapshot is a lifetime baseline: TOTAL only, never today', () => {
  const at = day(2026, 10, 6);
  const { ledger, status } = ingest(LEDGER(), [{ total: usage(1000, 100, { cached: 400, reasoning: 10 }) }], at);
  assert.equal(status, 'OK');
  const s = sum(ledger, { now: at });
  assert.equal(s.state, 'active');
  assert.equal(s.periods.today.totalTokens, 0);
  assert.equal(s.periods.month.totalTokens, 0);
  assert.equal(s.periods.allTime.totalTokens, 1100);
  assert.equal(s.baselineTokens, 1100);
  assert.equal(s.observedTokens, 0);
  assert.equal(s.unknownCost, true);
  assert.equal(s.threads[TID].status, 'included');
  assert.equal(s.threads[TID].baselineTokens, 1100);
});

test('repeated cumulative snapshots are never summed and never bump the ledger', () => {
  const at = day(2026, 10, 6);
  const first = ingest(LEDGER(), [{ total: usage(1000, 100) }], at);
  const again = ingest(first.ledger, [{ total: usage(1000, 100) }], day(2026, 10, 7));
  assert.equal(again.changed, false);
  assert.deepEqual(again.ledger, first.ledger);
  const s = sum(again.ledger, { now: day(2026, 10, 7) });
  assert.equal(s.periods.allTime.totalTokens, 1100);
  assert.equal(s.periods.today.totalTokens, 0);
});

test('monotonic increments are dated by the observation that saw them', () => {
  const t1 = day(2026, 10, 6, 10);
  const t2 = day(2026, 10, 7, 9);
  const a = ingest(LEDGER(), [{ total: usage(1000, 100, { cached: 400, reasoning: 10 }) }], t1);
  const b = ingest(a.ledger, [{ total: usage(1150, 150, { cached: 450, reasoning: 20 }) }], t2);
  assert.equal(b.changed, true);
  const s = sum(b.ledger, { now: t2 });
  assert.equal(s.periods.today.totalTokens, 200);
  assert.equal(s.periods.month.totalTokens, 200);
  assert.equal(s.periods.allTime.totalTokens, 1300);
  assert.equal(s.periods.today.cachedInputTokens, 50);
  assert.equal(s.periods.today.outputTokens, 50);
  assert.equal(s.baselineTokens, 1100);
  assert.equal(s.observedTokens, 200);
  // The same day, later: today keeps the increment; another day's view drops it.
  assert.equal(sum(b.ledger, { now: day(2026, 10, 7, 20) }).periods.today.totalTokens, 200);
  const later = sum(b.ledger, { now: day(2026, 10, 8) });
  assert.equal(later.periods.today.totalTokens, 0);
  assert.equal(later.periods.allTime.totalTokens, 1300);
});

test('an increment observed just after local midnight belongs to the new day', () => {
  const before = new Date(2026, 9, 6, 23, 59, 0);
  const after = new Date(2026, 9, 7, 0, 1, 0);
  const a = ingest(LEDGER(), [{ total: usage(100, 0) }], before);
  const b = ingest(a.ledger, [{ total: usage(160, 0) }], after);
  const early = sum(b.ledger, { now: after });
  assert.equal(early.periods.today.totalTokens, 60);
  // Move the observation into the previous month: month/today no longer carry it,
  // allTime still does.
  const nextMonth = day(2026, 11, 1, 8);
  const c = ingest(b.ledger, [{ total: usage(200, 0) }], nextMonth);
  const s = sum(c.ledger, { now: nextMonth });
  assert.equal(s.periods.today.totalTokens, 40);
  assert.equal(s.periods.month.totalTokens, 40);
  assert.equal(s.periods.allTime.totalTokens, 200);
});

test('an event timestamp, when valid, dates the increment instead of the ingest time', () => {
  const observed = day(2026, 10, 7, 15);
  const ingestAt = day(2026, 10, 9, 9);
  const a = ingest(LEDGER(), [{ total: usage(100, 0) }], day(2026, 10, 7, 10));
  const b = ingest(a.ledger, [{ total: usage(150, 0), observedAt: observed.toISOString() }], ingestAt);
  const onEventDay = sum(b.ledger, { now: day(2026, 10, 7, 20) });
  assert.equal(onEventDay.periods.today.totalTokens, 50);
});

test('a decreasing counter preserves the high-water anchor and never recounts old usage', () => {
  const t1 = day(2026, 10, 6, 10);
  const t2 = day(2026, 10, 6, 11);
  const t3 = day(2026, 10, 6, 12);
  const a = ingest(LEDGER(), [{ total: usage(1000, 100) }], t1);
  const reset = ingest(a.ledger, [{ total: usage(10, 5) }], t2);
  assert.equal(reset.status, 'OK');
  const afterReset = sum(reset.ledger, { now: t2 });
  assert.equal(afterReset.periods.allTime.totalTokens, 1100);
  assert.equal(afterReset.periods.today.totalTokens, 0);
  assert.equal(afterReset.partialThreads, 1);
  assert.equal(afterReset.threads[TID].resetCount, 1);
  const grown = ingest(reset.ledger, [{ total: usage(30, 10) }], t3);
  const s = sum(grown.ledger, { now: t3 });
  assert.equal(s.periods.today.totalTokens, 0);
  assert.equal(s.periods.allTime.totalTokens, 1100);
});

test('missing optional counters stay unknown while the totals still count', () => {
  const t1 = day(2026, 10, 6, 10);
  const t2 = day(2026, 10, 6, 11);
  const a = ingest(LEDGER(), [{ total: usage(100, 10, { cached: 20, reasoning: 2 }) }], t1);
  const b = ingest(a.ledger, [{ total: usage(160, 30, { cached: null, reasoning: null }) }], t2);
  const s = sum(b.ledger, { now: t2 });
  assert.equal(s.periods.today.totalTokens, 80);
  assert.equal(s.periods.allTime.partialComponents, true);
  assert.equal(s.threads[TID].partial, true);
});

test('an invalid or ambiguous observation freezes counts and records the incomplete state', () => {
  const at = day(2026, 10, 6);
  const base = ingest(LEDGER(), [{ total: usage(100, 10) }], at);
  // subset violation -> normalizeUsage rejects the row
  const bad = ingest(base.ledger, [{ total: { ...usage(100, 10), cachedInputTokens: 999 } }], day(2026, 10, 7));
  assert.equal(bad.invalidThreads, 1);
  assert.equal(sum(bad.ledger, { now: at }).periods.allTime.totalTokens, 110);
  assert.equal(sum(bad.ledger, { now: at }).partialThreads, 1);
  // missing total entirely -> no baseline, no counters, no error
  const missing = ingest(LEDGER(), [{ total: null, threadId: OTHER }], at);
  assert.equal(missing.status, 'OK');
  assert.equal(Object.keys(missing.ledger.scopes[SCOPE].threads).length, 0);
  // report-level problems
  for (const raw of [null, { version: 2, kind: 'x' }, { ...report([{}], at), scopeFingerprint: SCOPE_B }, { ...report([{}], at), threads: 'x' }]) {
    const result = ingestObservation({ version: 1, kind: LEDGER_KIND, updatedAt: null, scopes: {} }, { scopeFingerprint: SCOPE, report: raw, now: at.getTime() });
    assert.notEqual(result.status, 'OK');
    assert.equal(result.changed, false);
  }
});

test('duplicate thread identities fail the whole report closed', () => {
  const at = day(2026, 10, 6);
  const raw = report([{ total: usage(10, 1) }, { total: usage(10, 1) }], at);
  const parsed = parseReport(raw, SCOPE);
  assert.equal(parsed.error, 'DUPLICATE_OR_INVALID_THREAD');
  const base = ingest(LEDGER(), [{ total: usage(100, 10) }], at);
  const result = ingest(base.ledger, [{}, {}], at, { raw });
  assert.equal(result.changed, false);
  assert.equal(result.status, 'DUPLICATE_OR_INVALID_THREAD');
  assert.deepEqual(result.ledger, base.ledger);
});

test('unsafe integers are rejected or frozen, never wrapped or re-added', () => {
  const at = day(2026, 10, 6);
  const huge = Number.MAX_SAFE_INTEGER;
  const overflow = ingest(LEDGER(), [{ total: { inputTokens: huge, outputTokens: huge, totalTokens: huge * 2 } }], at);
  assert.equal(overflow.invalidThreads, 1);
  assert.equal(Object.keys(overflow.ledger.scopes[SCOPE]?.threads || {}).length, 0);
  // A huge baseline plus a later reset and regrowth cannot be represented as a
  // single safe total; the observed increments survive and the row is partial.
  const base = ingest(LEDGER(), [{ total: { inputTokens: huge - 500, outputTokens: 0, totalTokens: huge - 500 } }], at);
  const reset = ingest(base.ledger, [{ total: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }], day(2026, 10, 7, 8));
  const grown = ingest(reset.ledger, [{ total: { inputTokens: 600, outputTokens: 0, totalTokens: 600 } }], day(2026, 10, 7, 9));
  const s = sum(grown.ledger, { now: day(2026, 10, 7, 12) });
  assert.equal(s.threads[TID].partial, true);
  assert.equal(s.partialThreads, 1);
  assert.equal(s.periods.allTime.totalTokens, huge - 500);
  assert.equal(s.periods.today.totalTokens, 0);
});

test('accounts stay isolated and the summary never leaks a scope fingerprint', () => {
  const at = day(2026, 10, 6);
  const a = ingest(LEDGER(), [{ total: usage(100, 10) }], at);
  const b = ingest(a.ledger, [{ total: usage(5000, 500) }], at, { scope: SCOPE_B, raw: { ...report([{ total: usage(5000, 500) }], at), scopeFingerprint: SCOPE_B } });
  const viewA = sum(b.ledger, { now: at, scope: SCOPE });
  const viewB = sum(b.ledger, { now: at, scope: SCOPE_B });
  assert.equal(viewA.periods.allTime.totalTokens, 110);
  assert.equal(viewB.periods.allTime.totalTokens, 5500);
  const serialized = JSON.stringify(viewA);
  assert.ok(!serialized.includes(SCOPE));
  assert.ok(!serialized.includes(SCOPE_B));
  assert.equal(sum(b.ledger, { now: at, scope: 'c'.repeat(64) }).periods.allTime.totalTokens, 0);
});

test('a fresh ledger seeds baselines from a validated same-account prior report only for missing threads', () => {
  const currentAt = day(2026, 10, 8, 12);
  const previousAt = day(2026, 10, 7, 12);
  const previous = { ...report([{ threadId: TID, total: usage(900, 90) }, { threadId: OTHER, total: usage(50, 5) }], previousAt), runId: 'old' };
  const current = { ...report([{ threadId: TID, total: usage(1000, 100) }], currentAt), runId: 'new' };
  const result = ingestObservation(LEDGER(), { scopeFingerprint: SCOPE, report: current, previousReport: previous, now: currentAt.getTime() });
  const s = sum(result.ledger, { now: currentAt });
  // The current value is the baseline for TID (the 100-token difference was
  // never observed and must not become an increment); OTHER is seeded from the
  // prior run because the current report does not list it.
  assert.equal(s.baselineTokens, 1000 + 100 + 50 + 5);
  assert.equal(s.observedTokens, 0);
  assert.equal(s.periods.today.totalTokens, 0);
  assert.equal(result.ledger.scopes[SCOPE].threads[OTHER].baselineSource, 'previous-report');
  // A prior report from another account, or one newer than the current report, is ignored.
  const foreign = ingestObservation(LEDGER(), { scopeFingerprint: SCOPE, report: current, previousReport: { ...previous, scopeFingerprint: SCOPE_B }, now: currentAt.getTime() });
  assert.equal(sum(foreign.ledger, { now: currentAt }).baselineTokens, 1100);
  const newer = ingestObservation(LEDGER(), { scopeFingerprint: SCOPE, report: current, previousReport: { ...previous, observedAt: day(2026, 10, 9).toISOString() }, now: currentAt.getTime() });
  assert.equal(sum(newer.ledger, { now: currentAt }).baselineTokens, 1100);
});

test('local thread matches exclude the cloud side entirely, by exact canonical UUID', () => {
  const at = day(2026, 10, 6);
  const state = ingest(LEDGER(), [{ total: usage(1000, 100) }], at);
  const matched = sum(state.ledger, { now: at, local: [TID, TID.toUpperCase()] });
  assert.equal(matched.periods.allTime.totalTokens, 0);
  assert.equal(matched.excludedReasons.matchedLocal, 1);
  assert.equal(matched.threads[TID].status, 'matched-local');
  assert.equal(matched.threads[TID].includedTokens, 0);
  const unrelated = sum(state.ledger, { now: at, local: [OTHER] });
  assert.equal(unrelated.periods.allTime.totalTokens, 1100);
});

test('a child whose parent is present and counted is conservatively excluded', () => {
  const at = day(2026, 10, 6);
  const rows = [
    { threadId: TID, total: usage(1000, 100) },
    { threadId: CHILD, total: usage(200, 20), extra: { engineParentId: TID } }
  ];
  const state = ingest(LEDGER(), rows, at);
  const s = sum(state.ledger, { now: at });
  assert.equal(s.excludedReasons.parentOverlap, 1);
  assert.equal(s.periods.allTime.totalTokens, 1100);
  assert.equal(s.threads[CHILD].status, 'parent-overlap');
  assert.equal(s.threads[CHILD].includedTokens, 0);
  // A child whose parent is not in this ledger at all stays included: there is
  // nothing to overlap with.
  const orphanState = ingest(LEDGER(), [{ threadId: CHILD, total: usage(200, 20), extra: { engineParentId: TID } }], at);
  const orphan = sum(orphanState.ledger, { now: at });
  assert.equal(orphan.excludedReasons.parentOverlap, 0);
  assert.equal(orphan.periods.allTime.totalTokens, 220);
  assert.equal(orphan.threads[CHILD].status, 'included');
  // Parent counted by a local session: the child inherits the same exclusion.
  const localParent = sum(state.ledger, { now: at, local: [TID] });
  assert.equal(localParent.excludedReasons.matchedLocal, 1);
  assert.equal(localParent.excludedReasons.parentOverlap, 1);
  assert.equal(localParent.periods.allTime.totalTokens, 0);
  // Parent present with no counters at all: nothing to overlap, child counts.
  const emptyParent = ingest(LEDGER(), [{ threadId: TID, total: null }, { threadId: CHILD, total: usage(200, 20), extra: { engineParentId: TID } }], at);
  assert.equal(sum(emptyParent.ledger, { now: at }).periods.allTime.totalTokens, 220);
});

test('thread caps, day pruning and day-entry caps keep the ledger bounded', () => {
  const first = ingest(LEDGER(), [{ total: usage(100, 0) }], day(2026, 1, 1));
  const state = ingest(first.ledger, [{ total: usage(105, 0) }], day(2026, 1, 2));
  const pruned = ingest(state.ledger, [{ total: usage(200, 0) }], day(2026, 11, 20));
  const kept = pruned.ledger.scopes[SCOPE].threads[TID];
  assert.equal(kept.days['2026-01-02'], undefined);
  assert.ok(kept.days['2026-11-20']);
  assert.equal(kept.increments.totalTokens, 100);
  const normalized = normalizeLedger({ version: 1, kind: LEDGER_KIND, updatedAt: null, scopes: { [SCOPE]: { updatedAt: null, threads: { [TID]: { threadId: TID, increments: { inputTokens: 'x' } } } } } });
  assert.equal(Object.keys(normalized.ledger.scopes[SCOPE].threads).length, 0);
  assert.equal(normalized.valid, false);
});

test('the UI thread map is bounded and sorted, and includes the exclusion reasons', () => {
  const at = day(2026, 10, 6);
  const rows = Array.from({ length: 10 }, (_, n) => ({
    threadId: `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    total: usage(100 * (n + 1), 0)
  }));
  const state = ingest(LEDGER(), rows, at);
  const s = sum(state.ledger, { now: at, local: [rows[9].threadId] });
  assert.equal(Object.keys(s.threads).length, 10);
  const first = Object.values(s.threads)[0];
  assert.ok(first.includedTokens >= Object.values(s.threads)[1].includedTokens);
  assert.equal(s.excludedThreads, 1);
});

test('validThreadId accepts only canonical UUIDs', () => {
  assert.equal(validThreadId(TID.toUpperCase()), TID);
  assert.equal(validThreadId('rollout-2026-10-06T10-00-00-' + TID), null);
  assert.equal(validThreadId('title ' + TID), null);
});
