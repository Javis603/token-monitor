'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  clientSourceChecks, clientSourceRoots, clientWatchCandidates,
  clientsForWatchPath, deriveClientHealth, watchAttributionRootsForClients,
  watchIgnoreMatcher, watchPathsForClients
} = require('../../src/shared/collector');
const { normalizeClientHealth } = require('../../src/shared/clientHealth');
const { clientsCsvForSetting, DEFAULT_CLIENTS, PARSE_LOCAL_CLIENTS } = require('../../src/shared/clientTracking');
const { extractUsageFromTokscale, normalizeClientName } = require('../../src/shared/usage');
const { homeHasData } = require('../../src/shared/wslUsage');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

installSourceEnvGuard(test);

function studioHome(t) {
  // Windows CI uses an 8.3 temp path; match the collector's canonical watch roots.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'unsloth-source-'));
  process.env.UNSLOTH_STUDIO_HOME = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Unsloth source resolution follows the released Tokscale environment override', () => {
  const home = path.join(os.tmpdir(), 'unsloth-path-home');
  for (const override of [undefined, '', '   ', path.join(home, 'custom-studio')]) {
    const env = override === undefined ? {} : { UNSLOTH_STUDIO_HOME: override };
    const dir = override?.trim() || path.join(home, '.unsloth', 'studio');
    assert.deepEqual(clientSourceRoots('unsloth', { homeDir: home, env }).unsloth, [
      { id: 'unsloth-db', dir, sourcePath: path.join(dir, 'studio.db') }
    ]);
  }
  assert.equal(clientSourceRoots('codex', { homeDir: home, env: {} }).unsloth, undefined);
});

test('Unsloth is a normal Tokscale client without changing saved selections', () => {
  assert.ok(DEFAULT_CLIENTS.split(',').includes('unsloth'));
  assert.ok(!PARSE_LOCAL_CLIENTS.includes('unsloth'));
  assert.equal(clientsCsvForSetting('codex,lmstudio'), 'codex,lmstudio');
  assert.equal(clientsCsvForSetting('codex,unsloth'), 'codex,unsloth');
  assert.equal(clientsCsvForSetting(''), '');
  for (const name of ['unsloth', 'Unsloth', 'Unsloth Studio', 'Unsloth API']) {
    assert.equal(normalizeClientName(name), 'unsloth');
  }
});

test('Unsloth health requires the database, but its parent can watch for first use', (t) => {
  const dir = studioHome(t);
  assert.deepEqual(clientWatchCandidates('unsloth').unsloth, [dir]);
  assert.deepEqual(watchPathsForClients('unsloth'), [dir]);
  assert.deepEqual(clientSourceChecks('unsloth').unsloth, [{ id: 'unsloth-db', exists: false }]);
  const missing = deriveClientHealth('unsloth', { clients: {} });
  assert.deepEqual(normalizeClientHealth(missing).clients.unsloth.source.checks, [
    { id: 'unsloth-db', exists: false }
  ]);
  fs.mkdirSync(path.join(dir, 'models'));
  fs.writeFileSync(path.join(dir, 'studio.db-wal'), '');
  assert.equal(clientSourceChecks('unsloth').unsloth[0].exists, false);
  fs.writeFileSync(path.join(dir, 'studio.db'), '');
  const checks = clientSourceChecks('unsloth');
  assert.deepEqual(checks.unsloth, [{ id: 'unsloth-db', exists: true }]);
  const health = deriveClientHealth('unsloth', { clients: {} }, { sourceChecks: checks });
  assert.equal(health.clients.unsloth.source.state, 'detected');
  assert.equal(health.clients.unsloth.overall, 'waiting');
});

test('Unsloth watches only the direct database family, including late SQLite sidecars', (t) => {
  const dir = studioHome(t);
  const ignored = watchIgnoreMatcher('unsloth');
  const roots = watchAttributionRootsForClients('unsloth');
  assert.equal(ignored(dir), false);
  for (const name of ['studio.db', 'studio.db-wal', 'studio.db-shm']) {
    const file = path.join(dir, name);
    assert.equal(ignored(file), false, name);
    assert.deepEqual(clientsForWatchPath(file, roots), ['unsloth']);
  }
  for (const name of ['models', 'models/studio.db', 'venv', 'logs', 'other.db', 'studio.db.bak']) {
    assert.equal(ignored(path.join(dir, name)), true, name);
  }
});

test('Unsloth watch pruning preserves an overlapping enabled client source', (t) => {
  const dir = studioHome(t);
  process.env.CODEX_HOME = path.join(dir, 'codex');
  const ignored = watchIgnoreMatcher('unsloth,codex');
  assert.equal(ignored(path.join(dir, 'models', 'weights.gguf')), true);
  assert.equal(ignored(path.join(dir, 'codex', 'sessions', '2026', 'session.jsonl')), false);
});

test('Unsloth keeps local zero cost and metered estimates in the same client partition', () => {
  const period = extractUsageFromTokscale([
    { client: 'unsloth', model: 'local-model', totalTokens: 140, cost: 0 },
    { client: 'unsloth', model: 'paid-model', totalTokens: 60, cost: 0.002 }
  ]);
  assert.equal(period.totalTokens, 200);
  assert.equal(period.clients.unsloth, 200);
  assert.equal(period.costUsd, 0.002);
  assert.equal(period.clientCosts.unsloth, 0.002);
});

test('WSL discovery requires the Unsloth database, not just its runtime directory', () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\u';
  const dir = `${home}\\.unsloth\\studio`;
  assert.deepEqual(homeHasData(home, (file) => file === dir), []);
  assert.deepEqual(homeHasData(home, (file) => file === `${dir}\\studio.db`), ['unsloth']);
});
