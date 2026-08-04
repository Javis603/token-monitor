'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CLIENT_HEALTH_OVERALL_STATES,
  CLIENT_HEALTH_VERSION,
  CLIENT_SOURCE_CHECK_IDS,
  MAX_CHECKS_PER_CLIENT,
  MAX_DIAGNOSTICS_PER_CLIENT,
  MAX_TRACKED_CLIENTS,
  countOverall,
  deriveClientOverall,
  deriveLegacyClientStatus,
  normalizeClientHealth
} = require('../../src/shared/clientHealth');
const {
  clientActivityDaysFromHistory,
  clientSourceChecks,
  clientSourceRoots,
  clientWatchCandidates,
  deriveClientHealth
} = require('../../src/shared/collector');
const { KNOWN_CLIENTS } = require('../../src/shared/clientTracking');
const { createSelfSyncThrottle } = require('../../src/shared/selfSyncThrottle');
const { aggregateDevices, normalizeDeviceRecord } = require('../../src/shared/usage');

const core = (overrides = {}) => ({
  source: { state: 'detected', detectedCount: 1, checkedCount: 1 },
  collection: { state: 'direct' },
  data: { liveTokens: 0 },
  ...overrides
});

test('deriveClientOverall reads the fixed core', () => {
  assert.equal(deriveClientOverall(core({ data: { liveTokens: 10 } })), 'healthy');
  assert.equal(deriveClientOverall(core()), 'waiting');
  assert.equal(deriveClientOverall(core({ source: { state: 'missing', detectedCount: 0, checkedCount: 2 } })), 'unavailable');
  assert.equal(deriveClientOverall(core({ source: { state: 'unknown', detectedCount: 0, checkedCount: 0 } })), 'unknown');
  assert.equal(deriveClientOverall({}), 'unknown');
});

// A sync is never attempted for a client whose sources are absent, so reaching
// the failed branch means there is something actionable to say — which is why it
// is checked before the missing-source branch and before any usage.
test('deriveClientOverall lets a failing self-sync outrank usage and a missing source', () => {
  assert.equal(deriveClientOverall(core({ collection: { state: 'failed' }, data: { liveTokens: 900 } })), 'attention');
  assert.equal(deriveClientOverall({
    source: { state: 'missing', detectedCount: 0, checkedCount: 1 },
    collection: { state: 'failed' },
    data: { liveTokens: 0 }
  }), 'attention');
  // But an unreadable source outranks everything: there is nothing to report on.
  assert.equal(deriveClientOverall({
    source: { state: 'unknown', detectedCount: 0, checkedCount: 0 },
    collection: { state: 'failed' },
    data: { liveTokens: 0 }
  }), 'unknown');
});

test('deriveLegacyClientStatus mirrors the three-state view a pre-health consumer expects', () => {
  assert.equal(deriveLegacyClientStatus(core({ data: { liveTokens: 3 } })), 'active');
  assert.equal(deriveLegacyClientStatus(core()), 'waiting');
  assert.equal(deriveLegacyClientStatus(core({ source: { state: 'missing', detectedCount: 0, checkedCount: 1 } })), 'missing');
  // Deliberately NOT derived from `overall`: a client whose sync is failing but
  // whose earlier tokens still count reads `attention` there and `active` here.
  const failing = core({ collection: { state: 'failed' }, data: { liveTokens: 7 } });
  assert.equal(deriveClientOverall(failing), 'attention');
  assert.equal(deriveLegacyClientStatus(failing), 'active');
});

