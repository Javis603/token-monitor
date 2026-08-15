'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

const {
  CLIENT_SYNC_DETAIL_CODES,
  CLIENT_HEALTH_OVERALL_STATES,
  CLIENT_HEALTH_VERSION,
  CLIENT_SOURCE_CHECK_IDS,
  MAX_SYNC_DETAIL_INPUT_LENGTH,
  MAX_CHECKS_PER_CLIENT,
  MAX_DIAGNOSTICS_PER_CLIENT,
  MAX_TRACKED_CLIENTS,
  countOverall,
  deriveClientOverall,
  deriveLegacyClientStatus,
  classifyClientSyncDetailCode,
  normalizeClientHealth
} = require('../../src/shared/clientHealth');
const {
  clientActivityDaysFromHistory,
  clientDiagnosticRoots,
  clientSourceChecks,
  clientSourceRoots,
  clientWatchCandidates,
  deriveClientHealth,
  deriveClientStatus,
  mergeClientActivityDays
} = require('../../src/shared/collector');
const { KNOWN_CLIENTS } = require('../../src/shared/clientTracking');
const { createSelfSyncThrottle } = require('../../src/shared/selfSyncThrottle');
const { applySessionUsageArchive } = require('../../src/shared/sessionUsageArchive');
const { aggregateDevices, mergeDeviceRecord, normalizeDeviceRecord } = require('../../src/shared/usage');

installSourceEnvGuard(test);

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
        diagnostics: [{ code: 'source-missing' }, { code: 'invented-code' }],
        overall: 'healthy'
      }
    }
  });

  const claude = health.clients.claude;
  assert.equal(health.version, CLIENT_HEALTH_VERSION);
  // The counts decide the source state, so the invented one is simply not read.
  assert.equal(claude.source.state, 'detected');
  assert.equal(claude.collection.state, 'unknown');
  assert.equal(Object.hasOwn(claude.collection, 'lastAttemptAt'), false);
  assert.equal(claude.collection.lastSuccessAt, '2026-08-01T10:00:00.000Z');
  assert.equal(Object.hasOwn(claude.data, 'lastActivityDay'), false);
  // One check was dropped by the allowlist, so the array no longer describes the
  // counts the hub recomputes `overall` from — the whole array goes rather than
  // leaving a renderer holding two numbers that disagree.
  assert.equal(Object.hasOwn(claude.source, 'checks'), false);
  // `source-missing` contradicts a detected source and goes with the made-up code.
  assert.equal(Object.hasOwn(claude, 'diagnostics'), false);
  // The producer claimed healthy on a collection state this build cannot read.
  assert.equal(claude.overall, 'unknown');
});

// `direct` is a positive claim — "there is no fetch step here to fail". A future
// producer's `blocked` collapsed onto it would tell an older hub that a client
// whose sync is wedged is fine, and any earlier tokens would carry it to
// `healthy`.
test('an unrecognised collection state never resolves to a working one', () => {
  const health = normalizeClientHealth({
    clients: {
      cursor: { ...core({ collection: { state: 'blocked' }, data: { liveTokens: 900_000 } }), overall: 'healthy' }
    }
  });
  assert.equal(health.clients.cursor.collection.state, 'unknown');
  assert.equal(health.clients.cursor.overall, 'unknown');
});

