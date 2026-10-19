'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WORKBUDDY_USAGE_RETENTION_MS,
  recordWorkbuddyUsage
} = require('../../src/shared/providers/workbuddy/usageHistory');

function memoryStore(initial = {}) {
  const box = { value: JSON.parse(JSON.stringify(initial)), writes: 0 };
  const io = {
    readJson: () => JSON.parse(JSON.stringify(box.value)),
    writeJsonAtomic: (_path, value) => {
      box.value = JSON.parse(JSON.stringify(value));
      box.writes += 1;
    }
  };
  return { io, peek: () => box.value, writes: () => box.writes };
}

const DAY = 24 * 60 * 60 * 1000;
// A fixed local afternoon keeps every bucket on the intended local day.
const at = (year, month, day, hour = 14) => new Date(year, month - 1, day, hour).getTime();
const observe = (store, observation) => recordWorkbuddyUsage({
  storePath: '/x',
  ...observation,
  ...store.io
});

test('recordWorkbuddyUsage: the first observation baselines without inventing spend', () => {
  const store = memoryStore();
  const now = at(2026, 10, 19);
  const result = observe(store, { accountKey: 'sha256:abc', used: 100, now });

  assert.equal(result.todaySpend, 0);
  assert.equal(result.weekSpend, 0);
  assert.equal(result.monthSpend, 0);
  assert.equal(result.allTimeSpend, 0);
  assert.equal(result.trackingSince, new Date(now).toISOString());
  assert.equal(result.monthSinceTracking, true);
  assert.deepEqual(store.peek(), {
    version: 1,
    accounts: {
      'sha256:abc': {
        lastUsed: 100,
        dailySpend: {},
        allTimeSpend: 0,
        trackingSince: now
      }
    }
  });
  assert.equal(store.writes(), 1);
});

test('recordWorkbuddyUsage: positive deltas land on the observation day and every period', () => {
  const store = memoryStore();
  observe(store, { accountKey: 'k', used: 100, now: at(2026, 10, 19, 8) });
  const result = observe(store, { accountKey: 'k', used: 130, now: at(2026, 10, 19, 9) });

  assert.equal(result.todaySpend, 30);
  assert.equal(result.weekSpend, 30);
  assert.equal(result.monthSpend, 30);
  assert.equal(result.allTimeSpend, 30);
  assert.deepEqual(store.peek().accounts.k.dailySpend, { '2026-10-19': 30 });
});

test('recordWorkbuddyUsage: repeated observations on one day accumulate', () => {
  const store = memoryStore();
  observe(store, { accountKey: 'k', used: 100, now: at(2026, 10, 19, 8) });
  observe(store, { accountKey: 'k', used: 110, now: at(2026, 10, 19, 9) });
  const result = observe(store, { accountKey: 'k', used: 125, now: at(2026, 10, 19, 10) });

  assert.equal(result.todaySpend, 25);
  assert.equal(result.monthSpend, 25);
  assert.equal(result.allTimeSpend, 25);
});

test('recordWorkbuddyUsage: a cycle reset or expiry rebases the baseline without negative spend', () => {
  const store = memoryStore();
  observe(store, { accountKey: 'k', used: 100, now: at(2026, 10, 19, 8) });
  observe(store, { accountKey: 'k', used: 130, now: at(2026, 10, 19, 9) });
  // The monthly cycle resets the package: the aggregate used total drops.
  const dropped = observe(store, { accountKey: 'k', used: 40, now: at(2026, 10, 20, 7) });
  assert.equal(dropped.todaySpend, 0);
  assert.equal(dropped.weekSpend, 30);
  assert.equal(dropped.monthSpend, 30);
  assert.equal(dropped.allTimeSpend, 30);
  // Spend after the reset counts from the new baseline, not against the old one.
  const after = observe(store, { accountKey: 'k', used: 55, now: at(2026, 10, 20, 8) });
  assert.equal(after.todaySpend, 15);
  assert.equal(after.monthSpend, 45);
  assert.equal(after.allTimeSpend, 45);
});

test('recordWorkbuddyUsage: day, rolling week and calendar month sums stay separate', () => {
  const store = memoryStore();
  observe(store, { accountKey: 'k', used: 0, now: at(2026, 9, 30, 8) });
  observe(store, { accountKey: 'k', used: 10, now: at(2026, 9, 30, 9) });
  observe(store, { accountKey: 'k', used: 25, now: at(2026, 10, 1, 9) });
  observe(store, { accountKey: 'k', used: 60, now: at(2026, 10, 3, 9) });
  // October 19 is 16 days after October 3: outside the rolling week, inside the month.
  const result = observe(store, { accountKey: 'k', used: 80, now: at(2026, 10, 19, 9) });

  assert.equal(result.todaySpend, 20);
  assert.equal(result.weekSpend, 20);
  assert.equal(result.monthSpend, 15 + 35 + 20);
  assert.equal(result.allTimeSpend, 10 + 15 + 35 + 20);
  // September spend stays out of October's month figure.
  assert.deepEqual(Object.keys(store.peek().accounts.k.dailySpend).sort(),
    ['2026-09-30', '2026-10-01', '2026-10-03', '2026-10-19']);
});

