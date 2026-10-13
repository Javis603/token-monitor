'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const accounting = require('../../src/shared/providers/codex/cloudAccounting');
const { createCloudAccountingRuntime } = require('../../src/electron/cloudLedgerRuntime');
const presentation = require('../../src/electron/cloudPresentation');
const { localDayKey } = require('../../src/shared/history');
const SCOPE = 'a'.repeat(64), OTHER_SCOPE = 'b'.repeat(64);
const ROOT = '019abcde-0000-7000-8000-000000000001', CHILD = '019abcde-0000-7000-8000-000000000002';
const empty = () => ({ version: 1, kind: accounting.LEDGER_KIND, updatedAt: null, scopes: {} });
const usage = (total) => ({ inputTokens: total, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: total });
function report(rows, at, scope = SCOPE) {
  const stamp = new Date(at).toISOString();
  return { version: 1, kind: 'codex-cloud-auto-watch', state: 'listening', scopeFingerprint: scope, observedAt: stamp,
    threads: rows.map((r) => ({ threadId: ROOT, kind: 'user', status: 'observed', total: usage(100), observedAt: stamp, ...r })) };
}
function fold(ledger, rows, at) {
  return accounting.ingestObservation(ledger, { scopeFingerprint: SCOPE, report: report(rows, at), now: at });
}
function sum(ledger, at, localThreadUsage = {}) {
  return accounting.summarize(ledger, { scopeFingerprint: SCOPE, now: at, localThreadUsage });
}
function runtime(t, options = {}) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-count-regression-')));
  const instance = createCloudAccountingRuntime({ dataDir, readPreviousReport: () => null,
    setInterval: () => ({ unref() {} }), clearInterval() {}, ...options });
  t.after(() => { instance.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return instance;
}

test('100 -> 80 -> restart -> 100 -> 105 counts only five new tokens', () => {
  const at = Date.now();
  let state = fold(empty(), [{ total: usage(100) }], at).ledger;
  state = fold(state, [{ total: usage(80) }], at + 1000).ledger;
  const restored = accounting.normalizeLedger(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.valid, true);
  state = fold(restored.ledger, [{ total: usage(100) }], at + 2000).ledger;
  assert.equal(sum(state, at + 2000).periods.allTime.totalTokens, 100);
  state = fold(state, [{ total: usage(105) }], at + 3000).ledger;
  assert.equal(sum(state, at + 3000).periods.allTime.totalTokens, 105);
  assert.equal(sum(state, at + 3000).periods.today.totalTokens, 5);
});

test('a late parent link persists even when both token snapshots are duplicates', () => {
  const at = Date.now(), rows = [{ total: usage(100) }, { threadId: CHILD, total: usage(50) }];
  let state = fold(empty(), rows, at).ledger;
  const late = fold(state, [rows[0], { ...rows[1], engineParentId: ROOT }], at + 1000);
  assert.equal(late.changed, true);
  state = accounting.normalizeLedger(JSON.parse(JSON.stringify(late.ledger))).ledger;
  assert.equal(sum(state, at + 1000).periods.allTime.totalTokens, 100);
  assert.equal(sum(state, at + 1000).excludedReasons.parentOverlap, 1);
  assert.equal(fold(state, [rows[0], { ...rows[1], engineParentId: ROOT }], at + 2000).changed, false);
});

test('parent metadata with no new usage still removes a former double contribution', () => {
  const at = Date.now();
  const initial = fold(empty(), [{ total: usage(100) }, { threadId: CHILD, total: usage(50) }], at);
  const late = fold(initial.ledger, [{ threadId: CHILD, total: null, status: 'no-usage-notification', engineParentId: ROOT }], at + 1000);
  assert.equal(late.changed, true);
  assert.equal(sum(late.ledger, at + 1000).periods.allTime.totalTokens, 100);
});

test('comparable local/cloud counts form a max union rather than a sum or whole-thread omission', () => {
  const at = Date.now(), state = fold(empty(), [{ total: usage(100) }], at).ledger;
  const raw = (n) => ({ periods: { allTime: { totalTokens: n, sessions: { [ROOT]: { client: 'codex', sessionId: ROOT, totalTokens: n } } } } });
  const first = presentation.applyCloudAccounting(raw(80), sum(state, at, { [ROOT]: { allTime: 80 } }));
  assert.equal(first.periods.allTime.totalTokens, 100);
  const second = presentation.applyCloudAccounting(raw(110), sum(state, at, { [ROOT]: { allTime: 110 } }));
  assert.equal(second.periods.allTime.totalTokens, 110);
  assert.equal(first.cloudAccounting.periods.allTime.totalTokens, 20);
  assert.equal(first.cloudAccounting.partialComponents, true);
  assert.equal(first.periods.allTime.unclassifiedTokens, 20);
});

test('a DAY local row cannot masquerade as an all-time comparable counter', () => {
  const at = Date.now(), state = fold(empty(), [{ total: usage(1000) }], at).ledger;
  const raw = { periods: { today: { sessions: { [ROOT]: { client: 'codex', sessionId: ROOT, totalTokens: 10 } } } } };
  const local = presentation.collectLocalCodexThreadUsage(raw);
  assert.equal(local[ROOT].allTime, undefined);
  const view = sum(state, at, local);
  assert.equal(view.periods.allTime.totalTokens, 0);
  assert.equal(view.partialThreads, 1);
});

test('re-projecting a cloud presentation uses its original source and cannot add again', () => {
  const at = Date.now(), summary = sum(fold(empty(), [{ total: usage(100) }], at).ledger, at);
  const raw = { periods: { allTime: { totalTokens: 20 } } };
  const first = presentation.applyCloudAccounting(raw, summary);
  const second = presentation.applyCloudAccounting(first, summary);
  assert.equal(first.periods.allTime.totalTokens, 120);
  assert.equal(second.periods.allTime.totalTokens, 120);
  assert.equal(raw.periods.allTime.totalTokens, 20);
  const cleared = presentation.applyCloudAccounting(second, sum(empty(), at));
  assert.equal(cleared.periods.allTime.totalTokens, 20);
});

test('an aggregate overflow preserves safe partial counts instead of emitting an unsafe integer', () => {
  const at = Date.now();
  const state = fold(empty(), [{ total: usage(Number.MAX_SAFE_INTEGER) }, { threadId: CHILD, total: usage(5) }], at).ledger;
  const view = sum(state, at);
  assert.ok(Number.isSafeInteger(view.periods.allTime.totalTokens));
  assert.equal(view.periods.allTime.totalTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(view.excludedReasons.unsafeCounter, 1);
  assert.equal(view.partialThreads, 1);
});

test('capacity cannot erase a previous account lifetime ledger', () => {
  const at = Date.now();
  let ledger = empty();
  for (const c of ['a', 'b', 'c', 'd']) {
    const scope = c.repeat(64);
    ledger = accounting.ingestObservation(ledger, { scopeFingerprint: scope, report: report([{}], at, scope), now: at }).ledger;
  }
  const before = JSON.stringify(ledger), nextScope = 'e'.repeat(64);
  const result = accounting.ingestObservation(ledger, { scopeFingerprint: nextScope, report: report([{}], at, nextScope), now: at });
  assert.equal(result.status, 'SCOPE_CAPACITY');
  assert.equal(JSON.stringify(result.ledger), before);
});

test('account changes during the report read are rejected before persistence', (t) => {
  let scope = SCOPE; const at = Date.now();
  const instance = runtime(t, { getScope: () => scope, now: () => at,
    readReport: () => { scope = OTHER_SCOPE; return report([{}], at); } });
  instance.start();
  assert.equal(instance.summary().periods.allTime.totalTokens, 0);
  assert.equal(instance.summary().reason, 'ACCOUNT_CHANGED');
  assert.equal(fs.existsSync(instance.ledgerPath), false);
});

test('the actual main overlay cache cannot retain former-account counts before the next poll', (t) => {
  let scope = SCOPE; const at = Date.now();
  const instance = runtime(t, { getScope: () => scope, now: () => at, readReport: () => report([{}], at) });
  instance.start();
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf('const cloudLocalIdsCache ='), end = source.indexOf('// Every input besides', start);
  assert.ok(start > 0 && end > start);
  const context = vm.createContext({ cloudAccountingRuntime: instance, localDevice: null, lastCollectedDevice: null,
    collectLocalCodexThreadUsage: presentation.collectLocalCodexThreadUsage, applyCloudAccounting: presentation.applyCloudAccounting, localDayKey });
  vm.runInContext(source.slice(start, end), context);
  const project = vm.runInContext('withCloudAccounting', context);
  const raw = { periods: { allTime: { totalTokens: 20 } } };
  assert.equal(project(raw, raw).periods.allTime.totalTokens, 120);
  scope = OTHER_SCOPE;
  assert.equal(project(raw, raw).periods.allTime.totalTokens, 20);
  assert.equal(project(raw, raw).cloudAccounting.state, 'inactive');
});

test('day rollover publishes without new token events', (t) => {
  let at = new Date(2026, 9, 8, 23, 59).getTime(); const events = [];
  const instance = runtime(t, { getScope: () => SCOPE, now: () => at,
    readReport: () => report([{}], at), onUpdate: (e) => events.push(e) });
  instance.start(); const before = events.length;
  at = new Date(2026, 9, 9, 0, 1).getTime();
  assert.equal(instance.refresh().changed, false);
  assert.ok(events.length > before);
  assert.equal(instance.summary().periods.today.totalTokens, 0);
  assert.equal(instance.summary().periods.allTime.totalTokens, 100);
});

test('stored inconsistent counters and invented daily totals are corrupt, not a fresh baseline', () => {
  const at = Date.now(), ledger = fold(empty(), [{}], at).ledger;
  const corrupt = JSON.parse(JSON.stringify(ledger));
  corrupt.scopes[SCOPE].threads[ROOT].days[localDayKey(new Date(at))] = usage(1000);
  assert.equal(accounting.normalizeLedger(corrupt).valid, false);
  const wrong = JSON.parse(JSON.stringify(ledger));
  wrong.scopes[SCOPE].threads[ROOT].increments.totalTokens = 5;
  assert.equal(accounting.normalizeLedger(wrong).valid, false);
});

test('billing metadata survives a missing numeric notification and prior-run seeding', () => {
  const at = Date.now(), current = report([{ kind: 'aeon', total: null, status: 'no-usage-notification' }], at);
  const previous = report([{ kind: 'aeon', total: usage(100) }], at - 1000);
  const seeded = accounting.ingestObservation(empty(), { scopeFingerprint: SCOPE, report: current, previousReport: previous, now: at });
  const view = sum(seeded.ledger, at);
  assert.equal(view.periods.allTime.totalTokens, 100);
  assert.equal(view.unknownCost, true);
  assert.equal(view.billingRows[0].kind, 'aeon');
  assert.equal(fold(seeded.ledger, [{ kind: 'aeon', total: usage(100) }], at + 1000).changed, false);
});

test('conflicting canonical local aliases suppress potentially overlapping cloud contributions', () => {
  const at = Date.now();
  const raw = { periods: { allTime: { totalTokens: 80, sessions: {
    [`codex:${ROOT}`]: { client: 'codex', sessionId: ROOT, threadId: CHILD, totalTokens: 80 }
  } } } };
  const local = presentation.collectLocalCodexThreadUsage(raw);
  assert.equal(local[ROOT].ambiguous, true);
  assert.equal(local[CHILD].ambiguous, true);
  const state = fold(empty(), [{ total: usage(100) }], at).ledger;
  const view = sum(state, at, local);
  assert.equal(view.periods.allTime.totalTokens, 0);
  assert.equal(view.partialThreads, 1);
  assert.equal(presentation.applyCloudAccounting(raw, view).periods.allTime.totalTokens, 80);
});