test('normalizeClientHealth canonicalizes a record instead of clamping it field by field', () => {
  // Counts that contradict each other, and a source state that contradicts both.
  const clamped = normalizeClientHealth({
    clients: { codex: { ...core({ source: { state: 'missing', detectedCount: 9, checkedCount: 1 } }) } }
  });
  assert.equal(clamped.clients.codex.source.detectedCount, 1);
  assert.equal(clamped.clients.codex.source.checkedCount, 1);
  assert.equal(clamped.clients.codex.source.state, 'detected');

  // Nothing probed at all is `unknown`, not `missing`.
  const nothing = normalizeClientHealth({
    clients: { codex: { ...core({ source: { state: 'detected', detectedCount: 0, checkedCount: 0 } }) } }
  });
  assert.equal(nothing.clients.codex.source.state, 'unknown');
  assert.equal(nothing.clients.codex.overall, 'unknown');

  // A calendar that has no such day.
  const dated = normalizeClientHealth({
    clients: { codex: { ...core({ data: { liveTokens: 1, lastActivityDay: '2026-99-99' } }) } }
  });
  assert.equal(Object.hasOwn(dated.clients.codex.data, 'lastActivityDay'), false);
  const real = normalizeClientHealth({
    clients: { codex: { ...core({ data: { liveTokens: 1, lastActivityDay: '2026-02-29' } }) } }
  });
  assert.equal(Object.hasOwn(real.clients.codex.data, 'lastActivityDay'), false, '2026 is not a leap year');
  const valid = normalizeClientHealth({
    clients: { codex: { ...core({ data: { liveTokens: 1, lastActivityDay: '2026-08-04' } }) } }
  });
  assert.equal(valid.clients.codex.data.lastActivityDay, '2026-08-04');
});

// The counts are the core; `checks` is evidence for them. Evidence that
// contradicts the thing it supports is worse than none, because a renderer has
// no way to tell which half to believe.
test('normalizeClientHealth keeps source checks only while they match the counts', () => {
  const withChecks = (source) => normalizeClientHealth({ clients: { antigravity: { ...core(), source } } }).clients.antigravity.source;

  const agreeing = withChecks({
    state: 'detected',
    detectedCount: 1,
    checkedCount: 2,
    checks: [{ id: 'antigravity-cli-data', exists: true }, { id: 'antigravity-ide-source', exists: false }]
  });
  assert.equal(agreeing.checks.length, 2);

  // Same array, but the counts claim two roots were found.
  const disagreeing = withChecks({
    state: 'detected',
    detectedCount: 2,
    checkedCount: 2,
    checks: [{ id: 'antigravity-cli-data', exists: true }, { id: 'antigravity-ide-source', exists: false }]
  });
  assert.equal(Object.hasOwn(disagreeing, 'checks'), false);
  assert.equal(disagreeing.detectedCount, 2, 'the core survives; the evidence is what goes');
});

// Health can be carried across a limits-only ingest, which moves `updatedAt`
// without re-observing anything — so the record has to carry its own age.
test('clientHealth stamps one observation time for the whole record', () => {
  const observedAt = '2026-08-04T13:43:02.000Z';
  const health = normalizeClientHealth({ observedAt, clients: { codex: core() } });
  assert.equal(health.observedAt, observedAt);
  assert.equal(Object.hasOwn(normalizeClientHealth({ observedAt: 'yesterday', clients: { codex: core() } }), 'observedAt'), false);
  // The producer stamps it from the scan it belongs to.
  const produced = deriveClientHealth('codex', { clients: {} }, {
    sourceChecks: { codex: [{ id: 'codex-sessions', exists: true }] },
    observedAt: new Date(observedAt)
  });
  assert.equal(produced.observedAt, observedAt);
});

test('normalizeClientHealth refuses shapes that would be stored as clients', () => {
  // An array passes `typeof === 'object'`; its indices would become client ids.
  assert.equal(normalizeClientHealth({ clients: [core()] }), null);
  assert.equal(normalizeClientHealth([{ clients: { codex: core() } }]), null);
  assert.equal(normalizeClientHealth({ clients: { codex: [core()] } }), null);
  // A `__proto__` key would reassign the map's prototype rather than add an
  // entry, leaving a record that is retained and empty.
  const polluted = normalizeClientHealth({ clients: JSON.parse('{"__proto__": {"source": {"state": "detected", "detectedCount": 1, "checkedCount": 1}}}') });
  assert.equal(polluted, null);
  assert.equal({}.source, undefined, 'Object.prototype must be untouched');
  // One key just under the ingest body limit still reaches storage without a cap.
  assert.equal(normalizeClientHealth({ clients: { ['x'.repeat(500)]: core() } }), null);
});

