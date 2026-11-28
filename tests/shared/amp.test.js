'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { installSourceEnvGuard } = require('../helpers/sourceEnv');

const {
  clientSourceChecks,
  clientSourceRoots,
  clientWatchCandidates,
  deriveClientHealth,
  startCollector,
  watchPathsForClients
} = require('../../src/shared/collector');
const { CLIENT_LABELS } = require('../../src/shared/clientCatalog');
const { CUSTOM_SCAN_CLIENT_IDS, tokscaleExtraDirsEnv } = require('../../src/shared/customScanPaths');
const { DEFAULT_CLIENTS } = require('../../src/shared/clientTracking');
const { FORK_ONLY_CLIENT_IDS } = require('../../src/shared/clientCatalog');
const { extractUsageFromTokscale, normalizeClientName } = require('../../src/shared/usage');
const { homeHasData } = require('../../src/shared/wslUsage');

// Amp resolves through Tokscale's XDG data root, so the developer's own
// XDG_DATA_HOME is an input to the path assertions below. Clear it per test and
// set it explicitly where a case wants one.
installSourceEnvGuard(test);

test('Amp imports in the background and rescans historical usage after a partial sync', { timeout: 15_000 }, async (t) => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-active-cache-'));
  process.env.TOKSCALE_CONFIG_DIR = config;
  const firstImport = Promise.withResolvers();
  const localUpdate = Promise.withResolvers();
  const importScanFailure = Promise.withResolvers();
  const importedUpdate = Promise.withResolvers();
  const manualUpdate = Promise.withResolvers();
  let imports = 0;
  let cacheHasUsage = false;
  let failNextScan = false;
  let allTimeScans = 0;
  const collector = startCollector({
    clients: 'codex,amp',
    deviceId: 'amp-test',
    historyEnabled: false,
    allTimeSince: '2020-01-01',
    intervalRequiresActivity: true,
    runAmpSync: () => ++imports === 1 ? firstImport.promise : Promise.resolve({ complete: true, exported: 0 }),
    async runTokscale({ clients, flags }) {
      if (flags.includes('--since')) allTimeScans++;
      if (failNextScan) {
        failNextScan = false;
        throw new Error('fixture scan failed after Amp export');
      }
      const entries = [];
      if (clients.includes('codex')) entries.push({ source: 'codex', model: 'gpt-5', input: 10 });
      if (cacheHasUsage && clients.includes('amp') && !flags.includes('--today')) {
        entries.push({ source: 'amp', model: 'claude-sonnet-4-0', input: 123, output: 7 });
      }
      return { entries };
    },
    onUpdate(summary, reason) {
      if (reason === 'interval') localUpdate.resolve(summary);
      if (cacheHasUsage && (reason === 'coalesced' || reason === 'watch:amp-fixture')) importedUpdate.resolve(summary);
      if (reason === 'manual') manualUpdate.resolve(summary);
    },
    onError(error, reason) {
      if (reason === 'source-sync') importScanFailure.resolve(error);
    }
  });
  t.after(async () => {
    firstImport.resolve({ complete: true, exported: 0 });
    collector.stop();
    await collector.whenIdle();
    fs.rmSync(config, { recursive: true, force: true });
  });

  const initial = await localUpdate.promise;
  assert.equal(imports, 1);
  assert.equal(initial.today.clients.codex, 10);
  assert.equal(initial.clientHealth.clients.amp.collection.state, 'pending');
  const cache = path.join(config, 'amp-cache', 'threads');
  fs.mkdirSync(cache, { recursive: true });
  const beforeImport = allTimeScans;
  for (const file of ['T-first.json', 'T-second.json']) {
    fs.writeFileSync(path.join(cache, file), '{}');
    assert.equal(await collector.tick('watch:codex', { todayOnly: true, targetClients: ['codex'] }), true);
    assert.equal(allTimeScans, beforeImport);
  }
  cacheHasUsage = true;
  failNextScan = true;
  firstImport.reject(Object.assign(new Error('Amp sync incomplete'), {
    tokscaleExitCode: 1,
    tokscaleJson: { complete: false, exported: 1, remaining: 1, error: 'export timed out' }
  }));
  assert.match((await importScanFailure.promise).message, /fixture scan failed/);
  assert.equal(await collector.tick('watch:amp-fixture', { todayOnly: true, targetClients: ['codex'] }), true);
  const imported = await importedUpdate.promise;
  assert.equal(imported.allTime.clients.amp, 130);
  assert.equal(imported.today.clients.amp, undefined);
  assert.equal(imported.clientHealth.clients.amp.collection.state, 'failed');
  assert.equal(imported.clientHealth.clients.amp.collection.syncFailureStage, 'timeout');
  assert.equal(imported.clientHealth.clients.amp.collection.lastSuccessAt, undefined);

  assert.equal(await collector.tick('manual', { forceSelfSync: true }), true);
  const refreshed = await manualUpdate.promise;
  assert.equal(imports, 2);
  assert.equal(refreshed.allTime.clients.amp, 130);
  assert.equal(refreshed.clientHealth.clients.amp.collection.state, 'ok');
  assert.ok(refreshed.clientHealth.clients.amp.collection.lastSuccessAt);
});