test('recordWorkbuddyUsage: monthSinceTracking clears once tracking predates the month', () => {
  const store = memoryStore();
  observe(store, { accountKey: 'k', used: 5, now: at(2026, 9, 2, 8) });
  const result = observe(store, { accountKey: 'k', used: 9, now: at(2026, 10, 5, 8) });

  assert.equal(result.monthSinceTracking, false);
  assert.equal(result.trackingSince, new Date(at(2026, 9, 2, 8)).toISOString());
  assert.equal(result.monthSpend, 4);
});

test('recordWorkbuddyUsage: prunes buckets past the retention window while all-time keeps accumulating', () => {
  assert.equal(WORKBUDDY_USAGE_RETENTION_MS, 40 * DAY);
  const old = at(2026, 8, 1, 8);
  const store = memoryStore({
    version: 1,
    accounts: {
      k: {
        lastUsed: 10,
        dailySpend: { '2026-08-01': 4, '2026-09-20': 6 },
        allTimeSpend: 10,
        trackingSince: old
      }
    }
  });
  const result = observe(store, { accountKey: 'k', used: 15, now: at(2026, 10, 19, 9) });

  // The August bucket falls outside the 40-day window; September 20 survives it.
  assert.deepEqual(store.peek().accounts.k.dailySpend, { '2026-09-20': 6, '2026-10-19': 5 });
  assert.equal(result.todaySpend, 5);
  assert.equal(result.monthSpend, 5);
  assert.equal(result.allTimeSpend, 15);
  assert.equal(result.trackingSince, new Date(old).toISOString());
});

test('recordWorkbuddyUsage: accounts keep independent ledgers', () => {
  const store = memoryStore();
  const t0 = at(2026, 10, 19, 8);
  const t1 = at(2026, 10, 19, 9);
  observe(store, { accountKey: 'a', used: 100, now: t0 });
  observe(store, { accountKey: 'b', used: 500, now: t0 });
  const first = observe(store, { accountKey: 'a', used: 120, now: t1 });
  const second = observe(store, { accountKey: 'b', used: 500, now: t1 });

  assert.equal(first.todaySpend, 20);
  assert.equal(second.todaySpend, 0);
  assert.equal(store.peek().accounts.a.lastUsed, 120);
  assert.equal(store.peek().accounts.b.lastUsed, 500);
});

test('recordWorkbuddyUsage: unusable observations return null instead of rebasing', () => {
  const store = memoryStore();
  const now = at(2026, 10, 19);
  for (const observation of [
    { accountKey: '', used: 10, now },
    { accountKey: 'k', used: null, now },
    { accountKey: 'k', used: 'many', now },
    { accountKey: 'k', used: 10, storePath: '' },
    { accountKey: 'k', used: 10, now: 'not-a-time' }
  ]) {
    assert.equal(observe(store, observation), null);
  }
  assert.equal(store.writes(), 0);
});

test('recordWorkbuddyUsage: a corrupt store starts a fresh ledger', () => {
  const store = memoryStore({ version: 1, accounts: 'broken' });
  const result = observe(store, { accountKey: 'k', used: 12, now: at(2026, 10, 19, 9) });

  assert.equal(result.todaySpend, 0);
  assert.equal(store.peek().accounts.k.lastUsed, 12);
});

test('recordWorkbuddyUsage: malformed day keys never inflate the period sums', () => {
  const store = memoryStore({
    version: 1,
    accounts: {
      k: {
        lastUsed: 10,
        dailySpend: { '2026-13-99': 999, zzz: 999, '2026-10-19': 5 },
        allTimeSpend: 1004,
        trackingSince: at(2026, 10, 1)
      }
    }
  });
  const result = observe(store, { accountKey: 'k', used: 10, now: at(2026, 10, 19, 9) });

  assert.equal(result.todaySpend, 5);
  assert.equal(result.monthSpend, 5);
  assert.deepEqual(store.peek().accounts.k.dailySpend, { '2026-10-19': 5 });
});

test('recordWorkbuddyUsage: a failed write never rejects a lane whose quota answered', () => {
  const t0 = at(2026, 10, 19, 8);
  // The persisted baseline reads back, but every write throws: the observation
  // must still answer with its spend instead of failing the quota lane.
  const box = {
    value: {
      version: 1,
      accounts: { k: { lastUsed: 100, dailySpend: {}, allTimeSpend: 0, trackingSince: t0 } }
    }
  };
  const io = {
    readJson: () => box.value,
    writeJsonAtomic: () => { throw new Error('read-only file system'); }
  };
  const result = recordWorkbuddyUsage({
    accountKey: 'k', used: 130, now: at(2026, 10, 19, 9), storePath: '/x', ...io
  });

  assert.equal(result.todaySpend, 30);
  assert.equal(result.monthSpend, 30);
});
