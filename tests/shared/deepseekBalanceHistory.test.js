'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { computeConsumption } = require('../../src/shared/deepseekBalanceHistory');

// 2026-06-07T10:00:00 local
const NOW = new Date(2026, 5, 7, 10, 0, 0).getTime();
const at = (h) => new Date(2026, 5, 7, h, 0, 0).getTime();

test('computeConsumption: empty / single snapshot yields zero spend', () => {
  assert.deepEqual(computeConsumption([], NOW), {
    todaySpend: 0,
    monthSpend: 0,
    allTimeSpend: 0,
    trackingSince: new Date(NOW).toISOString(),
    monthSinceTracking: true
  });
  const one = computeConsumption([{ ts: at(9), paid: 10 }], NOW);
  assert.equal(one.todaySpend, 0);
  assert.equal(one.monthSpend, 0);
  assert.equal(one.allTimeSpend, 0);
});

test('computeConsumption: sums drops within the day', () => {
  const snaps = [{ ts: at(7), paid: 10 }, { ts: at(8), paid: 7 }, { ts: at(9), paid: 4 }];
  const r = computeConsumption(snaps, NOW);
  assert.equal(r.todaySpend, 6);
  assert.equal(r.monthSpend, 6);
});

test('computeConsumption: a top-up (balance increase) counts as zero, baseline carries', () => {
  const snaps = [
    { ts: at(7), paid: 10 }, { ts: at(8), paid: 7 }, { ts: at(9), paid: 4 },
    { ts: new Date(2026, 5, 7, 9, 30).getTime(), paid: 54 }, // +50 top-up
    { ts: new Date(2026, 5, 7, 9, 45).getTime(), paid: 51 }
  ];
  assert.equal(computeConsumption(snaps, NOW).todaySpend, 9);
});

test('computeConsumption: only today counted for todaySpend, month spans the month', () => {
  const y = (d, h) => new Date(2026, 5, d, h, 0, 0).getTime();
  const snaps = [{ ts: y(5, 9), paid: 10 }, { ts: y(5, 10), paid: 8 }, { ts: y(7, 9), paid: 8 }, { ts: y(7, 10), paid: 5 }];
  const r = computeConsumption(snaps, NOW);
  assert.equal(r.todaySpend, 3); // only the 8->5 drop on the 7th
  assert.equal(r.monthSpend, 5); // 2 (on 5th) + 3 (on 7th)
});

test('computeConsumption: monthSinceTracking false when earliest snapshot predates month start', () => {
  const may = new Date(2026, 4, 31, 23, 0, 0).getTime();
  const r = computeConsumption([{ ts: may, paid: 10 }, { ts: at(9), paid: 9 }], NOW);
  assert.equal(r.monthSinceTracking, false);
});

test('computeConsumption: rounds to cents', () => {
  const snaps = [{ ts: at(8), paid: 10 }, { ts: at(9), paid: 9.999 }];
  assert.equal(computeConsumption(snaps, NOW).todaySpend, 0); // 0.001 rounds to 0.00
});

const { recordConsumption } = require('../../src/shared/deepseekBalanceHistory');

function memoryStore(initial = {}) {
  const box = { value: JSON.parse(JSON.stringify(initial)), writes: 0 };
  return {
    readJson: () => JSON.parse(JSON.stringify(box.value)),
    writeJsonAtomic: (_path, value) => {
      box.value = JSON.parse(JSON.stringify(value));
      box.writes += 1;
    },
    peek: () => box.value,
    writes: () => box.writes
  };
}

test('recordConsumption: persists a compact balance anchor and daily spend', () => {
  const store = memoryStore();
  const t0 = new Date(2026, 5, 7, 8, 0, 0).getTime();
  const t1 = new Date(2026, 5, 7, 9, 0, 0).getTime();
  recordConsumption({ accountKey: 'sha256:abc', currency: 'CNY', paid: 10, now: t0, storePath: '/x' }, store);
  const r = recordConsumption({ accountKey: 'sha256:abc', currency: 'CNY', paid: 7, now: t1, storePath: '/x' }, store);
  assert.equal(r.todaySpend, 3);
  assert.deepEqual(store.peek()['sha256:abc'], {
    version: 2,
    currency: 'CNY',
    trackingSince: t0,
    lastPaid: 7,
    allTimeSpend: 3,
    dailySpend: { '2026-06-07': 3 }
  });
});