test('an externally imported Amp cache forces History to retry after a graph error', { timeout: 15_000 }, async (t) => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-external-cache-'));
  process.env.TOKSCALE_CONFIG_DIR = config;
  const firstUpdate = Promise.withResolvers();
  let graphAttempts = 0;
  let scannedAllTime = false;
  const collector = startCollector({
    clients: 'amp', deviceId: 'amp-external-cache', allTimeSince: '2020-01-01',
    async runTokscale({ flags }) {
      if (flags.includes('--since')) scannedAllTime = true;
      return { entries: [] };
    },
    async runGraph() {
      if (++graphAttempts === 2) throw new Error('fixture graph unavailable');
      return { contributions: [] };
    },
    onUpdate() { firstUpdate.resolve(); }
  });
  t.after(async () => {
    collector.stop();
    await collector.whenIdle();
    fs.rmSync(config, { recursive: true, force: true });
  });

  await firstUpdate.promise;
  await collector.whenIdle();
  assert.equal(graphAttempts, 1);
  assert.equal(scannedAllTime, true);
  const cache = path.join(config, 'amp-cache', 'threads');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'T-external.json'), '{}');

  for (const expectedAttempts of [2, 3]) {
    scannedAllTime = false;
    assert.equal(await collector.tick('watch:amp-external', { todayOnly: true, targetClients: ['amp'] }), true);
    assert.equal(graphAttempts, expectedAttempts);
    assert.equal(scannedAllTime, true);
  }
  scannedAllTime = false;
  assert.equal(await collector.tick('watch:amp-external', { todayOnly: true }), true);
  assert.equal(graphAttempts, 3);
  assert.equal(scannedAllTime, false);
});

test('Amp keeps the canonical amp id without matching unrelated client names', () => {
  assert.equal(CLIENT_LABELS.amp, 'Amp');
  assert.equal(normalizeClientName('Amp'), 'amp');
  assert.equal(normalizeClientName('amp'), 'amp');
  // The exact-match rule is what keeps the id a fixed point of the targeted-scan
  // partition key without swallowing a differently-named client that merely
  // contains the substring.
  assert.equal(normalizeClientName('ampersand'), 'ampersand');
  assert.equal(normalizeClientName('pramp'), 'pramp');
});

test('Amp is a default-tracked upstream Tokscale client, not a fork-only one', () => {
  assert.ok(DEFAULT_CLIENTS.split(',').includes('amp'));
  assert.ok(!FORK_ONLY_CLIENT_IDS.includes('amp'));
});

