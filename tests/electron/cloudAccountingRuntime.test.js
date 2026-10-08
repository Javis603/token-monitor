'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCloudAccountingRuntime, writeJsonAtomic, readFileLimited } = require('../../src/electron/cloudLedgerRuntime');
const { applyCloudAccounting, collectLocalCodexThreadIds, canonicalCodexThreadId } = require('../../src/electron/cloudPresentation');

const SCOPE = 'a'.repeat(64);
const SCOPE_B = 'b'.repeat(64);
const TID = '01900000-0000-7000-8000-000000000001';
const TID2 = '01900000-0000-7000-8000-000000000002';
const usage = (input, output, { cached = 0, reasoning = 0 } = {}) => ({
  inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: input + output
});
const day = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0, 0);
function report(threads, at, scope = SCOPE) {
  return {
    version: 1, kind: 'codex-cloud-auto-watch', scopeFingerprint: scope, observedAt: at.toISOString(),
    threads: threads.map((t) => ({ threadId: t.threadId || TID, status: 'observed', total: t.total, observedAt: at.toISOString() }))
  };
}
function temp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cloud-ledger-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function runtime(t, dir, options = {}) {
  const updates = [];
  const instance = createCloudAccountingRuntime({
    dataDir: dir,
    getScope: () => SCOPE,
    readReport: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    readPreviousReport: () => null,
    now: () => options.now ?? day(2026, 10, 6, 12).getTime(),
    onUpdate: (event) => updates.push(event),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    ...options
  });
  instance.updates = updates;
  t.after(() => instance.stop());
  return instance;
}

test('the ledger is written atomically with private permissions and reloads identically', (t) => {
  const dir = temp(t);
  let current = report([{ total: usage(1000, 100, { cached: 400, reasoning: 10 }) }], day(2026, 10, 6, 10));
  const first = runtime(t, dir, { readReport: () => current });
  first.start();
  const file = path.join(dir, 'cloud-ledger.json');
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual([...new Set(fs.readdirSync(dir).filter((name) => name.includes('.tmp')))], []);
  const before = first.summary({});
  assert.equal(before.periods.allTime.totalTokens, 1100);
  first.stop();

  const second = runtime(t, dir, { readReport: () => current });
  second.start();
  const after = second.summary({});
  assert.deepEqual(after.periods, before.periods);
  const revision = second.revision();
  const updates = second.updates.length;
  second.refresh();
  assert.equal(second.revision(), revision);
  assert.equal(second.updates.length, updates);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.kind, 'codex-cloud-usage-ledger');
  assert.ok(raw.scopes[SCOPE].threads[TID].baseline);
});

test('restart and reconnect are idempotent: growth counts once, repeats count zero', (t) => {
  const dir = temp(t);
  let current = report([{ total: usage(100, 10) }], day(2026, 10, 6, 10));
  const first = runtime(t, dir, { readReport: () => current, now: () => day(2026, 10, 6, 10).getTime() });
  first.start();
  first.stop();

  const second = runtime(t, dir, { readReport: () => current, now: () => Date.parse(current.observedAt) });
  second.start();
  assert.equal(second.summary({}).periods.today.totalTokens, 0);
  assert.equal(second.refresh().changed, false); // repeated cumulative snapshot
  current = report([{ total: usage(160, 30) }], day(2026, 10, 6, 12));
  assert.equal(second.refresh().changed, true);
  assert.equal(second.summary({}).periods.today.totalTokens, 80);
  assert.equal(second.refresh().changed, false);
  assert.equal(second.summary({}).periods.today.totalTokens, 80);
  second.stop();

  // A third process (reconnect + restart) sees the same cumulative value and
  // must not re-add the increment.
  const third = runtime(t, dir, { readReport: () => current, now: () => day(2026, 10, 6, 13).getTime() });
  third.start();
  assert.equal(third.summary({}).periods.today.totalTokens, 80);
  assert.equal(third.summary({}).periods.allTime.totalTokens, 190);
});