test('normalizeClientHealth downgrades every value it does not recognise', () => {
  const health = normalizeClientHealth({
    version: 99,
    clients: {
      CLAUDE: {
        source: { state: 'brand-new-state', detectedCount: 1, checkedCount: 2, checks: [{ id: 'made-up-root', exists: true }, { id: 'claude-projects', exists: true }] },
        collection: { state: 'quantum', lastAttemptAt: 'not a date', lastSuccessAt: '2026-08-01T10:00:00.000Z' },
        data: { liveTokens: 5, lastActivityDay: '01/08/2026' },
        diagnostics: ['source-missing', 'invented-code'],
        overall: 'healthy'
      }
    }
  });

  const claude = health.clients.claude;
  assert.equal(health.version, CLIENT_HEALTH_VERSION);
  assert.equal(claude.source.state, 'unknown');
  assert.equal(claude.collection.state, 'direct');
  assert.equal(Object.hasOwn(claude.collection, 'lastAttemptAt'), false);
  assert.equal(claude.collection.lastSuccessAt, '2026-08-01T10:00:00.000Z');
  assert.equal(Object.hasOwn(claude.data, 'lastActivityDay'), false);
  assert.deepEqual(claude.source.checks, [{ id: 'claude-projects', exists: true }]);
  assert.deepEqual(claude.diagnostics, ['source-missing']);
  // The producer claimed healthy; an unknown source cannot support that.
  assert.equal(claude.overall, 'unknown');
});

test('normalizeClientHealth recomputes overall instead of trusting the producer', () => {
  const health = normalizeClientHealth({
    clients: {
      codex: { ...core({ source: { state: 'missing', detectedCount: 0, checkedCount: 1 } }), overall: 'healthy' }
    }
  });
  assert.equal(health.clients.codex.overall, 'unavailable');
});

test('normalizeClientHealth rejects documents with nothing usable in them', () => {
  assert.equal(normalizeClientHealth(null), null);
  assert.equal(normalizeClientHealth({}), null);
  assert.equal(normalizeClientHealth({ clients: {} }), null);
  assert.equal(normalizeClientHealth({ clients: { '': core() } }), null);
  assert.equal(normalizeClientHealth({ clients: { codex: 'not an object' } }), null);
});

test('normalizeClientHealth caps every list a hostile ingest could grow', () => {
  const clients = {};
  for (let index = 0; index < MAX_TRACKED_CLIENTS + 20; index += 1) clients[`client-${index}`] = core();
  assert.equal(Object.keys(normalizeClientHealth({ clients }).clients).length, MAX_TRACKED_CLIENTS);

  const checks = CLIENT_SOURCE_CHECK_IDS.map((id) => ({ id, exists: true }));
  assert.ok(checks.length > MAX_CHECKS_PER_CLIENT, 'the allowlist must be able to overflow the per-client cap');
  const capped = normalizeClientHealth({ clients: { codex: { ...core(), source: { state: 'detected', detectedCount: 1, checkedCount: 1, checks } } } });
  assert.equal(capped.clients.codex.source.checks.length, MAX_CHECKS_PER_CLIENT);
  // Counts are bounded too — they are what a renderer draws a ratio from.
  const inflated = normalizeClientHealth({ clients: { codex: { ...core(), source: { state: 'detected', detectedCount: 9e9, checkedCount: 9e9 } } } });
  assert.equal(inflated.clients.codex.source.detectedCount, MAX_CHECKS_PER_CLIENT);

  const diagnostics = ['source-missing', 'source-partial', 'sync-failed', 'sync-timeout', 'sync-exit-error', 'no-usage-observed'];
  assert.ok(diagnostics.length > MAX_DIAGNOSTICS_PER_CLIENT);
  const trimmed = normalizeClientHealth({ clients: { codex: { ...core(), diagnostics } } });
  assert.equal(trimmed.clients.codex.diagnostics.length, MAX_DIAGNOSTICS_PER_CLIENT);
});

test('normalizeClientHealth folds tokscale aliases onto the client id they belong to', () => {
  const { normalizeClientName } = require('../../src/shared/usage');
  const health = normalizeClientHealth({
    clients: { 'antigravity-cli': core({ data: { liveTokens: 4 } }) }
  }, normalizeClientName);
  assert.deepEqual(Object.keys(health.clients), ['antigravity']);
});

test('countOverall tallies by headline state', () => {
  const counts = countOverall({
    clients: {
      a: { overall: 'healthy' },
      b: { overall: 'healthy' },
      c: { overall: 'attention' },
      d: { overall: 'not-a-state' }
    }
  });
  assert.equal(counts.healthy, 2);
  assert.equal(counts.attention, 1);
  assert.equal(counts.unknown, 1);
  assert.deepEqual(Object.keys(counts).sort(), [...CLIENT_HEALTH_OVERALL_STATES].sort());
});

