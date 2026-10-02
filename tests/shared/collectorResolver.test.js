'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { kimiWorkSessionsRoots, readTokscaleBuild } = require('../../src/shared/collector');

test('readTokscaleBuild trusts the fork marker only while its hash still matches the binary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-build-marker-'));
  const binPath = path.join(dir, 'tokscale');
  const fork = Buffer.from('fork binary AAAA');
  try {
    fs.writeFileSync(binPath, fork);
    assert.equal(readTokscaleBuild(binPath), null);

    const marker = {
      releaseTag: 'token-monitor-ab1067f3',
      commit: 'ab1067f38edda3faa822c67b6df016c5c38ded9b',
      sha256: crypto.createHash('sha256').update(fork).digest('hex'),
      size: fork.length
    };
    fs.writeFileSync(`${binPath}.build.json`, JSON.stringify(marker));
    assert.deepEqual(readTokscaleBuild(binPath), { releaseTag: marker.releaseTag, commit: marker.commit });

    // npm put an upstream binary of exactly the same size back without
    // clearing the marker; only the hash tells them apart.
    const upstream = Buffer.from('fork binary BBBB');
    assert.equal(upstream.length, fork.length);
    fs.writeFileSync(binPath, upstream);
    fs.utimesSync(binPath, new Date(), new Date(Date.now() + 60_000));
    assert.equal(readTokscaleBuild(binPath), null);

    fs.writeFileSync(binPath, 'upstream release binary');
    assert.equal(readTokscaleBuild(binPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