// A diagnostic the rest of the entry does not support is dropped: the hub stores
// a record that is internally consistent, not one that merely passes per-field
// range checks.
test('normalizeClientHealth drops diagnostics its own record contradicts', () => {
  const health = normalizeClientHealth({
    clients: {
      codex: {
        ...core({ data: { liveTokens: 4000 } }),
        diagnostics: [{ code: 'sync-timeout' }, { code: 'source-missing' }, { code: 'no-usage-observed' }]
      }
    }
  });
  assert.equal(Object.hasOwn(health.clients.codex, 'diagnostics'), false);
  assert.equal(health.clients.codex.overall, 'healthy');

  const failing = normalizeClientHealth({
    clients: { cursor: { ...core({ collection: { state: 'failed' } }), diagnostics: [{ code: 'sync-timeout' }] } }
  });
  assert.deepEqual(failing.clients.cursor.diagnostics, [{ code: 'sync-timeout' }]);
  assert.equal(failing.clients.cursor.overall, 'attention');
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
  const capped = normalizeClientHealth({
    clients: { codex: { ...core(), source: { state: 'detected', detectedCount: MAX_CHECKS_PER_CLIENT, checkedCount: MAX_CHECKS_PER_CLIENT, checks } } }
  });
  assert.equal(capped.clients.codex.source.checks.length, MAX_CHECKS_PER_CLIENT);
  // Counts are bounded too — they are what a renderer draws a ratio from.
  const inflated = normalizeClientHealth({ clients: { codex: { ...core(), source: { state: 'detected', detectedCount: 9e9, checkedCount: 9e9 } } } });
  assert.equal(inflated.clients.codex.source.detectedCount, MAX_CHECKS_PER_CLIENT);

  // All five agree with a failed collection, so the cap is what trims them.
  const diagnostics = ['sync-failed', 'sync-timeout', 'sync-spawn-failed', 'sync-exit-error', 'no-usage-observed'].map((code) => ({ code }));
  assert.ok(diagnostics.length > MAX_DIAGNOSTICS_PER_CLIENT);
  const trimmed = normalizeClientHealth({
    clients: { cursor: { ...core({ collection: { state: 'failed' } }), diagnostics } }
  });
  assert.equal(trimmed.clients.cursor.diagnostics.length, MAX_DIAGNOSTICS_PER_CLIENT);
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
  // And nothing in the allowlist is dead weight. Two ids are exempt because they
  // are discovered rather than constructed: `hermes-profile` comes from profiles
  // found on disk, and `wsl-home` only appears on Windows with a running distro.
  const discoveryDependent = new Set(['copilot-otel-exporter', 'hermes-profile', 'wsl-home']);
  const checked = new Set([...emitted, 'antigravity-ide-source', 'antigravity-cli-data']);
  for (const id of CLIENT_SOURCE_CHECK_IDS) {
    if (discoveryDependent.has(id)) continue;
    assert.ok(checked.has(id), `${id} is in the allowlist but no client probes it`);
  }
});

test('labelling roots keeps diagnostics separate from watcher roots', () => {
  const roots = clientSourceRoots(KNOWN_CLIENTS);
  const candidates = clientWatchCandidates(KNOWN_CLIENTS);
  assert.deepEqual(Object.keys(candidates).sort(), Object.keys(roots).sort());
  for (const [client, dirs] of Object.entries(candidates)) {
    const expected = roots[client]
      .filter((root) => (
        !(client === 'copilot' && root.id === 'copilot-otel')
        && root.id !== 'kiro-ide-globalstorage'
      ))
      .map((root) => root.dir);
    assert.deepEqual(dirs, expected);
  }
});

// Several paths of the same kind are one check: Copilot's workspaceStorage has a
// variant per platform and only one of them can exist, so reporting four checks
// with three absent would read as breakage on a healthy machine.
test('clientSourceChecks collapses same-kind roots into one entry', () => {
  const checks = clientSourceChecks('copilot,zed,cline,antigravity');
  const ids = (client) => checks[client].map((check) => check.id);
  assert.deepEqual(ids('copilot'), ['copilot-otel', 'copilot-data', 'vscode-workspace-storage']);
  assert.deepEqual(ids('zed'), ['zed-threads']);
  assert.deepEqual(ids('cline'), ['cline-tasks', 'cline-cli-sessions']);
  // antigravity's watch candidate is only the tokscale cache; its two real
  // sources are separate checks so the record can tell them apart.
  assert.deepEqual(ids('antigravity'), ['tokscale-antigravity-cache', 'antigravity-ide-source', 'antigravity-cli-data']);
  for (const list of Object.values(checks)) {
    for (const check of list) assert.equal(typeof check.exists, 'boolean');
  }
});

