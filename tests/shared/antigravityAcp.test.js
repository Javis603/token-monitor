'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { discoverAntigravityAcpPaths, ANTIGRAVITY_ACP_SOURCE_ID } = require('../../src/shared/providers/antigravity/acpPaths');
const { clientSourceChecks, visibleDiagnosticRoots } = require('../../src/shared/clientSourceObservations');
const { tokscaleExtraDirsEnv } = require('../../src/shared/customScanPaths');
const { deriveClientHealth, startCollector } = require('../../src/shared/collector');
const { normalizeClientHealth } = require('../../src/shared/clientHealth');
const { clientHealthDetail } = require('../../src/electron/renderer/clientHealthPresentation');
const {
  watchClientRootsForClients, watchAttributionRootsForClients, watchIgnoreMatcher,
  clientsForWatchPath, selfSyncSourceRootsForClients, isSelfWatchSqliteSidecarEvent
} = require('../../src/shared/watchPolicy');

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-t3-acp-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const env = { T3CODE_HOME: '~/t3 profiles' };
  const addProfile = (profile, create = true) => {
    const dir = path.join(homeDir, 't3 profiles', 'userdata', 'providers', 'antigravity', profile, 'antigravity-acp', 'conversations');
    if (create) fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return { homeDir, env, addProfile };
}

test('ACP discovers only conversation directories, watches database updates, and keeps the Tools source count independent', t => {
  const { addProfile, ...options } = fixture(t);
  assert.deepEqual(discoverAntigravityAcpPaths(options), []);
  const second = addProfile('second');
  const first = addProfile('first');
  const invalid = addProfile('invalid', false);
  fs.mkdirSync(path.dirname(invalid), { recursive: true });
  fs.writeFileSync(invalid, '');
  assert.deepEqual(discoverAntigravityAcpPaths(options), [first, second]);
  const sources = visibleDiagnosticRoots('antigravity', options).antigravity;
  assert.deepEqual(sources.filter(source => source.id === ANTIGRAVITY_ACP_SOURCE_ID).map(source => source.dir), [first, second]);
  const checks = clientSourceChecks('antigravity', options);
  const health = normalizeClientHealth(deriveClientHealth('antigravity', { clients: { antigravity: 10 } }, { sourceChecks: checks }));
  assert.equal(health.clients.antigravity.overall, 'healthy');
  assert.ok(health.clients.antigravity.source.checks.some(check => check.id === ANTIGRAVITY_ACP_SOURCE_ID));
  const sourceGroup = clientHealthDetail(health, 'antigravity').groups[0];
  assert.equal(sourceGroup.checkedCount, checks.antigravity.length - 1);
  assert.equal(sourceGroup.detectedCount, checks.antigravity.filter(check => check.exists).length - 1);
  assert.ok(!sourceGroup.checks.some(check => check.id === ANTIGRAVITY_ACP_SOURCE_ID));

  const roots = watchClientRootsForClients('antigravity', options);
  assert.ok(roots.antigravity.includes(first));
  assert.ok(!selfSyncSourceRootsForClients('antigravity', options).antigravity?.includes(first));
  const attribution = watchAttributionRootsForClients('antigravity', roots, options);
  const ignore = watchIgnoreMatcher('antigravity', options);
  const wal = path.join(first, 'session.db-wal');
  assert.deepEqual(clientsForWatchPath(wal, attribution, { antigravity: ignore }), ['antigravity']);
  assert.equal(isSelfWatchSqliteSidecarEvent(path.join(first, 'session.db-shm'), roots), true);
  assert.ok(!watchClientRootsForClients('codex', options).antigravity);
});

test('automatically discovered ACP roots overlap safely with manually configured paths', t => {
  const { addProfile, homeDir } = fixture(t);
  const first = addProfile('first');
  const child = path.join(first, 'nested');
  fs.mkdirSync(child);
  const parent = path.dirname(first);
  const options = { home: homeDir, antigravityAcpPaths: [first] };
  const cliRoots = manual => tokscaleExtraDirsEnv({ antigravity: manual }, '', options)
    .split(',').filter(entry => entry.startsWith('antigravity-cli:'));
  assert.deepEqual(cliRoots([]), [`antigravity-cli:${first}`]);
  assert.deepEqual(cliRoots([first, child]), [`antigravity-cli:${first}`]);
  assert.deepEqual(cliRoots([parent]), [`antigravity-cli:${parent}`]);

  const extension = path.join(homeDir, '.gemini', 'antigravity', 'conversations');
  fs.mkdirSync(path.dirname(extension), { recursive: true });
  fs.symlinkSync(first, extension, 'junction');
  assert.deepEqual(cliRoots([first]), []);
  assert.deepEqual(cliRoots([]), []);
});

test('a newly discovered ACP profile invalidates the Today anchor and reaches all windows and History', async t => {
  const { addProfile, ...options } = fixture(t);
  const scans = [];
  const graphs = [];
  const errors = [];
  const runtime = startCollector({
    ...options,
    clients: 'antigravity',
    allTimeSince: '2024-01-01',
    anchorPersistenceEnabled: false,
    dailyHistoryArchiveEnabled: false,
    watchEnabled: false,
    sessionActivityPolling: false,
    intervalMs: 3600000,
    pricingCatalogTimers: { setTimeout: () => 1, clearTimeout() {} },
    runTokscale: async ({ flags, antigravityAcpPaths }) => {
      scans.push([flags, antigravityAcpPaths]);
      return { entries: [] };
    },
    runGraph: async ({ antigravityAcpPaths }) => {
      graphs.push(antigravityAcpPaths);
      return { contributions: [] };
    },
    onError: error => errors.push(error)
  });
  try {
    await runtime.whenIdle();
    assert.equal(scans.length, 3);
    const first = addProfile('first');
    await runtime.refreshClient('antigravity');
    assert.deepEqual(errors, []);
    assert.deepEqual(scans.slice(3), [
      [['--today'], [first]], [['--month'], [first]], [['--since', '2024-01-01'], [first]]
    ]);
    assert.deepEqual(graphs, [[], [first]]);
  } finally {
    runtime.stop();
    await runtime.whenIdle();
  }
});
