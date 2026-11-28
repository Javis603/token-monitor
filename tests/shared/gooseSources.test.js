'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { clientSourceRoots, clientSourceChecks, clientWatchCandidates, watchIgnoreMatcher,
  clientsForWatchPath, deriveClientHealth, isSelfWatchSqliteSidecarEvent,
  tokscaleCommand, watchPathsForClients } = require('../../src/shared/collector');
const { CUSTOM_SCAN_CLIENT_IDS, normalizeCustomScanPaths, tokscaleExtraDirsEnv } = require('../../src/shared/customScanPaths');
const { CLIENT_CATALOG } = require('../../src/shared/clientCatalog');
const { normalizeClientName } = require('../../src/shared/usage');
const { normalizeClientHealth } = require('../../src/shared/clientHealth');
const { MARKER_CLIENTS } = require('../../src/shared/clientSourceRegistration');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

installSourceEnvGuard(test);

test('Goose is upstream parsed, default tracked, partition safe and refuses custom paths', () => {
  assert.deepEqual(CLIENT_CATALOG.find(({ id }) => id === 'goose'), {
    id: 'goose', label: 'Goose', defaultTracked: true, forkOnly: false, locallyParsed: false
  });
  assert.equal(normalizeClientName('Goose'), 'goose');
  assert.equal(CUSTOM_SCAN_CLIENT_IDS.includes('goose'), false);
  assert.deepEqual(normalizeCustomScanPaths({ goose: ['/tmp/goose-extra'] }), {});
  assert.equal(tokscaleExtraDirsEnv({ goose: ['/tmp/goose-extra'] }), '');
  for (const marker of ['.local/share/goose/sessions/sessions.db', '.local/share/Block/goose/sessions/sessions.db']) {
    assert.equal(MARKER_CLIENTS[marker], 'goose');
  }
});