// The producer assigns check ids in collector.js and the hub validates them
// against the allowlist in clientHealth.js. The two lists live in different
// files for a reason (one needs `fs`, the other ships to the Worker), so nothing
// but this test stops a new client's root from being silently dropped on ingest.
test('every source-root id the collector emits is in the allowlist', () => {
  const roots = clientSourceRoots(KNOWN_CLIENTS);
  const emitted = new Set();
  for (const entries of Object.values(roots)) {
    for (const { id, dir } of entries) {
      assert.equal(typeof dir, 'string');
      assert.ok(dir.length > 0, `${id} must resolve to a path`);
      emitted.add(id);
    }
  }
  for (const id of emitted) {
    assert.ok(CLIENT_SOURCE_CHECK_IDS.includes(id), `${id} is missing from CLIENT_SOURCE_CHECK_IDS`);
  }
  // The two antigravity roots that only clientSourceChecks() adds.
  for (const id of ['antigravity-ide-source', 'antigravity-cli-data']) {
    assert.ok(CLIENT_SOURCE_CHECK_IDS.includes(id));
  }
  // And nothing in the allowlist is dead weight. `hermes-profile` is exempt
  // because its roots come from profiles discovered on disk, so a machine with
  // no Hermes profiles legitimately never emits it.
  const discoveryDependent = new Set(['hermes-profile']);
  const checked = new Set([...emitted, 'antigravity-ide-source', 'antigravity-cli-data']);
  for (const id of CLIENT_SOURCE_CHECK_IDS) {
    if (discoveryDependent.has(id)) continue;
    assert.ok(checked.has(id), `${id} is in the allowlist but no client probes it`);
  }
});

test('labelling the roots left the watcher its original path list', () => {
  const roots = clientSourceRoots(KNOWN_CLIENTS);
  const candidates = clientWatchCandidates(KNOWN_CLIENTS);
  assert.deepEqual(Object.keys(candidates).sort(), Object.keys(roots).sort());
  for (const [client, dirs] of Object.entries(candidates)) {
    assert.deepEqual(dirs, roots[client].map((root) => root.dir));
  }
});

// Several paths of the same kind are one check: Copilot's workspaceStorage has a
// variant per platform and only one of them can exist, so reporting four checks
// with three absent would read as breakage on a healthy machine.
test('clientSourceChecks collapses same-kind roots into one entry', () => {
  const checks = clientSourceChecks('copilot,zed,cline,antigravity');
  const ids = (client) => checks[client].map((check) => check.id);
  assert.deepEqual(ids('copilot'), ['copilot-otel', 'vscode-workspace-storage']);
  assert.deepEqual(ids('zed'), ['zed-threads']);
  assert.deepEqual(ids('cline'), ['cline-tasks']);
  // antigravity's watch candidate is only the tokscale cache; its two real
  // sources are separate checks so the record can tell them apart.
  assert.deepEqual(ids('antigravity'), ['tokscale-antigravity-cache', 'antigravity-ide-source', 'antigravity-cli-data']);
  for (const list of Object.values(checks)) {
    for (const check of list) assert.equal(typeof check.exists, 'boolean');
  }
});

// Every `overall` turns on whether a directory exists, so the filesystem is
// stated rather than depended on: a developer machine with Claude installed and
// a CI runner without it must not disagree about the same input.
const SOURCE_CHECKS = {
  claude: [{ id: 'claude-projects', exists: true }, { id: 'claude-transcripts', exists: false }],
  codex: [{ id: 'codex-sessions', exists: true }],
  cursor: [{ id: 'tokscale-cursor-cache', exists: false }],
  antigravity: [
    { id: 'tokscale-antigravity-cache', exists: true },
    { id: 'antigravity-ide-source', exists: true },
    { id: 'antigravity-cli-data', exists: false }
  ]
};

