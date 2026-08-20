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

test('normalizeClientName maps Cherry Studio sources to cherrystudio', () => {
  assert.equal(normalizeClientName('cherrystudio'), 'cherrystudio');
  assert.equal(normalizeClientName('Cherry Studio'), 'cherrystudio');
  assert.equal(normalizeClientName('cherry-studio'), 'cherrystudio');
  assert.equal(normalizeClientName('cherry_studio'), 'cherrystudio');
});

test('Cherry Studio V1 and V2 roots feed watches and source health', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cherrystudio-home-'));
  const appData = path.join(home, 'AppData', 'Roaming');
  const xdgConfigHome = path.join(home, '.config');
  const previousAppData = process.env.APPDATA;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalHomedir = os.homedir;
  os.homedir = () => home;
  process.env.APPDATA = appData;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;

  try {
    const expected = [
      path.join(appData, 'CherryStudio', 'Data', 'Agents', '.claude', 'projects'),
      path.join(appData, 'CherryStudio', '.claude', 'projects'),
      path.join(home, 'Library', 'Application Support', 'CherryStudio', 'Data', 'Agents', '.claude', 'projects'),
      path.join(home, 'Library', 'Application Support', 'CherryStudio', '.claude', 'projects'),
      path.join(xdgConfigHome, 'CherryStudio', 'Data', 'Agents', '.claude', 'projects'),
      path.join(xdgConfigHome, 'CherryStudio', '.claude', 'projects')
    ];
    const v2Roots = expected.filter((dir) => dir.includes(path.join('Data', 'Agents')));
    const legacyRoots = expected.filter((dir) => !dir.includes(path.join('Data', 'Agents')));
    const roots = clientSourceRoots('cherrystudio').cherrystudio;

    assert.deepEqual(roots, expected.map((dir) => ({ id: 'cherrystudio-transcripts', dir })));
    assert.deepEqual(clientWatchCandidates('cherrystudio').cherrystudio, expected);

    const assertSourceState = (existingRoots) => {
      for (const dir of existingRoots) fs.mkdirSync(dir, { recursive: true });
      try {
        assert.deepEqual(watchPathsForClients('cherrystudio').sort(), existingRoots.slice().sort());
        const checks = clientSourceChecks('cherrystudio');
        assert.deepEqual(checks.cherrystudio, [{ id: 'cherrystudio-transcripts', exists: true }]);
        const health = deriveClientHealth('cherrystudio', { clients: {} }, { sourceChecks: checks });
        assert.equal(health.clients.cherrystudio.source.state, 'detected');
      } finally {
        for (const dir of existingRoots) fs.rmSync(dir, { recursive: true, force: true });
      }
    };

    assertSourceState(v2Roots);
    assertSourceState(legacyRoots);
  } finally {
    os.homedir = originalHomedir;
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
