'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

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

test('recordConsumption: migrates the legacy file into the v2 path without modifying the old file', () => {
  const old0 = new Date(2026, 3, 1, 8, 0, 0).getTime();
  const old1 = new Date(2026, 3, 2, 8, 0, 0).getTime();
  const t0 = new Date(2026, 5, 7, 8, 0, 0).getTime();
  const t1 = new Date(2026, 5, 7, 9, 0, 0).getTime();
  const files = {
    '/legacy.json': {
      k: {
        currency: 'CNY',
        snapshots: [
          { ts: t0, paid: 10 },
          { ts: t1, paid: 7 }
        ]
      },
      retired: {
        currency: 'CNY',
        snapshots: [
          { ts: old0, paid: 9 },
          { ts: old1, paid: 5 }
        ]
      }
    }
  };
  const writes = [];
  const deps = {
    readJson: (filePath, fallback) => (
      Object.hasOwn(files, filePath)
        ? JSON.parse(JSON.stringify(files[filePath]))
        : fallback
    ),
    writeJsonAtomic: (filePath, value) => {
      files[filePath] = JSON.parse(JSON.stringify(value));
      writes.push(filePath);
    }
  };

  const result = recordConsumption({
    accountKey: 'k',
    currency: 'CNY',
    paid: 7,
    now: t1 + 1000,
    storePath: '/v2.json',
    legacyStorePath: '/legacy.json'
  }, deps);

  assert.deepEqual(writes, ['/v2.json']);
  assert.equal(files['/legacy.json'].k.snapshots.length, 2);
  assert.equal(files['/legacy.json'].retired.snapshots.length, 2);
  assert.equal(files['/v2.json'].k.version, 2);
  assert.equal(files['/v2.json'].k.allTimeSpend, 3);
  assert.deepEqual(files['/v2.json'].retired, {
    version: 2,
    currency: 'CNY',
    trackingSince: old0,
    lastPaid: 5,
    allTimeSpend: 4,
    dailySpend: {}
  });
  assert.equal(result.allTimeSpend, 3);
});

test('recordConsumption: a top-up resets the anchor without counting as spend', () => {
  const store = memoryStore();
  const t0 = new Date(2026, 5, 7, 8, 0, 0).getTime();
  recordConsumption({ accountKey: 'k', currency: 'CNY', paid: 10, now: t0, storePath: '/x' }, store);
  recordConsumption({ accountKey: 'k', currency: 'CNY', paid: 60, now: t0 + 1000, storePath: '/x' }, store);
  const result = recordConsumption({ accountKey: 'k', currency: 'CNY', paid: 57, now: t0 + 2000, storePath: '/x' }, store);

  assert.equal(result.todaySpend, 3);
  assert.equal(result.allTimeSpend, 3);
  assert.equal(store.peek().k.lastPaid, 57);
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

test('recordConsumption: repairs a finite timestamp outside the Date range', () => {
  const store = memoryStore({
    k: {
      version: 2,
      currency: 'CNY',
      trackingSince: Number.MAX_SAFE_INTEGER,
      lastPaid: 4.61,
      allTimeSpend: 0,
      dailySpend: {}
    }
  });
  const now = new Date(2026, 5, 7, 9, 0, 0).getTime();
  const result = recordConsumption({ accountKey: 'k', currency: 'CNY', paid: 4.61, now, storePath: '/x' }, store);

  assert.equal(result.trackingSince, new Date(now).toISOString());
  assert.equal(store.peek().k.trackingSince, now);
  assert.equal(store.writes(), 1);
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
