'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { decideResolver, kimiWorkSessionsRoots } = require('../../src/shared/collector');

test('decideResolver prefers downloaded binary only when it is newer than bundled', () => {
  const bundled = { source: 'bundled', version: '2.1.3', path: '/bundled/tokscale' };
  const downloaded = { source: 'downloaded', version: '2.3.0', path: '/downloaded/tokscale' };

  assert.equal(decideResolver({ downloaded, bundled }), downloaded);
});

test('decideResolver keeps bundled as floor when bundled is same or newer', () => {
  const bundled = { source: 'bundled', version: '2.5.0', path: '/bundled/tokscale' };
  const downloaded = { source: 'downloaded', version: '2.3.0', path: '/downloaded/tokscale' };

  assert.equal(decideResolver({ downloaded, bundled }), bundled);
  assert.equal(decideResolver({ downloaded: { ...downloaded, version: '2.5.0' }, bundled }), bundled);
});

test('decideResolver falls back to JS shim when no bundled binary exists', () => {
  const shim = { source: 'shim', version: '2.1.3', path: '/shim/bin.js' };

  assert.equal(decideResolver({ downloaded: null, bundled: null, shim }), shim);
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