test('Amp threads feed the XDG source root, watcher, and health paths', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-home-'));
  const threads = path.join(home, '.local', 'share', 'amp', 'threads');
  fs.mkdirSync(threads, { recursive: true });
  try {
    const options = { homeDir: home, env: {}, platform: process.platform };
    assert.deepEqual(clientSourceRoots('amp', options).amp.filter(({ optional }) => !optional), [
      { id: 'amp-threads', dir: threads }
    ]);
    assert.deepEqual(clientWatchCandidates('amp', options).amp, [threads]);
    assert.deepEqual(watchPathsForClients('amp', options), [threads]);
    const checks = clientSourceChecks('amp', options);
    assert.deepEqual(checks.amp, [{ id: 'amp-threads', exists: true }]);
    assert.equal(
      deriveClientHealth('amp', { clients: {} }, { sourceChecks: checks }).clients.amp.source.state,
      'detected'
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Amp follows XDG_DATA_HOME like Tokscale does, not a home-relative literal', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-xdg-home-'));
  const xdg = path.join(home, 'custom-xdg');
  try {
    // The legacy Amp root remains PathRoot::XdgData; it consults
    // XDG_DATA_HOME on every platform (never a home-relative literal), so an
    // override must move the root with it. It is set on process.env here because
    // that is the environment production resolves from; the injected options bag
    // is honoured too, and tests/shared/tokscaleBlankEnv.test.js is what pins it.
    const options = { homeDir: home, platform: 'linux' };
    assert.deepEqual(clientSourceRoots('amp', options).amp.filter(({ optional }) => !optional), [
      { id: 'amp-threads', dir: path.join(home, '.local', 'share', 'amp', 'threads') }
    ]);

    process.env.XDG_DATA_HOME = xdg;
    assert.deepEqual(clientSourceRoots('amp', options).amp.filter(({ optional }) => !optional), [
      { id: 'amp-threads', dir: path.join(xdg, 'amp', 'threads') }
    ]);

    // A whitespace-only override counts as unset here, matching every other
    // XDG-derived root. Tokscale's own PathRoot::XdgData reads the variable with
    // a bare `std::env::var(...)`, where any present value — including "" and
    // "   " — wins, so the scan would otherwise resolve a different root than
    // this one. tokscaleCommand() reconciles that at the subprocess boundary by
    // dropping a blank value from the child's environment (see
    // tokscaleEnvWithBlanksDropped in collector.js and
    // tests/shared/tokscaleBlankEnv.test.js), so the assertion below and the
    // value the binary actually receives agree.
    process.env.XDG_DATA_HOME = '   ';
    assert.deepEqual(
      clientSourceRoots('amp', options).amp.filter(({ optional }) => !optional),
      [{ id: 'amp-threads', dir: path.join(home, '.local', 'share', 'amp', 'threads') }],
      'blank XDG_DATA_HOME is unset for Token Monitor, and tokscaleCommand() drops it for the child'
    );
  } finally {
    delete process.env.XDG_DATA_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Amp supports custom Tokscale roots and WSL discovery', () => {
  assert.equal(CUSTOM_SCAN_CLIENT_IDS.includes('amp'), true);
  assert.equal(
    tokscaleExtraDirsEnv({ amp: ['/var/data/amp'] }, '', { platform: 'linux' }),
    'amp:/var/data/amp'
  );
  const home = String.raw`\\wsl$\Ubuntu\home\u`;
  assert.deepEqual(
    homeHasData(home, (candidate) => candidate === `${home}\\.local\\share\\amp\\threads`),
    ['amp']
  );
});

test('Amp usage keeps Tokscale token categories and session attribution', () => {
  const period = extractUsageFromTokscale({
    groupBy: 'client,workspace,session,model',
    entries: [{
      client: 'amp',
      model: 'claude-sonnet-4-5',
      sessionId: 'T-01923abc',
      input: 1200,
      output: 340,
      cacheRead: 500,
      cacheWrite: 25,
      totalTokens: 2065
    }]
  });

  assert.equal(period.totalTokens, 2065);
  assert.equal(period.clients.amp, 2065);
  assert.equal(period.clientOutputs.amp, 340);
  assert.equal(period.clientCacheReads.amp, 500);
  assert.equal(period.clientCacheWrites.amp, 25);
  assert.equal(period.sessions['amp:T-01923abc'].client, 'amp');
  assert.equal(period.sessions['amp:T-01923abc'].sessionId, 'T-01923abc');
});

test('Amp threads carry no workspace, so rows stay unattributed rather than mislabelled', () => {
  // tokscale's Amp parser reports no workspace for a thread, so the scan returns
  // workspaceKey: null / "Unknown workspace". A row must not invent a project id
  // from the thread id.
  const period = extractUsageFromTokscale({
    groupBy: 'client,workspace,session,model',
    entries: [{
      client: 'amp',
      model: 'gpt-5',
      sessionId: 'T-01923abc',
      workspaceKey: null,
      workspaceLabel: 'Unknown workspace',
      input: 800,
      output: 90,
      totalTokens: 890
    }]
  });

  assert.equal(period.clients.amp, 890);
  // The shared extractor leaves an unresolved project as an empty string rather
  // than a fabricated id; the assertion is that nothing was invented from the
  // thread id or the "Unknown workspace" label.
  assert.equal(period.sessions['amp:T-01923abc'].projectId || '', '');
  assert.equal(period.sessions['amp:T-01923abc'].projectLabel || '', '');
});
