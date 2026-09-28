'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  USAGE_TRANSFORM_SETTING_KEYS,
  createUsageTransform,
  usageTransformSettings
} = require('../../src/shared/usage/usageTransform');
const { normalizePeriod } = require('../../src/shared/usage');

const AT = '2026-07-09T08:15:00.000Z';

function summary(sessionTokens = 100) {
  const period = () => normalizePeriod({
    totalTokens: sessionTokens,
    clients: { codex: sessionTokens },
    sessions: {
      'codex:c1': { client: 'codex', sessionId: 'c1', totalTokens: sessionTokens, projectLabel: 'app' }
    }
  });
  return { deviceId: 'mac', updatedAt: AT, today: period(), month: period(), allTime: period() };
}

function fakeStore(overrides = {}) {
  const calls = [];
  const archive = { version: 1, sessions: {} };
  return {
    calls,
    read() { calls.push('read'); return archive; },
    refresh() { calls.push('refresh'); return archive; },
    capture(_summary, now) { calls.push(['capture', now.toISOString()]); return { archive }; },
    ...overrides
  };
}

test('an external agent keeps archive loading read-only', () => {
  const store = fakeStore();
  let snapshots = 0;
  const transform = createUsageTransform({
    store,
    isExternalAgentActive: () => true,
    readSnapshot: () => { snapshots += 1; return { version: 1, sessions: {} }; }
  });

  transform.ensureLoaded();

  assert.equal(snapshots, 1);
  assert.deepEqual(store.calls, []);
});

test('without an external agent the archive loads from the store once', () => {
  const store = fakeStore();
  const transform = createUsageTransform({ store });

  transform.ensureLoaded();
  transform.ensureLoaded();

  assert.deepEqual(store.calls, ['read']);
});

test('a collected summary is captured at its own collection time', () => {
  const store = fakeStore();
  const transform = createUsageTransform({ store, getSettings: () => ({}) });

  const visible = transform.transform(summary());

  assert.deepEqual(store.calls, [['capture', AT]]);
  assert.equal(visible.allTime.sessions['codex:c1'].totalTokens, 100);
  assert.equal(transform.getState().lastUpdate.failureCode, null);
});

test('an external agent owns capture, so the transform only refreshes', () => {
  const store = fakeStore();
  const transform = createUsageTransform({ store, getSettings: () => ({}), isExternalAgentActive: () => true });

  transform.transform(summary());

  assert.deepEqual(store.calls, ['refresh']);
});

test('a disabled session archive is neither captured nor read', () => {
  const store = fakeStore();
  const transform = createUsageTransform({ store, getSettings: () => ({ sessionUsageArchiveEnabled: false }) });

  transform.transform(summary());

  assert.deepEqual(store.calls, []);
});

test('a failed capture is reported and falls back to the loaded archive', () => {
  const failures = [];
  const logs = [];
  const store = fakeStore({
    capture() { throw new Error('disk full'); }
  });
  const transform = createUsageTransform({
    store,
    getSettings: () => ({}),
    onCaptureFailure: (error) => failures.push(error.message),
    log: (message) => logs.push(message)
  });

  const visible = transform.transform(summary());

  assert.deepEqual(failures, ['disk full']);
  assert.deepEqual(logs, ['[session-archive] write failed: disk full']);
  assert.equal(transform.getState().lastUpdate.failureCode, 'archive-write-failed');
  assert.deepEqual(store.calls, ['read']);
  assert.equal(visible.allTime.sessions['codex:c1'].totalTokens, 100);
});

test('settings are read when a summary is transformed, not when the transform is created', () => {
  const store = fakeStore();
  let settings = { sessionUsageArchiveEnabled: false };
  const transform = createUsageTransform({ store, getSettings: () => settings });

  const before = transform.transform(summary());
  settings = {
    archivedClientUsage: {
      version: 1,
      clients: {
        claude: {
          capturedAt: AT,
          day: '2026-07-09',
          month: '2026-07',
          periods: { allTime: { totalTokens: 40, clients: { claude: 40 } } }
        }
      }
    },
    clients: 'codex'
  };
  const after = transform.transform(summary());

  assert.equal(before.allTime.clients.claude, undefined);
  assert.equal(after.allTime.clients.claude, 40);
  assert.deepEqual(store.calls, [['capture', AT]]);
});

