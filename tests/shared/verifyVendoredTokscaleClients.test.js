'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyVendoredTokscaleClients } = require('../../scripts/verify-vendored-tokscale-clients');
const { DEFAULT_CLIENTS, PARSE_LOCAL_CLIENTS } = require('../../src/shared/clientTracking');

// Every DEFAULT_CLIENTS entry tokscale itself is expected to recognize —
// i.e. everything except the parse-local ones (proma, qodercn), which are
// deliberately absent from tokscale's own --client list.
const LOCALLY_PARSED = new Set(PARSE_LOCAL_CLIENTS);
const ALL_TOKSCALE_SUPPORTED = DEFAULT_CLIENTS.split(',').filter((client) => !LOCALLY_PARSED.has(client));

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
  assert.deepEqual(result, { key: 'darwin-arm64', mode: 'override', clients: DEFAULT_CLIENTS.split(',').length });
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
    /npm-installed tokscale \(darwin-arm64\) does not recognize these DEFAULT_CLIENTS entries: antigravity/
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