test('a corrupt ledger freezes recording and preserves the original across restart', (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'cloud-ledger.json');
  fs.writeFileSync(file, '{ this is not json', { mode: 0o600 });
  const current = report([{ total: usage(500, 50) }], day(2026, 10, 7, 10));
  const first = runtime(t, dir, { readReport: () => current, now: () => day(2026, 10, 7, 10).getTime() });
  first.start();
  assert.equal(first.summary({}).periods.allTime.totalTokens, 0);
  assert.equal(first.summary({}).reason, 'CORRUPT_LEDGER');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json');
  first.stop();
  const second = runtime(t, dir, { readReport: () => current, now: () => day(2026, 10, 7, 11).getTime() });
  second.start();
  assert.equal(second.summary({}).periods.allTime.totalTokens, 0);
  assert.equal(second.summary({}).reason, 'CORRUPT_LEDGER');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json');
  assert.equal(second.summary({}).periods.today.totalTokens, 0);
});

test('invalid entries inside a readable ledger are dropped without taking the valid ones down', (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'cloud-ledger.json');
  writeJsonAtomic(file, {
    version: 1,
    kind: 'codex-cloud-usage-ledger',
    updatedAt: new Date().toISOString(),
    scopes: {
      [SCOPE]: {
        updatedAt: new Date().toISOString(),
        threads: {
          [TID]: { threadId: TID, baseline: usage(100, 10), observed: usage(100, 10), increments: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
          bad: { threadId: 'not-a-uuid', baseline: { inputTokens: 'x' } },
          [TID2]: { threadId: TID2, baseline: { inputTokens: -5, outputTokens: 0, totalTokens: -5 } }
        }
      }
    }
  }, fs);
  const current = report([], day(2026, 10, 7, 10));
  const instance = runtime(t, dir, { readReport: () => current, now: () => day(2026, 10, 7, 10).getTime() });
  instance.start();
  const summary = instance.summary({});
  assert.equal(summary.periods.allTime.totalTokens, 110);
  assert.equal(Object.keys(summary.threads).length, 1);
});

test('account changes never merge ledgers and never leak the other account into the summary', (t) => {
  const dir = temp(t);
  let scope = SCOPE;
  let current = report([{ total: usage(100, 10) }], day(2026, 10, 6, 10));
  const instance = runtime(t, dir, { getScope: () => scope, readReport: () => current, now: () => Date.parse(current.observedAt) });
  instance.start();
  assert.equal(instance.summary({}).periods.allTime.totalTokens, 110);
  // Switch accounts: the report still belongs to account A, so nothing is added
  // to account B, and B's summary is empty.
  scope = SCOPE_B;
  instance.refresh();
  const viewB = instance.summary({});
  assert.equal(viewB.periods.allTime.totalTokens, 0);
  assert.equal(viewB.state, 'inactive');
  assert.ok(!JSON.stringify(viewB).includes(SCOPE));
  // Back to A: the original ledger is intact.
  scope = SCOPE;
  current = report([{ total: usage(140, 20) }], day(2026, 10, 6, 11));
  instance.refresh();
  const viewA = instance.summary({});
  assert.equal(viewA.periods.allTime.totalTokens, 160);
  assert.equal(viewA.periods.today.totalTokens, 50);
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'cloud-ledger.json'), 'utf8'));
  assert.deepEqual(Object.keys(file.scopes), [SCOPE]);
});

test('a failed persist keeps the observation in memory, reports it unpersisted and retries', (t) => {
  const dir = temp(t);
  const current = report([{ total: usage(100, 10) }], day(2026, 10, 6, 10));
  let failWrites = true;
  const guarded = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'openSync') {
        return (...args) => {
          if (failWrites && String(args[0]).endsWith('.tmp')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          return target.openSync(...args);
        };
      }
      return target[prop];
    }
  });
  const instance = createCloudAccountingRuntime({
    dataDir: dir, getScope: () => SCOPE, readReport: () => current, readPreviousReport: () => null,
    now: () => day(2026, 10, 6, 10).getTime(), fs: guarded,
    setInterval: () => ({ unref() {} }), clearInterval: () => {}, onUpdate: () => {}
  });
  t.after(() => instance.stop());
  instance.start();
  assert.equal(instance.summary({}).periods.allTime.totalTokens, 110);
  assert.equal(fs.existsSync(path.join(dir, 'cloud-ledger.json')), false);
  failWrites = false;
  const retry = runtime(t, dir, { readReport: () => current, now: () => day(2026, 10, 6, 10).getTime() });
  retry.start();
  assert.equal(retry.summary({}).periods.allTime.totalTokens, 110);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cloud-ledger.json'), 'utf8')).scopes[SCOPE].threads[TID].baseline.totalTokens, 110);
});