test('deriveClientHealth reports every tracked client within the declared shape', () => {
  const health = deriveClientHealth('claude,codex,cursor,antigravity', { clients: { claude: 1234 } }, { sourceChecks: SOURCE_CHECKS });
  assert.equal(health.version, CLIENT_HEALTH_VERSION);
  assert.deepEqual(Object.keys(health.clients), ['claude', 'codex', 'cursor', 'antigravity']);
  for (const [client, entry] of Object.entries(health.clients)) {
    assert.ok(CLIENT_HEALTH_OVERALL_STATES.includes(entry.overall), `${client} overall`);
    assert.equal(entry.overall, deriveClientOverall(entry), `${client} overall must follow its own core`);
    for (const check of entry.source.checks || []) {
      assert.ok(CLIENT_SOURCE_CHECK_IDS.includes(check.id), `${client} emitted ${check.id}`);
    }
  }
  // Claude's second root is absent, but it has usage — so no detail is attached.
  assert.equal(health.clients.claude.data.liveTokens, 1234);
  assert.equal(health.clients.claude.overall, 'healthy');
  assert.equal(Object.hasOwn(health.clients.claude.source, 'checks'), false);
  assert.equal(Object.hasOwn(health.clients.claude, 'diagnostics'), false);
  // Antigravity has the same partial source and no usage, so it gets both.
  assert.deepEqual(health.clients.antigravity.source.checks, SOURCE_CHECKS.antigravity);
  assert.deepEqual(health.clients.antigravity.diagnostics, ['source-partial', 'no-usage-observed']);
  assert.equal(health.clients.cursor.overall, 'unavailable');
  assert.deepEqual(health.clients.cursor.diagnostics, ['source-missing']);
  // The two self-synced clients report their sync lane; everyone else is direct.
  assert.equal(health.clients.claude.collection.state, 'direct');
  assert.equal(health.clients.codex.collection.state, 'direct');
  assert.ok(['idle', 'pending', 'ok', 'failed'].includes(health.clients.cursor.collection.state));
  assert.equal(deriveClientHealth('', {}), null);
});

// The same shape rules, against whatever this machine actually has. Asserts only
// what holds on any filesystem — the test above pins the values.
test('deriveClientHealth holds its own invariants against a real machine', () => {
  const health = deriveClientHealth(KNOWN_CLIENTS, { clients: {} });
  const checks = clientSourceChecks(KNOWN_CLIENTS);
  for (const [client, entry] of Object.entries(health.clients)) {
    assert.equal(entry.overall, deriveClientOverall(entry), `${client} overall must follow its own core`);
    assert.equal(entry.source.checkedCount, (checks[client] || []).length);
    for (const check of entry.source.checks || []) {
      assert.ok(CLIENT_SOURCE_CHECK_IDS.includes(check.id), `${client} emitted ${check.id}`);
    }
    if (entry.overall === 'healthy') {
      assert.equal(Object.hasOwn(entry, 'diagnostics'), false, `${client} healthy but carries diagnostics`);
      assert.equal(Object.hasOwn(entry.source, 'checks'), false, `${client} healthy but carries checks`);
    }
  }
});

test('deriveClientHealth carries the self-sync lane into the record', () => {
  const clock = { now: 1_700_000_000_000 };
  const throttle = createSelfSyncThrottle({ now: () => clock.now });
  const options = {
    selfSyncThrottle: throttle,
    sourceChecks: { cursor: [{ id: 'tokscale-cursor-cache', exists: true }] }
  };

  assert.equal(deriveClientHealth('cursor', {}, options).clients.cursor.collection.state, 'idle');

  const attempt = throttle.beginAttempt('cursor');
  const pending = deriveClientHealth('cursor', {}, options).clients.cursor;
  assert.equal(pending.collection.state, 'pending');
  assert.equal(pending.collection.lastAttemptAt, new Date(clock.now).toISOString());
  assert.equal(Object.hasOwn(pending.collection, 'lastSuccessAt'), false);

  clock.now += 5000;
  throttle.completeAttempt('cursor', attempt, true, 'sync-timeout');
  const failed = deriveClientHealth('cursor', { clients: { cursor: 500 } }, options).clients.cursor;
  assert.equal(failed.collection.state, 'failed');
  assert.equal(failed.overall, 'attention');
  assert.ok(failed.diagnostics.includes('sync-timeout'));

  clock.now += 5000;
  const second = throttle.beginAttempt('cursor');
  throttle.completeAttempt('cursor', second, false);
  const ok = deriveClientHealth('cursor', { clients: { cursor: 500 } }, options).clients.cursor;
  assert.equal(ok.collection.state, 'ok');
  assert.equal(ok.collection.lastSuccessAt, new Date(clock.now).toISOString());
  assert.equal(ok.overall, 'healthy');
  // A healthy client keeps its sync stamps: "last synced two minutes ago" is the
  // answer to "why is today still 0", not a fault report.
  assert.ok(ok.collection.lastAttemptAt);
});

