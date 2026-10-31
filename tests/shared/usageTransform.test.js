'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  USAGE_TRANSFORM_SETTING_KEYS,
  createUsageTransform,
  usageTransformSettings
} = require('../../src/shared/usage/usageTransform');
const { normalizePeriod, applyProjectRollups } = require('../../src/shared/usage');
const { createDeviceState } = require('../../src/shared/usage/deviceState');
const { applyArchivedClientUsage } = require('../../src/shared/usage/clientUsageArchive');
const { applySessionUsageArchive, captureSessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');

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

test('archive projection leaves collector rows read-only and publication detaches live and retained rows', () => {
  const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const source = freeze(summary());
  const retained = summary(25);
  for (const period of ['today', 'month', 'allTime']) {
    const row = retained[period].sessions['codex:c1'];
    row.sessionId = 'retained';
    retained[period].sessions = { 'codex:retained': row };
  }
  const archive = freeze(captureSessionUsageArchive({}, retained, new Date(AT)));
  const settings = { clients: 'codex', projectsEnabled: true };
  const expected = applyProjectRollups(applySessionUsageArchive(
    applyArchivedClientUsage(source, null, { activeClients: settings.clients, now: new Date(AT) }),
    archive, { canonical: true, canonicalSummary: true, mutate: true, now: new Date(AT) }
  ));
  const transform = createUsageTransform({ getSettings: () => settings });
  const visible = transform.project(source, archive, new Date(AT));
  assert.deepEqual(JSON.parse(JSON.stringify(visible)), JSON.parse(JSON.stringify(expected)));
  assert.equal(visible.allTime.sessions['codex:c1'], source.allTime.sessions['codex:c1']);
  assert.equal(visible.allTime.sessions['codex:retained'].archived, true);
  assert.equal(source.allTime.totalTokens, 100);
  assert.deepEqual(Object.keys(source.allTime.sessions), ['codex:c1']);

  const state = createDeviceState();
  const published = state.updateUsage(visible);
  published.allTime.sessions['codex:c1'].totalTokens = 1;
  published.allTime.sessions['codex:retained'].totalTokens = 2;
  const snapshot = state.getSnapshot();
  assert.equal(snapshot.allTime.sessions['codex:c1'].totalTokens, 100);
  assert.equal(snapshot.allTime.sessions['codex:retained'].totalTokens, 25);
  assert.equal(archive.sessions['codex:retained'].periods.allTime.totalTokens, 25);
});

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
    usageTransformSettings({
      clients: 'codex', projectsEnabled: false, claudeDesktopSplitEnabled: false,
      hubUrl: 'https://hub', secret: 'x'
    }),
    { clients: 'codex', projectsEnabled: false, claudeDesktopSplitEnabled: false }
  );
});
