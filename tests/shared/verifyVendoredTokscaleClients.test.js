'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyVendoredTokscaleClients } = require('../../scripts/verify-vendored-tokscale-clients');
const { KNOWN_CLIENTS } = require('../../src/shared/clientTracking');
const { FORK_ONLY_CLIENT_IDS } = require('../../src/shared/clientCatalog');
const { tokscaleClientFilter } = require('../../src/shared/collector');

// Every effective client id tokscale itself is expected to recognize — every
// KNOWN_CLIENTS entry except the fork-only ones (proma, qodercn), plus
// their TOKSCALE_CLIENT_ALIASES expansion (e.g. antigravity -> antigravity,
// antigravity-cli) — since that's the exact CSV runTokscale/runTokscaleGraph
// send, not just the logical client entries. Opt-in clients (qodercn) are in
// scope too: enabling one sends its id to the same binary, which exits 2 on an
// id it does not recognize.
const FORK_ONLY = new Set(FORK_ONLY_CLIENT_IDS);
const TOKSCALE_ONLY_CLIENTS = KNOWN_CLIENTS.split(',').filter((client) => !FORK_ONLY.has(client));
const ALL_TOKSCALE_SUPPORTED = tokscaleClientFilter(TOKSCALE_ONLY_CLIENTS.join(',')).split(',');

function helpTextFor(clients) {
  return `--client <CLIENTS> [possible values: ${clients.join(', ')}]`;
}

function spawnReturning(helpText) {
  return () => ({ status: 0, stdout: helpText, stderr: '' });
}

test('override mode verifies the vendored binary and reports it as such', () => {
  const logs = [];
  const result = verifyVendoredTokscaleClients({
    manifest: { platforms: { x: {} } },
    resolveEntry: () => ({ key: 'darwin-arm64', entry: {} }),
    resolveTarget: () => '/vendored/tokscale',
    spawn: spawnReturning(helpTextFor(ALL_TOKSCALE_SUPPORTED)),
    log: (message) => logs.push(message)
  });
  assert.deepEqual(result, {
    key: 'darwin-arm64',
    mode: 'override',
    clients: ALL_TOKSCALE_SUPPORTED.length,
    forkOnlyClients: FORK_ONLY_CLIENT_IDS.length
  });
  assert.ok(logs[0].includes('Verified vendored tokscale'));
});

test('upstream mode still verifies — the plain npm-installed binary — instead of skipping', () => {
  const logs = [];
  const result = verifyVendoredTokscaleClients({
    manifest: { mode: 'upstream', platforms: { x: {} } },
    resolveEntry: () => ({ key: 'darwin-arm64', entry: {} }),
    resolveTarget: () => '/npm/tokscale',
    spawn: spawnReturning(helpTextFor(ALL_TOKSCALE_SUPPORTED)),
    log: (message) => logs.push(message)
  });
  assert.equal(result.mode, 'upstream');
  assert.ok(logs[0].includes('Verified npm-installed tokscale'), logs[0]);
});

test('upstream mode still fails closed when the newly-bumped binary is missing a client', () => {
  const missingDsh = ALL_TOKSCALE_SUPPORTED.filter((client) => client !== 'antigravity');
  assert.throws(
    () => verifyVendoredTokscaleClients({
      manifest: { mode: 'upstream', platforms: { x: {} } },
      resolveEntry: () => ({ key: 'darwin-arm64', entry: {} }),
      resolveTarget: () => '/npm/tokscale',
      spawn: spawnReturning(helpTextFor(missingDsh)),
      log: () => {}
    }),
    /npm-installed tokscale \(darwin-arm64\) does not recognize these client ids: antigravity/
  );
});

test('override mode failure message points at the vendor pin, not the tokscale dependency', () => {
  const missingOne = ALL_TOKSCALE_SUPPORTED.filter((client) => client !== 'claude');
  assert.throws(
    () => verifyVendoredTokscaleClients({
      manifest: { platforms: { x: {} } },
      resolveEntry: () => ({ key: 'darwin-arm64', entry: {} }),
      resolveTarget: () => '/vendored/tokscale',
      spawn: spawnReturning(helpTextFor(missingOne)),
      log: () => {}
    }),
    /Vendored tokscale .* the vendor pin needs updating/
  );
});

test('a binary that still recognizes the umbrella id but dropped its tokscale alias fails closed', () => {
  // Real risk this guards against: a future tokscale release keeps
  // recognizing `antigravity` but renames or drops `antigravity-cli` — the
  // umbrella id alone staying supported must not be enough to pass, since
  // tokscaleClientFilter() sends both ids on every real scan.
  const droppedAlias = ALL_TOKSCALE_SUPPORTED.filter((client) => client !== 'antigravity-cli');
  assert.throws(
    () => verifyVendoredTokscaleClients({
      manifest: { platforms: { x: {} } },
      resolveEntry: () => ({ key: 'darwin-arm64', entry: {} }),
      resolveTarget: () => '/vendored/tokscale',
      spawn: spawnReturning(helpTextFor(droppedAlias)),
      log: () => {}
    }),
    /Vendored tokscale \(darwin-arm64\) does not recognize these client ids: antigravity-cli/
  );
});

test('fork-only clients are verified by an isolated scan, not by --help', () => {
  const calls = [];
  const spawn = (bin, args) => {
    calls.push(args);
    return { status: 0, stdout: args[0] === '--help' ? helpTextFor(ALL_TOKSCALE_SUPPORTED) : '{}', stderr: '' };
  };
  verifyVendoredTokscaleClients({
    manifest: { platforms: { x: {} } },
    resolveEntry: () => ({ key: 'darwin-arm64', entry: {} }),
    resolveTarget: () => '/vendored/tokscale',
    spawn,
    log: () => {}
  });
  const scan = calls.find((args) => args[0] !== '--help');
  assert.deepEqual(scan.slice(0, 4), ['--json', '--client', FORK_ONLY_CLIENT_IDS.join(','), '--today']);
  assert.equal(scan[4], '--home');
  assert.ok(!FORK_ONLY_CLIENT_IDS.some((client) => helpTextFor(ALL_TOKSCALE_SUPPORTED).includes(client)));
});

test('a binary without the fork client module fails closed', () => {
  const spawn = (bin, args) => (args[0] === '--help'
    ? { status: 0, stdout: helpTextFor(ALL_TOKSCALE_SUPPORTED), stderr: '' }
    : { status: 2, stdout: '', stderr: "error: invalid value 'proma' for '--client <CLIENTS>'" });
  assert.throws(
    () => verifyVendoredTokscaleClients({
      manifest: { platforms: { x: {} } },
      resolveEntry: () => ({ key: 'darwin-arm64', entry: {} }),
      resolveTarget: () => '/vendored/tokscale',
      spawn,
      log: () => {}
    }),
    /does not accept the fork-only client ids proma, qodercn \(scan exited 2/
  );
});
