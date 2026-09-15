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
  watchPathsForClients
} = require('../../src/shared/collector');
const { CLIENT_LABELS } = require('../../src/shared/clientCatalog');
const { CUSTOM_SCAN_CLIENT_IDS, tokscaleExtraDirsEnv } = require('../../src/shared/customScanPaths');
const { DEFAULT_CLIENTS, PARSE_LOCAL_CLIENTS } = require('../../src/shared/clientTracking');
const { extractUsageFromTokscale, normalizeClientName } = require('../../src/shared/usage');
const { homeHasData } = require('../../src/shared/wslUsage');

// Amp resolves through Tokscale's XDG data root, so the developer's own
// XDG_DATA_HOME is an input to the path assertions below. Clear it per test and
// set it explicitly where a case wants one.
installSourceEnvGuard(test);

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

test('Amp is a default-tracked Tokscale client, not a local adapter', () => {
  assert.ok(DEFAULT_CLIENTS.split(',').includes('amp'));
  assert.ok(!PARSE_LOCAL_CLIENTS.includes('amp'));
});

test('Amp threads feed the XDG source root, watcher, and health paths', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-home-'));
  const threads = path.join(home, '.local', 'share', 'amp', 'threads');
  fs.mkdirSync(threads, { recursive: true });
  try {
    const options = { homeDir: home, env: {}, platform: process.platform };
    assert.deepEqual(clientSourceRoots('amp', options).amp, [
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
    // clients.rs declares PathRoot::XdgData for amp, and that root consults
    // XDG_DATA_HOME on every platform (never a home-relative literal), so an
    // override must move the root with it. It is set on process.env here because
    // that is the environment production resolves from; the injected options bag
    // is honoured too, and tests/shared/tokscaleBlankEnv.test.js is what pins it.
    const options = { homeDir: home, platform: 'linux' };
    assert.deepEqual(clientSourceRoots('amp', options).amp, [
      { id: 'amp-threads', dir: path.join(home, '.local', 'share', 'amp', 'threads') }
    ]);

    process.env.XDG_DATA_HOME = xdg;
    assert.deepEqual(clientSourceRoots('amp', options).amp, [
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
      clientSourceRoots('amp', options).amp,
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
