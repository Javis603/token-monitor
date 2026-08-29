'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  clientSourceChecks,
  clientSourceRoots,
  clientWatchCandidates,
  deriveClientHealth,
  watchPathsForClients
} = require('../../src/shared/collector');
const { normalizeClientName } = require('../../src/shared/usage');

test('normalizeClientName maps LM Studio sources to lmstudio', () => {
  assert.equal(normalizeClientName('lmstudio'), 'lmstudio');
  assert.equal(normalizeClientName('LM Studio'), 'lmstudio');
  assert.equal(normalizeClientName('lm-studio'), 'lmstudio');
  assert.equal(normalizeClientName('lm_studio'), 'lmstudio');
});

test('LM Studio source root mirrors tokscale LM_STUDIO_HOME resolution', () => {
  const home = path.join(os.tmpdir(), 'lmstudio-path-home');
  const fallback = path.join(home, '.lmstudio', 'server-logs');
  const customHome = path.join(home, 'custom-lmstudio');

  assert.deepEqual(clientSourceRoots('lmstudio', { homeDir: home, env: {} }).lmstudio, [
    { id: 'lmstudio-server-logs', dir: fallback }
  ]);
  assert.deepEqual(clientSourceRoots('lmstudio', {
    homeDir: home,
    env: { LM_STUDIO_HOME: customHome }
  }).lmstudio, [
    { id: 'lmstudio-server-logs', dir: path.join(customHome, 'server-logs') }
  ]);
  assert.deepEqual(clientSourceRoots('lmstudio', {
    homeDir: home,
    env: { LM_STUDIO_HOME: '   ' }
  }).lmstudio, [
    { id: 'lmstudio-server-logs', dir: fallback }
  ]);
});

test('LM Studio server logs feed watches and source health', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lmstudio-home-'));
  const logs = path.join(tempRoot, 'server-logs');
  const previous = process.env.LM_STUDIO_HOME;
  process.env.LM_STUDIO_HOME = tempRoot;

  try {
    fs.mkdirSync(path.join(logs, '2026-08'), { recursive: true });
    assert.deepEqual(clientWatchCandidates('lmstudio').lmstudio, [logs]);
    assert.deepEqual(watchPathsForClients('lmstudio'), [logs]);
    const checks = clientSourceChecks('lmstudio');
    assert.deepEqual(checks.lmstudio, [{ id: 'lmstudio-server-logs', exists: true }]);
    const health = deriveClientHealth('lmstudio', { clients: {} }, { sourceChecks: checks });
    assert.equal(health.clients.lmstudio.source.state, 'detected');
    assert.equal(health.clients.lmstudio.overall, 'waiting');
  } finally {
    if (previous === undefined) delete process.env.LM_STUDIO_HOME;
    else process.env.LM_STUDIO_HOME = previous;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
