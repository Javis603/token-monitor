'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { pidFilePath, sharedDataDir } = require('../../src/shared/config');

test('sharedDataDir uses TOKEN_MONITOR_SHARED_DIR override', () => {
  const previous = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = path.join(os.tmpdir(), 'token-monitor-test');
  try {
    assert.equal(sharedDataDir(), process.env.TOKEN_MONITOR_SHARED_DIR);
    assert.equal(pidFilePath(), path.join(process.env.TOKEN_MONITOR_SHARED_DIR, 'agent.pid'));
  } finally {
    if (previous === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = previous;
  }
});

test('sharedDataDir follows Electron userData-compatible platform paths', () => {
  const home = path.join(path.sep, 'Users', 'javis');
  assert.equal(
    sharedDataDir({ platform: 'darwin', homeDir: home, env: {} }),
    path.join(home, 'Library', 'Application Support', 'Token Monitor')
  );
  assert.equal(
    sharedDataDir({ platform: 'win32', homeDir: home, env: { APPDATA: 'C:\\Users\\javis\\AppData\\Roaming' } }),
    path.join('C:\\Users\\javis\\AppData\\Roaming', 'Token Monitor')
  );
  assert.equal(
    sharedDataDir({ platform: 'linux', homeDir: home, env: { XDG_CONFIG_HOME: '/tmp/config' } }),
    path.join('/tmp/config', 'Token Monitor')
  );
});