test('missing reports and missing accounts are inactive, not zero-usage claims', (t) => {
  const dir = temp(t);
  const instance = runtime(t, dir, { readReport: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  instance.start();
  const summary = instance.summary({});
  assert.equal(summary.state, 'inactive');
  assert.equal(summary.reason, 'REPORT_NOT_READY');
  assert.equal(summary.periods.allTime.totalTokens, 0);
  instance.stop();
  const noAccount = runtime(t, dir, { getScope: () => { throw new Error('no auth'); } });
  noAccount.start();
  assert.equal(noAccount.summary({}).reason, 'NO_ACCOUNT');
});

test('the polling interval is unref-ed and stopped on request', (t) => {
  const dir = temp(t);
  let ticks = 0;
  let unrefed = false;
  let cleared = false;
  let current = report([{ total: usage(10, 1) }], day(2026, 10, 6, 10));
  const instance = createCloudAccountingRuntime({
    dataDir: dir, getScope: () => SCOPE, readReport: () => current, readPreviousReport: () => null,
    intervalMs: 2000,
    setInterval: (fn) => { ticks += 1; return { fn, unref() { unrefed = true; } }; },
    clearInterval: () => { cleared = true; },
    now: () => day(2026, 10, 6, 10).getTime(), onUpdate: () => {}
  });
  instance.start();
  assert.equal(ticks, 1);
  assert.equal(unrefed, true);
  instance.stop();
  assert.equal(cleared, true);
});

test('the presentation overlay folds eligible counts into totals, components and the codex tool split', () => {
  const stats = {
    periods: {
      today: { totalTokens: 1000, costUsd: 1, cacheReadTokens: 200, cacheWriteTokens: 100, outputTokens: 50, unclassifiedTokens: 650, clients: { claude: 1000 }, clientCosts: { claude: 1 }, models: { m: 1000 }, modelCosts: { m: 1 }, sessions: { 'claude:a': { client: 'claude' } } },
      month: { totalTokens: 2000, costUsd: 2, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unclassifiedTokens: 2000, clients: {}, clientCosts: {}, models: {}, modelCosts: {}, sessions: {} },
      allTime: { totalTokens: 3000, costUsd: 3, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unclassifiedTokens: 3000, clients: {}, clientCosts: {}, models: {}, modelCosts: {}, sessions: {} }
    },
    devices: [{ deviceId: 'd1' }],
    historyRevision: 'rev'
  };
  const accounting = {
    version: 1, state: 'active', reason: null, observedAt: '2026-10-07T01:00:00.000Z', reportAt: '2026-10-07T01:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z',
    periods: {
      today: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 30, outputTokens: 20, reasoningOutputTokens: 5, threadCount: 2 },
      month: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 40, outputTokens: 50, reasoningOutputTokens: 5, threadCount: 2 },
      allTime: { totalTokens: 500, inputTokens: 400, cachedInputTokens: 100, outputTokens: 100, reasoningOutputTokens: 5, threadCount: 3, partialComponents: false }
    },
    baselineTokens: 350, observedTokens: 150, excludedThreads: 1,
    excludedReasons: { matchedLocal: 1, parentOverlap: 0 }, partialThreads: 0, bridgedThreads: 0,
    unknownCost: true, threads: { [TID]: { status: 'matched-local', includedTokens: 0 } }
  };
  const result = applyCloudAccounting(stats, accounting);
  assert.equal(result.periods.today.totalTokens, 1100);
  assert.equal(result.periods.today.cacheReadTokens, 230);
  assert.equal(result.periods.today.outputTokens, 70);
  assert.equal(result.periods.today.unclassifiedTokens, 700);
  // Total closes over its components exactly as before the overlay.
  const today = result.periods.today;
  assert.equal(today.totalTokens, today.cacheReadTokens + today.cacheWriteTokens + today.outputTokens + today.unclassifiedTokens);
  assert.equal(result.periods.today.clients.codex, 100);
  assert.equal(result.periods.today.clients.claude, 1000);
  assert.equal(result.periods.today.costUsd, 1);
  assert.deepEqual(result.periods.today.models, { m: 1000 });
  assert.equal(result.periods.allTime.totalTokens, 3500);
  assert.equal(result.cloudAccounting.periods.today.totalTokens, 100);
  assert.equal(result.cloudAccounting.baselineTokens, 350);
  assert.equal(result.cloudAccounting.unknownCost, true);
  assert.equal(result.devices, stats.devices);
  assert.equal(result.historyRevision, 'rev');
  assert.equal(stats.periods.today.totalTokens, 1000, 'input stats stay untouched');
});