test('recordConsumption: resets the series when the funded currency changes', () => {
  const store = memoryStore();
  const t0 = new Date(2026, 5, 7, 8, 0, 0).getTime();
  const t1 = new Date(2026, 5, 7, 9, 0, 0).getTime();
  recordConsumption({ accountKey: 'k', currency: 'CNY', paid: 10, now: t0, storePath: '/x' }, store);
  const r = recordConsumption({ accountKey: 'k', currency: 'USD', paid: 4, now: t1, storePath: '/x' }, store);
  assert.equal(store.peek().k.currency, 'USD');
  assert.equal(store.peek().k.lastPaid, 4);
  assert.equal(store.peek().k.allTimeSpend, 0);
  assert.deepEqual(store.peek().k.dailySpend, {});
  assert.equal(r.todaySpend, 0);
});

test('recordConsumption: keeps an old balance anchor while pruning daily spend older than 40 days', () => {
  const old = new Date(2026, 3, 1, 8, 0, 0).getTime();
  const now = new Date(2026, 5, 7, 9, 0, 0).getTime();
  const store = memoryStore({
    k: {
      version: 2,
      currency: 'CNY',
      trackingSince: old,
      lastPaid: 10,
      allTimeSpend: 2,
      dailySpend: { '2026-04-02': 2 }
    }
  });
  const result = recordConsumption({ accountKey: 'k', currency: 'CNY', paid: 9, now, storePath: '/x' }, store);
  assert.equal(store.peek().k.lastPaid, 9);
  assert.equal(store.peek().k.allTimeSpend, 3);
  assert.deepEqual(store.peek().k.dailySpend, { '2026-06-07': 1 });
  assert.equal(result.todaySpend, 1);
  assert.equal(result.monthSpend, 1);
  assert.equal(result.allTimeSpend, 3);
  assert.equal(result.trackingSince, new Date(old).toISOString());
  assert.equal(result.monthSinceTracking, false);
});

test('recordConsumption: migrates repeated legacy snapshots into compact daily state', () => {
  const t0 = new Date(2026, 5, 7, 8, 0, 0).getTime();
  const t1 = new Date(2026, 5, 7, 9, 0, 0).getTime();
  const t2 = new Date(2026, 5, 7, 10, 0, 0).getTime();
  const store = memoryStore({
    k: {
      currency: 'CNY',
      snapshots: [
        { ts: t0, paid: 10 },
        { ts: t1, paid: 10 },
        { ts: t2, paid: 7 }
      ]
    }
  });

  const result = recordConsumption({ accountKey: 'k', currency: 'CNY', paid: 7, now: t2 + 1000, storePath: '/x' }, store);
  assert.deepEqual(store.peek().k, {
    version: 2,
    currency: 'CNY',
    trackingSince: t0,
    lastPaid: 7,
    allTimeSpend: 3,
    dailySpend: { '2026-06-07': 3 }
  });
  assert.equal(result.todaySpend, 3);
  assert.equal(result.allTimeSpend, 3);
  assert.equal(store.writes(), 1);
});

test('recordConsumption: unchanged balances are idempotent and do not rewrite the store', () => {
  const store = memoryStore();
  const t0 = new Date(2026, 5, 7, 8, 0, 0).getTime();
  recordConsumption({ accountKey: 'k', currency: 'CNY', paid: 4.61, now: t0, storePath: '/x' }, store);
  recordConsumption({ accountKey: 'k', currency: 'CNY', paid: 4.61, now: t0 + 5 * 60 * 1000, storePath: '/x' }, store);
  recordConsumption({ accountKey: 'k', currency: 'CNY', paid: 4.61, now: t0 + 10 * 60 * 1000, storePath: '/x' }, store);
  assert.equal(store.writes(), 1);
  assert.deepEqual(store.peek().k.dailySpend, {});
  assert.equal(store.peek().k.allTimeSpend, 0);
});

test('recordConsumption: all-time spend survives daily bucket pruning', () => {
  const old = new Date(2026, 3, 1, 8, 0, 0).getTime();
  const now = new Date(2026, 5, 7, 9, 0, 0).getTime();
  const store = memoryStore({
    k: {
      version: 2,
      currency: 'CNY',
      trackingSince: old,
      lastPaid: 9,
      allTimeSpend: 12,
      dailySpend: { '2026-04-02': 12 }
    }
  });
  const result = recordConsumption({ accountKey: 'k', currency: 'CNY', paid: 8, now, storePath: '/x' }, store);
  assert.deepEqual(store.peek().k.dailySpend, { '2026-06-07': 1 });
  assert.equal(store.peek().k.allTimeSpend, 13);
  assert.equal(result.allTimeSpend, 13);
});