test('forget and reset decide what the next use sees', () => {
  const store = fakeStore();
  const transform = createUsageTransform({ store });

  assert.deepEqual(transform.getState(), {
    loaded: false,
    sessionCount: null,
    lastUpdate: { at: null, durationMs: null, failureCode: null }
  });
  transform.reset();
  assert.equal(transform.getState().loaded, true);
  assert.equal(transform.getState().sessionCount, 0);
  transform.forget();
  assert.equal(transform.getState().loaded, false);
  transform.ensureLoaded();
  assert.deepEqual(store.calls, ['read']);
});

test('the transform reads no setting outside the ones a worker is handed', () => {
  const read = new Set();
  const settings = new Proxy({ projectsEnabled: true }, {
    get(target, key) {
      if (typeof key === 'string') read.add(key);
      return target[key];
    }
  });
  const transform = createUsageTransform({ store: fakeStore(), getSettings: () => settings });

  transform.transform(summary());
  transform.project(summary(), null, new Date(AT));

  assert.deepEqual([...read].filter((key) => !USAGE_TRANSFORM_SETTING_KEYS.includes(key)), []);
  assert.deepEqual(
    usageTransformSettings({ clients: 'codex', projectsEnabled: false, hubUrl: 'https://hub', secret: 'x' }),
    { clients: 'codex', projectsEnabled: false }
  );
});

test('project raises allTime to the daily-history floor for a rotated source (#808)', () => {
  const period = (tokens) => normalizePeriod({ totalTokens: tokens, clients: { codex: tokens } });
  const enabled = createUsageTransform({
    store: fakeStore(),
    getSettings: () => ({}),
    loadDailyHistoryFloor: () => ({ codex: { totalTokens: 900, costUsd: 0, models: { 'gpt-5.5': 900 }, modelCosts: {} } })
  });
  const lifted = enabled.project(
    { deviceId: 'mac', updatedAt: AT, today: period(5), month: period(20), allTime: period(20) },
    { version: 1, sessions: {} },
    new Date(AT)
  );
  assert.equal(lifted.allTime.totalTokens, 900, 'allTime lifted to the archive cumulative');
  assert.equal(lifted.today.totalTokens, 5, 'today untouched');
  assert.equal(lifted.month.totalTokens, 20, 'month untouched');
});

test('project does not consult the floor when the archive is disabled', () => {
  const period = (tokens) => normalizePeriod({ totalTokens: tokens, clients: { codex: tokens } });
  const rotated = { deviceId: 'mac', updatedAt: AT, today: period(5), month: period(20), allTime: period(20) };
  let loads = 0;
  const transform = createUsageTransform({
    store: fakeStore(),
    getSettings: () => ({ sessionUsageArchiveEnabled: false }),
    loadDailyHistoryFloor: () => { loads += 1; return { codex: { totalTokens: 900, costUsd: 0, models: {}, modelCosts: {} } }; }
  });
  const projected = transform.project(rotated, null, new Date(AT));
  assert.equal(loads, 0, 'the floor loader is never called on the disabled path');
  assert.equal(projected.allTime.totalTokens, 20, 'allTime unchanged');
});

test('a transform built without dailyHistoryArchive never reads the floor from disk', () => {
  const period = (tokens) => normalizePeriod({ totalTokens: tokens, clients: { codex: tokens } });
  const summaryRecord = { deviceId: 'mac', updatedAt: AT, today: period(5), month: period(5), allTime: period(5) };
  const transform = createUsageTransform({ store: fakeStore() });
  const projected = transform.project(summaryRecord, { version: 1, sessions: {} }, new Date(AT));
  assert.equal(projected.allTime.totalTokens, 5, 'no floor applied without opt-in');
});