test('an inactive or empty summary attaches explanation state without patching totals', () => {
  const stats = { periods: { today: { totalTokens: 42 }, month: { totalTokens: 42 }, allTime: { totalTokens: 42 } } };
  const inactive = applyCloudAccounting(stats, {
    version: 1, state: 'inactive', reason: 'REPORT_NOT_READY', periods: {
      today: { totalTokens: 0, threadCount: 0 }, month: { totalTokens: 0, threadCount: 0 }, allTime: { totalTokens: 0, threadCount: 0 }
    },
    excludedThreads: 0, excludedReasons: {}, partialThreads: 0, bridgedThreads: 0, threads: {}
  });
  assert.equal(inactive.periods, stats.periods);
  assert.equal(inactive.cloudAccounting.state, 'inactive');
  assert.equal(inactive.cloudAccounting.reason, 'REPORT_NOT_READY');
  assert.equal(applyCloudAccounting(stats, null), stats);
  assert.equal(applyCloudAccounting(undefined, null), undefined);
});

test('local identity collection accepts only exact canonical Codex thread UUIDs', () => {
  assert.equal(canonicalCodexThreadId({ client: 'codex', sessionId: TID.toUpperCase() }, 'codex:x'), TID);
  assert.equal(canonicalCodexThreadId({ client: 'codex', canonicalSessionId: TID }, 'x'), TID);
  assert.equal(canonicalCodexThreadId({ client: 'codex' }, `codex:${TID}`), TID);
  assert.equal(canonicalCodexThreadId({ client: 'codex', sessionId: `rollout-2026-10-06T10-00-00-${TID}` }, 'codex:x'), null);
  assert.equal(canonicalCodexThreadId({ client: 'codex', title: TID }, 'codex:x'), null);
  assert.equal(canonicalCodexThreadId({ client: 'claude', sessionId: TID }, 'claude:x'), null);
  const ids = collectLocalCodexThreadIds({ periods: {
    today: { sessions: { [`codex:${TID}`]: { client: 'codex' }, [`claude:${TID2}`]: { client: 'claude' } } },
    allTime: { sessions: { 'codex:rollout-fragment': { client: 'codex', sessionId: `rollout ${TID2}` } } }
  } });
  assert.deepEqual([...ids], [TID]);
});

test('the ledger file reader refuses oversized, foreign-owned or symlinked files', (t) => {
  const dir = temp(t);
  const real = path.join(dir, 'real.json');
  fs.writeFileSync(real, JSON.stringify({ hello: 1 }), { mode: 0o600 });
  const link = path.join(dir, 'link.json');
  fs.symlinkSync(real, link);
  assert.throws(() => readFileLimited(link, 1024, fs), /UNSAFE_CLOUD_LEDGER_FILE|ENOENT|ELOOP/);
  const big = path.join(dir, 'big.json');
  fs.writeFileSync(big, Buffer.alloc(2048, 0x20), { mode: 0o600 });
  assert.throws(() => readFileLimited(big, 1024, fs), { code: 'UNSAFE_CLOUD_LEDGER_FILE' });
  assert.deepEqual(readFileLimited(real, 1024, fs), { hello: 1 });
});
