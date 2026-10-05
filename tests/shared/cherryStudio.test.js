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
  watchPathsForClients,
  watchIgnoreMatcher
} = require('../../src/shared/collector');
const { parseGraphResult } = require('../../src/shared/history');
const { normalizeClientName, extractUsageFromTokscale } = require('../../src/shared/usage');

test('normalizeClientName maps Cherry Studio sources to cherrystudio', () => {
  assert.equal(normalizeClientName('cherrystudio'), 'cherrystudio');
  assert.equal(normalizeClientName('Cherry Studio'), 'cherrystudio');
  assert.equal(normalizeClientName('cherry-studio'), 'cherrystudio');
  assert.equal(normalizeClientName('cherry_studio'), 'cherrystudio');
});

test('Cherry Studio roots mirror tokscale AppData resolution per platform', () => {
  const home = path.join(os.tmpdir(), 'cherrystudio-path-home');
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
    },
    {
      platform: 'linux',
      env: { XDG_CONFIG_HOME: path.join('relative', 'custom-xdg') },
      base: path.join(home, '.config')
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
      [...expected.map(([id, dir]) => ({ id, dir })), {
        id: 'cherrystudio-db',
        dir: path.join(base, 'CherryStudio', 'Data'),
        sourcePath: path.join(base, 'CherryStudio', 'Data', 'cherrystudio.sqlite')
      }]
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

    const dataDir = path.join(appData, 'CherryStudio', 'Data');
    assert.deepEqual(roots, [...expected.map((dir) => ({ id: 'cherrystudio-transcripts', dir })), {
      id: 'cherrystudio-db', dir: dataDir, sourcePath: path.join(dataDir, 'cherrystudio.sqlite')
    }]);
    assert.deepEqual(clientWatchCandidates('cherrystudio').cherrystudio, [...expected, dataDir]);

    const assertSourceState = (existingRoots) => {
      for (const dir of existingRoots) fs.mkdirSync(dir, { recursive: true });
      try {
        assert.deepEqual(watchPathsForClients('cherrystudio').sort(), [...existingRoots, ...(fs.existsSync(dataDir) ? [dataDir] : [])].sort());
        const checks = clientSourceChecks('cherrystudio');
        assert.deepEqual(checks.cherrystudio, [{ id: 'cherrystudio-transcripts', exists: true }, { id: 'cherrystudio-db', exists: false }]);
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
    assert.deepEqual(checks.cherrystudio, [{ id: 'cherrystudio-transcripts', exists: false }, { id: 'cherrystudio-db', exists: false }]);
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


test('Cherry Studio chat database and WAL refresh usage without watching unrelated app data', () => {
  // Windows runners expose an 8.3 tmp path; the matcher canonicalizes roots.
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'cherrystudio-ledger-'));
  const options = { homeDir: home, platform: 'linux', env: {} };
  const dataDir = path.join(home, '.config', 'CherryStudio', 'Data');
  const db = path.join(dataDir, 'cherrystudio.sqlite');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const missing = clientSourceChecks('cherrystudio', options).cherrystudio;
    assert.equal(missing.find((check) => check.id === 'cherrystudio-db').exists, false);
    fs.writeFileSync(db, 'fixture');
    const checks = clientSourceChecks('cherrystudio', options);
    assert.equal(checks.cherrystudio.find((check) => check.id === 'cherrystudio-db').exists, true);
    assert.equal(deriveClientHealth('cherrystudio', { clients: {} }, { sourceChecks: checks }).clients.cherrystudio.source.state, 'detected');
    assert.deepEqual(watchPathsForClients('cherrystudio', options), [dataDir]);
    const ignored = watchIgnoreMatcher('cherrystudio', options);
    for (const file of [db, db + '-wal', db + '-shm']) assert.equal(ignored(file), false);
    for (const file of ['attachments', 'unrelated.sqlite', 'other/nested.jsonl']) {
      assert.equal(ignored(path.join(dataDir, file)), true);
    }
    const transcript = path.join(dataDir, 'Agents', '.claude', 'projects', 'project', 'session.jsonl');
    assert.equal(ignored(transcript), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test('Cherry Studio disjoint reasoning closes both usage and history totals', () => {
  const row = { client: 'cherrystudio', model: 'glm-5.2', sessionId: 'zai', input: 620, output: 280, cacheRead: 500, cacheWrite: 80, reasoning: 60 };
  const period = extractUsageFromTokscale({ entries: [row] });
  assert.equal(period.totalTokens, 1540);
  assert.equal(period.outputTokens, 340);
  const history = parseGraphResult({ contributions: [{ date: '2026-10-05', clients: [{ client: row.client, modelId: row.model, tokens: row }] }] });
  assert.equal(history.contributions[0].tokens, period.totalTokens);
  assert.equal(history.contributions[0].outputTokens, period.outputTokens);
});
