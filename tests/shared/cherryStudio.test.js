'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  cherryStudioTranscriptRoots,
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

test('Cherry Studio roots mirror tokscale AppData resolution per platform', () => {
  const home = path.join('test-home', 'alice');
  const cases = [
    {
      platform: 'win32',
      env: { APPDATA: path.join(home, 'custom-roaming'), XDG_CONFIG_HOME: path.join(home, 'wrong-xdg') },
      base: path.join(home, 'custom-roaming')
    },
    {
      platform: 'darwin',
      env: { APPDATA: path.join(home, 'wrong-roaming'), XDG_CONFIG_HOME: path.join(home, 'wrong-xdg') },
      base: path.join(home, 'Library', 'Application Support')
    },
    {
      platform: 'linux',
      env: { XDG_CONFIG_HOME: path.join(home, 'custom-xdg') },
      base: path.join(home, 'custom-xdg')
    }
  ];

  for (const { platform, env, base } of cases) {
    const expected = [
      ['cherrystudio-transcripts', path.join(base, 'CherryStudio', 'Data', 'Agents', '.claude', 'projects')],
      ['cherrystudio-transcripts', path.join(base, 'CherryStudio', '.claude', 'projects')]
    ];
    assert.deepEqual(cherryStudioTranscriptRoots({ homeDir: home, platform, env }), expected);
    assert.deepEqual(
      clientSourceRoots('cherrystudio', { homeDir: home, platform, env }).cherrystudio,
      expected.map(([id, dir]) => ({ id, dir }))
    );
  }
});

test('Cherry Studio V1 and V2 roots feed watches and source health', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cherrystudio-home-'));
  const appData = process.platform === 'win32'
    ? path.join(home, 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : path.join(home, '.config');
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
      path.join(appData, 'CherryStudio', '.claude', 'projects')
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

test('Cherry Studio ignores foreign-platform roots for watches and source health', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cherrystudio-foreign-home-'));
  const env = {
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(home, '.config')
  };
  const foreignPlatform = process.platform === 'win32' ? 'darwin' : 'win32';
  const foreignRoot = cherryStudioTranscriptRoots({ homeDir: home, platform: foreignPlatform, env })[0][1];
  const previousAppData = process.env.APPDATA;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalHomedir = os.homedir;
  os.homedir = () => home;
  process.env.APPDATA = env.APPDATA;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;

  try {
    fs.mkdirSync(foreignRoot, { recursive: true });
    const watchPaths = watchPathsForClients('cherrystudio');
    assert.equal(watchPaths.includes(foreignRoot), false);
    assert.deepEqual(watchPaths, []);
    const checks = clientSourceChecks('cherrystudio');
    assert.deepEqual(checks.cherrystudio, [{ id: 'cherrystudio-transcripts', exists: false }]);
    const health = deriveClientHealth('cherrystudio', { clients: {} }, { sourceChecks: checks });
    assert.equal(health.clients.cherrystudio.source.state, 'missing');
  } finally {
    os.homedir = originalHomedir;
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
