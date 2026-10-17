'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  USAGE_TRANSFORM_SETTING_KEYS,
  createUsageTransform,
  usageTransformSettings
} = require('../../src/shared/usage/usageTransform');
const { normalizePeriod } = require('../../src/shared/usage');
const { captureDailyHistoryArchive, captureLiveDailyHistory } = require('../../src/shared/dailyHistoryArchive');

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

test('release forgets both owners and a failed fallback cannot publish even if the archive later reads', () => {
  let archive = { version: 1, sessions: {} };
  let releases = 0;
  let reads = 0;
  const transform = createUsageTransform({
    store: fakeStore({
      read() { reads += 1; return archive; },
      release() { releases += 1; archive = { version: 1, sessions: {} }; },
      capture() { throw new Error('capture unavailable'); }
    }),
    log: () => {}
  });
  const prime = transform.ensureLoaded();
  transform.release();
  assert.equal(releases, 1);
  assert.equal(transform.getState().loaded, false);
  assert.throws(() => transform.transform(summary()), /capture unavailable/);
  assert.equal(reads, 1, 'a failed capture cannot be replaced by a best-effort read');
  assert.equal(transform.getState().loaded, false);
  assert.notEqual(transform.ensureLoaded(), prime);
  assert.equal(reads, 2);
  assert.equal(transform.getState().loaded, true);
  assert.notEqual(transform.ensureLoaded(), prime);
});

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

test('a failed capture is reported and rejects publication despite a loaded archive', () => {
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

  transform.ensureLoaded();
  assert.throws(() => transform.transform(summary()), /disk full/);

  assert.deepEqual(failures, ['disk full']);
  assert.deepEqual(logs, ['[session-archive] write failed: disk full']);
  assert.equal(transform.getState().lastUpdate.failureCode, 'archive-write-failed');
  assert.deepEqual(store.calls, ['read']);
  assert.equal(transform.getState().loaded, true, 'loaded alone is not proof of completeness');
});

test('failed initial reads are not cached as empty and successful reads can recover', () => {
  let fail = true;
  const transform = createUsageTransform({
    store: fakeStore({ read() { if (fail) throw new Error('temporary EIO'); return { version: 1, sessions: {} }; } }),
    log: () => {}
  });
  assert.throws(() => transform.ensureLoaded(), /temporary EIO/);
  assert.equal(transform.getState().loaded, false);
  fail = false;
  assert.deepEqual(transform.ensureLoaded(), { version: 1, sessions: {} });
});