test('Qoder CN source health requires local.db, not only its watch parent', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-qodercn-health-'));
  const dbPath = path.join(tempRoot, 'cache', 'db', 'local.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const previous = process.env.TOKEN_MONITOR_QODER_CN_DB_PATH;
  process.env.TOKEN_MONITOR_QODER_CN_DB_PATH = dbPath;
  try {
    const roots = clientSourceRoots('qodercn').qodercn;
    assert.equal(roots[0].dir, path.dirname(dbPath));
    assert.equal(roots[0].sourcePath, dbPath);
    assert.deepEqual(clientSourceChecks('qodercn').qodercn, [{ id: 'qodercn-db', exists: false }]);
  } finally {
    if (previous === undefined) delete process.env.TOKEN_MONITOR_QODER_CN_DB_PATH;
    else process.env.TOKEN_MONITOR_QODER_CN_DB_PATH = previous;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('diagnostic roots expose antigravity native sources without treating them as watch roots', () => {
  const diagnostics = clientDiagnosticRoots('antigravity').antigravity;
  assert.deepEqual(diagnostics.map(({ id }) => id), [
    'antigravity-ide-source',
    'antigravity-ide-source',
    'antigravity-ide-source',
    'antigravity-cli-data',
    'tokscale-antigravity-cache'
  ]);
  assert.deepEqual(
    diagnostics.slice(0, 3).map(({ dir }) => dir.split(/[\\/]/).at(-1)),
    ['antigravity', 'antigravity-ide', 'antigravity-backup']
  );
  assert.equal(diagnostics[3].dir.split(/[\\/]/).at(-1), 'conversations');
  for (const root of diagnostics) {
    assert.equal(typeof root.dir, 'string');
    assert.equal(typeof root.exists, 'boolean');
  }
  assert.deepEqual(
    clientWatchCandidates('antigravity').antigravity,
    clientSourceRoots('antigravity').antigravity.map(({ dir }) => dir),
    'the native source roots add diagnostics, not duplicate watches'
  );
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
  // Antigravity has the same partial source and no usage. Its roots are
  // alternatives rather than dependencies, so a missing one is evidence in
  // `checks`, never a fault of its own.
  assert.deepEqual(health.clients.antigravity.source.checks, SOURCE_CHECKS.antigravity);
  assert.deepEqual(health.clients.antigravity.diagnostics, [{ code: 'no-usage-observed' }]);
  assert.equal(health.clients.cursor.overall, 'unavailable');
  assert.deepEqual(health.clients.cursor.diagnostics, [{ code: 'source-missing' }]);
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
  assert.equal(failed.collection.syncFailureStage, 'timeout');
  assert.equal(failed.collection.syncDetailCode, 'unknown');
  assert.equal(Object.hasOwn(failed.collection, 'syncExitCode'), false);
  assert.equal(failed.overall, 'attention');
  assert.deepEqual(failed.diagnostics, [{ code: 'sync-timeout' }]);

  clock.now += 5000;
  const second = throttle.beginAttempt('cursor');
  throttle.completeAttempt('cursor', second, false);
  const ok = deriveClientHealth('cursor', { clients: { cursor: 500 } }, options).clients.cursor;
  assert.equal(ok.collection.state, 'ok');
  assert.equal(ok.collection.lastSuccessAt, new Date(clock.now).toISOString());
  assert.equal(Object.hasOwn(ok.collection, 'syncFailureStage'), false);
  assert.equal(Object.hasOwn(ok.collection, 'syncDetailCode'), false);
  assert.equal(Object.hasOwn(ok.collection, 'syncExitCode'), false);
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

test('client health preserves safe process-exit evidence and drops unsafe metadata', () => {
  const valid = normalizeClientHealth({
    clients: {
      antigravity: {
        ...core({
          collection: {
            state: 'failed',
            syncFailureStage: 'process-exit',
            syncDetailCode: 'rpc-failed',
            syncExitCode: 17
          }
        }),
        diagnostics: [{ code: 'sync-exit-error' }]
      }
    }
  });
  assert.equal(valid.clients.antigravity.collection.syncFailureStage, 'process-exit');
  assert.equal(valid.clients.antigravity.collection.syncDetailCode, 'rpc-failed');
  assert.equal(valid.clients.antigravity.collection.syncExitCode, 17);

  const unsafe = normalizeClientHealth({
    clients: {
      antigravity: {
        ...core({
          collection: {
            state: 'failed',
            syncFailureStage: '/Users/alice/private',
            syncDetailCode: '/Users/alice/private',
            syncExitCode: '17; rm -rf'
          }
        }),
        diagnostics: [{ code: 'sync-exit-error' }]
      }
    }
  });
  assert.equal(unsafe.clients.antigravity.collection.syncFailureStage, 'unknown');
  assert.equal(unsafe.clients.antigravity.collection.syncDetailCode, 'unknown');
  assert.equal(Object.hasOwn(unsafe.clients.antigravity.collection, 'syncExitCode'), false);
});

test('sync detail classification is conservative and emits only closed codes', () => {
  assert.deepEqual([...CLIENT_SYNC_DETAIL_CODES].sort(), [
    'authentication-failed',
    'cache-write-failed',
    'invalid-response',
    'language-server-not-found',
    'network-failed',
    'network-timeout',
    'permission-denied',
    'rpc-failed',
    'unknown'
  ].sort());
  assert.equal(
    classifyClientSyncDetailCode({
      client: 'antigravity',
      text: 'Failed to connect to Antigravity RPC on port 12345'
    }),
    'rpc-failed'
  );
  assert.equal(
    classifyClientSyncDetailCode({
      client: 'antigravity',
      text: 'Windows process discovery returned no data; cannot discover Antigravity language servers'
    }),
    'language-server-not-found'
  );
  assert.equal(classifyClientSyncDetailCode({ client: 'cursor', text: 'Cursor API returned status 401' }), 'authentication-failed');
  assert.equal(classifyClientSyncDetailCode({ client: 'cursor', text: 'Invalid response from Cursor API - expected CSV format' }), 'invalid-response');
  assert.equal(classifyClientSyncDetailCode({ client: 'cursor', text: 'Failed to persist file: Permission denied /Users/alice' }), 'permission-denied');
  assert.equal(classifyClientSyncDetailCode({ client: 'cursor', text: 'spawn EPERM' }), 'permission-denied');
  assert.equal(classifyClientSyncDetailCode({ client: 'cursor', text: 'Failed to write to cache manifest' }), 'cache-write-failed');
  assert.equal(classifyClientSyncDetailCode({ client: 'cursor', text: 'Connection refused by Cursor API' }), 'network-failed');
  assert.equal(classifyClientSyncDetailCode({ client: 'cursor', text: 'The request timed out' }), 'network-timeout');
  assert.equal(classifyClientSyncDetailCode({ client: 'cursor', text: 'HTTPS request timed out' }), 'network-timeout');
  assert.equal(classifyClientSyncDetailCode({ client: 'cursor', text: 'tokscale cursor sync timed out after 30000ms' }), null);
  assert.equal(classifyClientSyncDetailCode({ client: 'cursor', text: 'ETIMEDOUT while connecting to Cursor API' }), 'network-timeout');
  assert.equal(classifyClientSyncDetailCode({ client: 'cursor', text: 'new upstream wording with no known meaning' }), null);
  assert.equal(
    classifyClientSyncDetailCode({
      client: 'cursor',
      text: `${'x'.repeat(MAX_SYNC_DETAIL_INPUT_LENGTH + 1)}connection refused`
    }),
    null
  );
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

// A client installed only inside WSL has no host directory, but its usage is
// merged into the same periods before either derivation runs — so reading the
// host filesystem alone produced a record saying `unavailable` about a client
// the very same snapshot counted half a million tokens for.
test('a WSL-only client is a client with a source, not a missing one', () => {
  const hostOnly = { hermes: [{ id: 'hermes-home', exists: false }] };
  const wslStatus = { state: 'active', detected: ['hermes'], withData: ['hermes'] };

  const withoutWsl = deriveClientHealth('hermes', { clients: { hermes: 500_000 } }, { sourceChecks: hostOnly });
  assert.equal(withoutWsl.clients.hermes.overall, 'unavailable', 'the shape this test exists to prevent');

  const checks = clientSourceChecks('hermes', { wslDetected: wslStatus.detected });
  assert.ok(checks.hermes.some((check) => check.id === 'wsl-home' && check.exists));

  const withWsl = deriveClientHealth('hermes', { clients: { hermes: 500_000 } }, {
    sourceChecks: { hermes: [...hostOnly.hermes, { id: 'wsl-home', exists: true }] },
    wslStatus
  });
  assert.equal(withWsl.clients.hermes.source.state, 'detected');
  assert.equal(withWsl.clients.hermes.overall, 'healthy');
  assert.equal(Object.hasOwn(withWsl.clients.hermes, 'diagnostics'), false);
  // And it agrees with the legacy field derived from the same signals.
  assert.equal(deriveLegacyClientStatus(withWsl.clients.hermes), 'active');
});

test('a WSL marker with no usage waits rather than reading as absent', () => {
  const health = deriveClientHealth('hermes', { clients: {} }, {
    sourceChecks: { hermes: [{ id: 'hermes-home', exists: false }, { id: 'wsl-home', exists: true }] },
    wslStatus: { state: 'active', detected: ['hermes'], withData: [] }
  });
  assert.equal(health.clients.hermes.source.state, 'detected');
  assert.equal(health.clients.hermes.overall, 'waiting');
  assert.deepEqual(health.clients.hermes.diagnostics, [{ code: 'no-usage-observed' }, { code: 'wsl-detected-no-data' }]);
  assert.equal(deriveLegacyClientStatus(health.clients.hermes), 'waiting');
});

// One probe per tick feeds both derivations. Two probes cost a second pass over
// every client's roots and let one snapshot call a directory both present and
// absent when it appeared between them.
test('the legacy status and the health record read the same source checks', () => {
  const sourceChecks = { codex: [{ id: 'codex-sessions', exists: true }], cursor: [{ id: 'tokscale-cursor-cache', exists: false }] };
  const status = deriveClientStatus('codex,cursor', { clients: { codex: 12 } }, { sourceChecks });
  const health = deriveClientHealth('codex,cursor', { clients: { codex: 12 } }, { sourceChecks });
  assert.deepEqual(status, { codex: 'active', cursor: 'missing' });
  for (const client of ['codex', 'cursor']) {
    assert.equal(deriveLegacyClientStatus(health.clients[client]), status[client], client);
  }
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

// collectHistoryOnce() survives one source failing while another succeeds, so a
// refresh can legitimately come back holding only Proma's days. Swapping the map
// wholesale on any non-empty result made a *successful* refresh report less than
// the one before it.
test('a partial history refresh updates the days it knows and keeps the rest', () => {
  const previous = { codex: '2026-08-01', claude: '2026-07-30' };
  const partial = { daily: [{ date: '2026-08-04', perClient: { proma: { tokens: 12 } } }] };
  assert.deepEqual(mergeClientActivityDays(previous, partial), {
    codex: '2026-08-01',
    claude: '2026-07-30',
    proma: '2026-08-04'
  });
  // A tick that collected no history at all keeps everything.
  assert.deepEqual(mergeClientActivityDays(previous, null), previous);
  // And a client present in both moves forward.
  assert.equal(mergeClientActivityDays(previous, {
    daily: [{ date: '2026-08-04', perClient: { codex: { tokens: 9 } } }]
  }).codex, '2026-08-04');
});

test('today usage advances activity without waiting for the next history scan', () => {
  const previous = { codex: '2026-08-04', claude: '2026-08-03' };
  const days = mergeClientActivityDays(
    previous,
    { daily: [{ date: '2026-08-04', perClient: { antigravity: { tokens: 8 } } }] },
    { clients: { codex: 12, 'antigravity-cli': 9, claude: 0 } },
    '2026-08-05'
  );
  assert.deepEqual(days, {
    codex: '2026-08-05',
    claude: '2026-08-03',
    antigravity: '2026-08-05'
  });
});

test('today usage cannot move a known activity day backwards', () => {
  assert.deepEqual(
    mergeClientActivityDays(
      { codex: '2026-08-06' },
      null,
      { clients: { codex: 12 } },
      '2026-08-05'
    ),
    { codex: '2026-08-06' }
  );
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

// A limits-only ingest carries the previous usage forward, so the fields that
// describe where that usage came from have to travel with it — otherwise the
// diagnosis blinks out on every limits refresh and comes back on the next full
// upload. Deliberately scoped to that branch: a *full* update from an agent too
// old to send these fields is stating it has none, and preserving them there
// would strand a permanently stale diagnosis on a reused device id.
test('a limits-only ingest keeps the attribution describing the usage it carries', () => {
  const now = new Date().toISOString();
  const existing = {
    deviceId: 'macbook',
    updatedAt: now,
    receivedAt: now,
    clientStatus: { codex: 'active' },
    wslStatus: { state: 'active', detected: ['codex'], withData: ['codex'] },
    clientHealth: { clients: { codex: core({ data: { liveTokens: 5 } }) } },
    today: { totalTokens: 5, clients: { codex: 5 } }
  };

  const limitsOnly = mergeDeviceRecord(existing, {
    deviceId: 'macbook', updatedAt: now, limitsOnly: true, limits: { updatedAt: now, providers: [] }
  });
  assert.equal(limitsOnly.clientHealth.clients.codex.overall, 'healthy');
  assert.deepEqual(limitsOnly.clientStatus, { codex: 'active' });
  assert.deepEqual(limitsOnly.wslStatus.withData, ['codex']);

  // A full update that simply does not carry the fields drops them, as before.
  const full = mergeDeviceRecord(existing, { deviceId: 'macbook', updatedAt: now, today: { totalTokens: 5 } });
  assert.equal(Object.hasOwn(full, 'clientHealth'), false);
  // And an incoming health record still wins over the stored one.
  const replaced = mergeDeviceRecord(existing, {
    deviceId: 'macbook',
    updatedAt: now,
    limitsOnly: true,
    clientHealth: { clients: { codex: core({ source: { state: 'missing', detectedCount: 0, checkedCount: 1 } }) } }
  });
  assert.equal(replaced.clientHealth.clients.codex.overall, 'unavailable');
});

// `liveTokens` is what the collector scanned; the record's periods can hold more
// by the time it ships. Two restorations run afterwards, in the widget and the
// agent — and the session one, unlike the untracked-client one, does not filter
// by tracked client. This test exists because the subtraction looks like a way
// to derive archived usage and is not one.
test('liveTokens is a lower bound on the shipped period, not a copy of it', () => {
  const now = new Date('2026-08-04T12:00:00.000Z');
  const summary = {
    allTime: { totalTokens: 0, clients: {}, clientCosts: {}, models: {}, modelCosts: {}, sessions: {} }
  };
  const health = deriveClientHealth('codex', summary.allTime, {
    sourceChecks: { codex: [{ id: 'codex-sessions', exists: true }] }
  });
  assert.equal(health.clients.codex.data.liveTokens, 0);
  assert.equal(health.clients.codex.overall, 'waiting');

  const restored = applySessionUsageArchive(summary, {
    version: 1,
    sessions: {
      'codex:gone': {
        client: 'codex',
        sessionId: 'gone',
        capturedAt: now.toISOString(),
        periods: { allTime: { client: 'codex', sessionId: 'gone', totalTokens: 100, models: { 'gpt-5': 100 } } }
      }
    }
  }, { now });

  // A tracked client with a health entry, whose shipped total exceeds it.
  assert.equal(restored.allTime.clients.codex, 100);
  assert.ok(restored.allTime.clients.codex > health.clients.codex.data.liveTokens);
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