test('Goose absolute override is raw and authoritative even before its DB exists', (t) => {
  const homeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tm-goose-override-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const custom = path.join(homeDir, 'custom');
  const fallback = path.join(homeDir, '.local', 'share', 'goose', 'sessions', 'sessions.db');
  fs.mkdirSync(path.dirname(fallback), { recursive: true });
  fs.writeFileSync(fallback, '');
  const options = { homeDir, env: { GOOSE_PATH_ROOT: custom } };
  const file = path.join(custom, 'data', 'sessions', 'sessions.db');
  assert.deepEqual(clientSourceRoots('goose', options).goose.map(({ sourcePath }) => sourcePath), [file]);
  assert.deepEqual(clientSourceChecks('goose', options).goose, [{ id: 'goose-db', exists: false }]);
  assert.equal(watchIgnoreMatcher('goose', options)(file), false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  assert.deepEqual(clientSourceChecks('goose', options).goose, [{ id: 'goose-db', exists: true }]);
  for (const raw of ['relative-root', ` ${custom}`, '', '   ']) {
    assert.equal(clientSourceRoots('goose', { homeDir, platform: 'linux', env: { GOOSE_PATH_ROOT: raw } })
      .goose[0].sourcePath, fallback, raw);
  }
});

test('Goose defaults retain compatibility order and add native Windows discovery first', () => {
  const homeDir = path.resolve('/tmp/goose-home');
  const xdg = path.resolve('/tmp/goose-xdg');
  const appData = path.resolve('/tmp/goose-roaming');
  const compatibility = [
    path.join(xdg, 'goose', 'sessions', 'sessions.db'),
    path.join(homeDir, 'Library', 'Application Support', 'goose', 'sessions', 'sessions.db'),
    path.join(homeDir, 'Library', 'Application Support', 'Block', 'goose', 'sessions', 'sessions.db'),
    path.join(homeDir, '.local', 'share', 'Block', 'goose', 'sessions', 'sessions.db')
  ];
  for (const platform of ['darwin', 'linux', 'win32']) {
    const options = { homeDir, platform, env: { APPDATA: appData, XDG_DATA_HOME: xdg } };
    const roots = clientSourceRoots('goose', options).goose;
    assert.deepEqual(roots.map(({ sourcePath }) => sourcePath), [
      ...(platform === 'win32' ? [path.join(appData, 'Block', 'goose', 'data', 'sessions', 'sessions.db')] : []),
      ...compatibility
    ]);
    assert.deepEqual(clientWatchCandidates('goose', options).goose, roots.map(({ dir }) => dir));
  }
});

test('Goose Windows roaming fallback preserves native profile and Desktop HOME candidates', () => {
  const homeDir = path.resolve('/tmp/goose-profile');
  const nativeRoaming = path.resolve('/tmp/goose-known-roaming');
  const desktopHome = path.resolve('/tmp/goose-desktop-home');
  const windowsFolders = { profile: homeDir, roaming: nativeRoaming };
  const files = (env, folders = windowsFolders) => clientSourceRoots('goose', {
    homeDir, platform: 'win32', env, windowsFolders: folders
  }).goose.map(({ sourcePath }) => sourcePath);
  const native = path.join(nativeRoaming, 'Block', 'goose', 'data', 'sessions', 'sessions.db');
  const desktop = path.join(desktopHome, 'AppData', 'Roaming', 'Block', 'goose', 'data', 'sessions', 'sessions.db');
  assert.deepEqual(files({ HOME: desktopHome }).slice(0, 2), [native, desktop]);
  const explicit = path.resolve('/tmp/goose-explicit-appdata');
  const explicitFiles = files({ APPDATA: explicit, HOME: desktopHome });
  assert.equal(explicitFiles[0], path.join(explicit, 'Block', 'goose', 'data', 'sessions', 'sessions.db'));
  assert.equal(explicitFiles.includes(native), false);
  assert.equal(explicitFiles.includes(desktop), false);
  const synthesized = path.join(homeDir, 'AppData', 'Roaming', 'Block', 'goose', 'data', 'sessions', 'sessions.db');
  assert.equal(files({ APPDATA: '' }, {}).filter((file) => file === synthesized).length, 1);
  assert.equal(files({ HOME: 'relative-desktop' })[1],
    path.resolve('relative-desktop', 'AppData', 'Roaming', 'Block', 'goose', 'data', 'sessions', 'sessions.db'));
});

test('Goose health and watch roots match the actual command environment after blank XDG cleaning', (t) => {
  const homeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tm-goose-blank-xdg-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const file = path.join(homeDir, '.local', 'share', 'goose', 'sessions', 'sessions.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  for (const blank of ['', '   ', '\t\n']) {
    process.env.XDG_DATA_HOME = blank;
    const options = { homeDir, platform: 'linux', env: process.env };
    // Exercise the command used by both runTokscale and runTokscaleGraph,
    // rather than calling only the standalone env-cleaning helper.
    const command = tokscaleCommand({ homeDir });
    assert.equal(Object.hasOwn(command.env, 'XDG_DATA_HOME'), false);
    assert.equal(process.env.XDG_DATA_HOME, blank, 'command cleaning must not mutate the parent env');
    assert.equal(clientSourceRoots('goose', options).goose[0].sourcePath, file);
    assert.deepEqual(clientSourceRoots('goose', options).goose,
      clientSourceRoots('goose', { homeDir, platform: 'linux', env: command.env }).goose);
    const checks = clientSourceChecks('goose', options);
    assert.deepEqual(checks.goose, [{ id: 'goose-db', exists: true }]);
    assert.equal(deriveClientHealth('goose', null, { sourceChecks: checks }).clients.goose.source.state, 'detected');
    assert.deepEqual(watchPathsForClients('goose', options), [path.dirname(file)]);
    const ignored = watchIgnoreMatcher('goose', options);
    for (const suffix of ['', '-wal', '-shm']) assert.equal(ignored(file + suffix), false);
  }
});

test('Goose health needs the exact DB; watch admits only DB/WAL/SHM at each candidate', (t) => {
  const homeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tm-goose-sources-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const options = { homeDir, platform: 'linux', env: {} };
  const roots = clientSourceRoots('goose', options).goose;
  const ignored = watchIgnoreMatcher('goose', options);
  for (const root of roots) {
    fs.mkdirSync(root.dir, { recursive: true });
    for (const name of ['sessions.db', 'sessions.db-wal', 'sessions.db-shm']) {
      const file = path.join(root.dir, name);
      assert.equal(ignored(file), false);
      assert.deepEqual(clientsForWatchPath(file, { goose: [root.dir] }), ['goose']);
      assert.equal(isSelfWatchSqliteSidecarEvent(file, { goose: [root.dir] }), name === 'sessions.db-shm');
    }
    for (const name of ['config.yaml', 'auth.json', 'other.db', 'sessions.db.bak', 'nested/sessions.db']) {
      assert.equal(ignored(path.join(root.dir, name)), true, name);
    }
    fs.writeFileSync(`${root.sourcePath}-wal`, '');
  }
  assert.deepEqual(clientSourceChecks('goose', options).goose, [{ id: 'goose-db', exists: false }]);
  const missingHealth = deriveClientHealth('goose', null, { sourceChecks: clientSourceChecks('goose', options) });
  assert.deepEqual(normalizeClientHealth(missingHealth).clients.goose.source.checks, [{ id: 'goose-db', exists: false }]);
  const nativeWindows = path.join(homeDir, 'AppData', 'Roaming', 'Block', 'goose', 'data', 'sessions', 'sessions.db');
  fs.mkdirSync(path.dirname(nativeWindows), { recursive: true });
  fs.writeFileSync(nativeWindows, '');
  const legacyMac = path.join(homeDir, 'Library', 'Application Support', 'Block', 'goose', 'data', 'sessions', 'sessions.db');
  fs.mkdirSync(path.dirname(legacyMac), { recursive: true });
  fs.writeFileSync(legacyMac, '');
  assert.equal(clientSourceChecks('goose', options).goose[0].exists, false);
  fs.writeFileSync(roots[1].sourcePath, '');
  const checks = clientSourceChecks('goose', options);
  assert.deepEqual(checks.goose, [{ id: 'goose-db', exists: true }]);
  const health = deriveClientHealth('goose', null, { sourceChecks: checks });
  assert.equal(normalizeClientHealth(health).clients.goose.overall, 'waiting');
  assert.equal(normalizeClientHealth(health).clients.goose.source.detectedCount, 1);
});


test('Goose Windows DB appears in health and its DB/WAL/SHM watcher policy', (t) => {
  const homeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tm-goose-windows-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const appData = path.join(homeDir, 'roaming');
  const options = { homeDir, platform: 'win32', env: { APPDATA: appData } };
  const file = path.join(appData, 'Block', 'goose', 'data', 'sessions', 'sessions.db');
  const ignored = watchIgnoreMatcher('goose', options);
  assert.deepEqual(clientSourceChecks('goose', options).goose, [{ id: 'goose-db', exists: false }]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  assert.deepEqual(clientSourceChecks('goose', options).goose, [{ id: 'goose-db', exists: true }]);
  for (const suffix of ['', '-wal', '-shm']) assert.equal(ignored(file + suffix), false);
  assert.equal(ignored(path.join(path.dirname(file), 'nested/sessions.db')), true);
  assert.equal(ignored(path.join(path.dirname(file), 'credentials.json')), true);
});
