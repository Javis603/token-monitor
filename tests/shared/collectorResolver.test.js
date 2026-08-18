'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { decideResolver, kimiWorkSessionsRoot, kimiWorkScanEnv } = require('../../src/shared/collector');

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

test('kimiWorkSessionsRoot mirrors the verified platform paths', () => {
  const home = '/tmp/token-monitor-home';
  const workSuffix = path.join('kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home', 'sessions');
  assert.equal(kimiWorkSessionsRoot(home, 'darwin'), path.join(home, 'Library', 'Application Support', workSuffix));
  assert.equal(
    kimiWorkSessionsRoot(home, 'win32', { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }),
    path.join('C:\\Users\\tester\\AppData\\Roaming', workSuffix)
  );
  assert.equal(kimiWorkSessionsRoot(home, 'linux'), null);
});

test('kimiWorkScanEnv appends, preserves, and skips the Kimi Work root', () => {
  const home = '/tmp/token-monitor-home';
  const root = kimiWorkSessionsRoot(home, 'darwin');
  // Appends the root while keeping unrelated entries.
  const env = kimiWorkScanEnv('claude,kimi', [], { home, platform: 'darwin', env: { TOKSCALE_EXTRA_DIRS: 'claude:/tmp/claude' } });
  assert.deepEqual(env, { TOKSCALE_EXTRA_DIRS: `claude:/tmp/claude,kimi:${root}` });
  // Never duplicates an entry that is already present.
  const dup = kimiWorkScanEnv('kimi', [], { home, platform: 'darwin', env: { TOKSCALE_EXTRA_DIRS: `kimi:${root}` } });
  assert.deepEqual(dup, { TOKSCALE_EXTRA_DIRS: `kimi:${root}` });
  // No kimi client and explicit --home scans get nothing.
  assert.equal(kimiWorkScanEnv('claude', [], { home, platform: 'darwin', env: {} }), null);
  assert.equal(kimiWorkScanEnv('kimi', ['--today', '--home', '/tmp/wsl'], { home, platform: 'darwin', env: {} }), null);
});