test('external-agent reads and refresh require strict snapshots and propagate failures', () => {
  let fail = false;
  const transform = createUsageTransform({
    store: fakeStore({ refresh(_now, options) {
      assert.equal(options.strict, true);
      if (fail) throw new Error('incomplete refresh');
      return { version: 1, sessions: {} };
    } }),
    isExternalAgentActive: () => true,
    readSnapshot(options) { assert.equal(options.strict, true); throw new Error('failed snapshot'); },
    log: () => {}
  });
  assert.throws(() => transform.ensureLoaded(), /failed snapshot/);
  transform.transform(summary());
  fail = true;
  assert.throws(() => transform.transform(summary()), /incomplete refresh/);
  assert.equal(transform.getState().loaded, true);
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

test('project preserves an observed model instead of topping up an ambiguous partial gap', () => {
  const period = (tokens) => normalizePeriod({ totalTokens: tokens, clients: { claude: tokens } });
  // A lower reading for an already observed model may be a correction.
  const allTime = normalizePeriod({
    totalTokens: 20,
    clients: { claude: 20 },
    models: { 'gpt-5.5': 20 },
    clientModels: { claude: { 'gpt-5.5': 20 } }
  });
  const enabled = createUsageTransform({
    store: fakeStore(),
    getSettings: () => ({}),
    loadDailyHistoryFloor: () => ({ claude: { totalTokens: 900, costUsd: 0, models: { 'gpt-5.5': 900 }, modelCosts: {} } })
  });
  const lifted = enabled.project(
    { deviceId: 'mac', updatedAt: AT, today: period(5), month: period(20), allTime },
    { version: 1, sessions: {} },
    new Date(AT)
  );
  assert.equal(lifted.allTime.totalTokens, 20, 'an observed model stays authoritative');
  assert.equal(lifted.today.totalTokens, 5, 'today untouched');
  assert.equal(lifted.month.totalTokens, 20, 'month untouched');
});

test('project does not consult the floor when the archive is disabled', () => {
  const period = (tokens) => normalizePeriod({ totalTokens: tokens, clients: { claude: tokens } });
  const rotated = { deviceId: 'mac', updatedAt: AT, today: period(5), month: period(20), allTime: period(20) };
  let loads = 0;
  const transform = createUsageTransform({
    store: fakeStore(),
    getSettings: () => ({ sessionUsageArchiveEnabled: false }),
    loadDailyHistoryFloor: () => { loads += 1; return { claude: { totalTokens: 900, costUsd: 0, models: {}, modelCosts: {} } }; }
  });
  const projected = transform.project(rotated, null, new Date(AT));
  assert.equal(loads, 0, 'the floor loader is never called on the disabled path');
  assert.equal(projected.allTime.totalTokens, 20, 'allTime unchanged');
});

test('a transform built without dailyHistoryArchive never reads the floor from disk', () => {
  const period = (tokens) => normalizePeriod({ totalTokens: tokens, clients: { claude: tokens } });
  const summaryRecord = { deviceId: 'mac', updatedAt: AT, today: period(5), month: period(5), allTime: period(5) };
  const transform = createUsageTransform({ store: fakeStore() });
  const projected = transform.project(summaryRecord, { version: 1, sessions: {} }, new Date(AT));
  assert.equal(projected.allTime.totalTokens, 5, 'no floor applied without opt-in');
});

test('a failed archive read is not cached, so the next tick retries at the same mtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-floor-'));
  const archivePath = path.join(dir, 'daily-history-archive.json');
  fs.writeFileSync(archivePath, JSON.stringify({ version: 1, days: {} }));
  try {
    const period = (tokens) => normalizePeriod({
      totalTokens: tokens,
      clients: { claude: tokens },
      models: { 'gpt-5.5': tokens },
      clientModels: { claude: { 'gpt-5.5': tokens } }
    });
    const record = () => ({ deviceId: 'mac', updatedAt: AT, today: period(5), month: period(5), allTime: period(5) });
    let calls = 0;
    const transform = createUsageTransform({
      store: fakeStore(),
      getSettings: () => ({}),
      dailyHistoryArchive: { path: archivePath },
      // Throw on the first read, then serve a real floor — the file mtime never
      // changes, so a cached empty floor would pin allTime low forever.
      readDailyHistoryArchive: () => {
        calls += 1;
        if (calls === 1) throw new Error('transient read failure');
        return { version: 1, days: { '2026-07-01': { date: '2026-07-01', observations: [
          { client: 'claude', modelId: 'retired-model', tokens: 900, cost: 0, messages: 1 }
        ] } } };
      }
    });

    assert.equal(transform.project(record(), { version: 1, sessions: {} }, new Date(AT)).allTime.totalTokens, 5,
      'read failure applies no floor this tick');
    assert.equal(transform.project(record(), { version: 1, sessions: {} }, new Date(AT)).allTime.totalTokens, 905,
      'next tick retries and applies the floor');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const cost of [1.2, 0]) {
  test(`the disk-backed floor refreshes to a larger repriced snapshot costing ${cost}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-floor-reprice-'));
    const archivePath = path.join(dir, 'daily-history-archive.json');
    const date = '2026-07-09';
    const period = (tokens, amount) => normalizePeriod({
      totalTokens: tokens, costUsd: amount,
      clients: { claude: tokens }, clientCosts: { claude: amount },
      models: { gpt: tokens }, modelCosts: { gpt: amount },
      clientModels: { claude: { gpt: tokens } }, clientModelCosts: { claude: { gpt: amount } }
    });
    const record = (allTime) => ({ updatedAt: AT, today: period(0, 0), month: period(0, 0), allTime });
    try {
      let archive = captureLiveDailyHistory({}, period(100, 10), { todayKey: date, pricingRevision: 'old' });
      fs.writeFileSync(archivePath, JSON.stringify(archive));
      fs.utimesSync(archivePath, 1000, 1000);
      const transform = createUsageTransform({
        store: fakeStore(), getSettings: () => ({ projectsEnabled: false }),
        dailyHistoryArchive: { path: archivePath }
      });
      const emptySessions = { version: 1, sessions: {} };
      assert.equal(transform.project(record(normalizePeriod({})), emptySessions, new Date(AT)).allTime.costUsd, 10);
      archive = captureDailyHistoryArchive(archive, { contributions: [{ date, clients: [{
        client: 'claude', modelId: 'gpt', tokens: { input: 120, output: 0, cacheRead: 0, cacheWrite: 0 }, cost
      }] }] }, { todayKey: date, pricingRevision: 'new', reprice: true });
      fs.writeFileSync(archivePath, JSON.stringify(archive));
      fs.utimesSync(archivePath, 2000, 2000);
      const present = transform.project(record(period(120, cost)), emptySessions, new Date(AT));
      assert.equal(present.allTime.totalTokens, 120);
      assert.equal(present.allTime.costUsd, cost);
      const removed = transform.project(record(normalizePeriod({})), emptySessions, new Date(AT));
      assert.equal(removed.allTime.totalTokens, 120);
      assert.equal(removed.allTime.costUsd, cost);
      assert.equal(removed.today.totalTokens, 0);
      assert.equal(removed.month.totalTokens, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
