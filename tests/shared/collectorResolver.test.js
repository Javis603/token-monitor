'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { kimiWorkSessionsRoots, readTokscaleBundledBuild } = require('../../src/shared/collector');

test('bundled build describes the manifest rather than executable bytes', () => {
  const manifest = { mode: 'override', commit: 'a'.repeat(40), releaseTag: 'token-monitor-test' };
  assert.deepEqual(readTokscaleBundledBuild(manifest), { commit: manifest.commit, releaseTag: manifest.releaseTag });
  assert.deepEqual(readTokscaleBundledBuild({ ...manifest, mode: undefined }), readTokscaleBundledBuild(manifest));
  assert.deepEqual(readTokscaleBundledBuild({ ...manifest, mode: null }), readTokscaleBundledBuild(manifest));
  for (const invalid of [null, {}, { ...manifest, mode: 'upstream' }, { ...manifest, mode: 'typo' }, { ...manifest, commit: '' }, { ...manifest, releaseTag: '' }]) {
    assert.equal(readTokscaleBundledBuild(invalid), null);
  }
});

test('status keeps runtime selection separate from declared bundled build', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared/collector.js'), 'utf8');
  const body = source.slice(source.indexOf('function getTokscaleStatus()'), source.indexOf('// Tokscale reads a few XDG'));
  const current = { source: 'shim', version: null, path: '/tmp/tokscale/bin.js' };
  const build = { commit: 'a'.repeat(40), releaseTag: 'token-monitor-test' };
  const status = vm.runInNewContext(`${body}\ngetTokscaleStatus()`, {
    bundledPackageCandidates: () => ['@tokscale/cli-linux-x64-gnu'],
    resolvePlatformBinary: () => current,
    readTokscaleBundledBuild: () => build
  });
  assert.equal(status.supported, true);
  assert.equal(status.current.source, 'shim');
  assert.equal(status.current.version, null);
  assert.equal(status.bundledBuild, build);
});

test('kimiWorkSessionsRoots mirrors platform paths and relocated Windows shares', () => {
  const home = '/tmp/token-monitor-home';
  const workSuffix = path.join('kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home', 'sessions');
  const homeAppData = path.join(home, 'AppData', 'Roaming');
  const envAppData = 'C:\\Users\\tester\\AppData\\Roaming';
  assert.deepEqual(kimiWorkSessionsRoots(home, 'darwin'), [path.join(home, 'Library', 'Application Support', workSuffix)]);
  assert.deepEqual(kimiWorkSessionsRoots(home, 'win32', { APPDATA: envAppData }), [
    path.join(homeAppData, workSuffix),
    path.join(envAppData, workSuffix)
  ]);
  assert.deepEqual(kimiWorkSessionsRoots(home, 'win32', {}), [
    path.join(homeAppData, workSuffix)
  ]);
  assert.deepEqual(kimiWorkSessionsRoots(home, 'win32', { APPDATA: '' }), [
    path.join(homeAppData, workSuffix)
  ]);
  assert.deepEqual(kimiWorkSessionsRoots(home, 'win32', { APPDATA: '   ' }), [
    path.join(homeAppData, workSuffix),
    path.join('   ', workSuffix)
  ]);
  assert.deepEqual(kimiWorkSessionsRoots(home, 'win32', { APPDATA: envAppData }, { useEnvRoots: false }), [
    path.join(homeAppData, workSuffix)
  ]);
  assert.deepEqual(
    kimiWorkSessionsRoots(home, 'win32', { APPDATA: envAppData }, {
      readFileSync: () => JSON.stringify({ shareDir: 'D:\\KimiShare' })
    }),
    [path.join(homeAppData, workSuffix), path.join('D:\\KimiShare', 'daimon', 'runtime', 'kimi-code', 'home', 'sessions')]
  );
  assert.deepEqual(kimiWorkSessionsRoots(home, 'linux'), []);
});