test('a self-sync failure reports a code and never its stderr', () => {
  const throttle = createSelfSyncThrottle({ now: () => 1 });
  const attempt = throttle.beginAttempt('antigravity');
  throttle.completeAttempt('antigravity', attempt, true, 'ENOENT: /Users/alice/.gemini missing');
  assert.equal(throttle.syncStatus('antigravity').failureCode, 'sync-failed');
  const later = throttle.beginAttempt('antigravity');
  throttle.completeAttempt('antigravity', later, true, 'sync-exit-error');
  assert.equal(throttle.syncStatus('antigravity').failureCode, 'sync-exit-error');
});

// lastSyncAt is the rate-limit anchor that claim() moves; a completion never
// touches it. Reading it as "when did a sync last work" is the mistake the
// separate reporting fields exist to prevent.
test('a throttled sync that never runs leaves the success stamp alone', () => {
  const clock = { now: 1_000_000 };
  const throttle = createSelfSyncThrottle({ now: () => clock.now });
  const attempt = throttle.beginAttempt('cursor');
  throttle.completeAttempt('cursor', attempt, false);
  const successAt = throttle.syncStatus('cursor').lastSuccessAt;

  clock.now += 1000;
  assert.equal(throttle.claim('cursor'), true);
  assert.equal(throttle.syncStatus('cursor').lastSuccessAt, successAt);
  assert.equal(throttle.syncStatus('cursor').state, 'ok');
});

test('clientActivityDaysFromHistory takes the newest day with usage per client', () => {
  const days = clientActivityDaysFromHistory({
    daily: [
      { date: '2026-07-30', perClient: { codex: { tokens: 10 }, claude: { tokens: 4 } } },
      { date: '2026-08-02', perClient: { codex: { tokens: 0 }, 'antigravity-cli': { tokens: 9 } } },
      { date: '2026-08-01', perClient: { codex: { tokens: 7 } } }
    ]
  });
  assert.equal(days.codex, '2026-08-01');
  assert.equal(days.claude, '2026-07-30');
  // Aliases fold onto the umbrella id the health record is keyed on.
  assert.equal(days.antigravity, '2026-08-02');
  assert.deepEqual(clientActivityDaysFromHistory(null), {});
});

test('the hub keeps a valid health record and drops an unusable one', () => {
  const now = new Date().toISOString();
  const base = { deviceId: 'macbook', updatedAt: now, receivedAt: now };
  const kept = normalizeDeviceRecord({
    ...base,
    clientHealth: { clients: { codex: { ...core({ data: { liveTokens: 5 } }), overall: 'unavailable' } } }
  });
  assert.equal(kept.clientHealth.clients.codex.overall, 'healthy');
  assert.equal(Object.hasOwn(normalizeDeviceRecord({ ...base, clientHealth: { clients: {} } }), 'clientHealth'), false);
  assert.equal(Object.hasOwn(normalizeDeviceRecord(base), 'clientHealth'), false);
});

test('aggregateDevices carries health per device and never rolls it up', () => {
  const now = new Date().toISOString();
  const health = { clients: { codex: core({ data: { liveTokens: 5 } }) } };
  const aggregate = aggregateDevices([
    { deviceId: 'macbook', updatedAt: now, receivedAt: now, clientHealth: health },
    { deviceId: 'desktop', updatedAt: now, receivedAt: now }
  ], 600000);

  const byId = Object.fromEntries(aggregate.devices.map((device) => [device.deviceId, device]));
  assert.equal(byId.macbook.clientHealth.clients.codex.overall, 'healthy');
  assert.equal(Object.hasOwn(byId.desktop, 'clientHealth'), false);
  // A top-level rollup is the one shape that would reach /api/public/stats,
  // which drops `devices` and spreads everything else.
  assert.equal(Object.hasOwn(aggregate, 'clientHealth'), false);
});
