'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DSH_CLIENT,
  DSH_SOURCE_CHECK_ID,
  resolveDshHome,
  resolveDshSessionsDir
} = require('../../src/shared/providers/dsh/paths');
const {
  clientSourceChecks,
  clientSourceRoots,
  clientWatchCandidates,
  deriveClientHealth,
  watchPathsForClients
} = require('../../src/shared/collector');
const { normalizeClientName } = require('../../src/shared/usage');

test('DSH path resolution follows DSH_HOME then the home default', () => {
  assert.equal(DSH_CLIENT, 'dsh');
  assert.equal(DSH_SOURCE_CHECK_ID, 'dsh-sessions');
  assert.equal(resolveDshHome({ platform: 'darwin', homeDir: '/Users/alice', env: {} }), '/Users/alice/.dsh');
  assert.equal(resolveDshSessionsDir({ platform: 'linux', homeDir: '/home/alice', env: {} }), '/home/alice/.dsh/sessions');
  assert.equal(
    resolveDshSessionsDir({ platform: 'win32', homeDir: String.raw`C:\Users\alice`, env: {} }),
    String.raw`C:\Users\alice\.dsh\sessions`
  );
  assert.equal(
    resolveDshSessionsDir({ platform: 'linux', homeDir: '/home/alice', env: { DSH_HOME: '/srv/dsh' } }),
    '/srv/dsh/sessions'
  );
  // A whitespace-only DSH_HOME counts as unset, matching tokscale's env-root handling.
  assert.equal(
    resolveDshHome({ platform: 'linux', homeDir: '/home/alice', env: { DSH_HOME: '   ' } }),
    '/home/alice/.dsh'
  );
});

test('normalizeClientName maps DeepSeek Harness sources to the dsh client', () => {
  assert.equal(normalizeClientName('dsh'), 'dsh');
  assert.equal(normalizeClientName('DSH'), 'dsh');
  assert.equal(normalizeClientName('dsh-sessions'), 'dsh');
});

test('DSH sessions dir is shared by watcher and client health', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
  const previousDshHome = process.env.DSH_HOME;
  const originalHomedir = os.homedir;
  os.homedir = () => home;
  delete process.env.DSH_HOME;
  try {
    const sessionsDir = path.join(home, '.dsh', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const expected = [{ id: DSH_SOURCE_CHECK_ID, dir: sessionsDir }];
    assert.deepEqual(clientSourceRoots('dsh').dsh, expected);
    assert.deepEqual(clientWatchCandidates('dsh').dsh, [sessionsDir]);
    assert.deepEqual(watchPathsForClients('dsh'), [sessionsDir]);
    const checks = clientSourceChecks('dsh');
    assert.deepEqual(checks.dsh, [{ id: DSH_SOURCE_CHECK_ID, exists: true }]);
    const health = deriveClientHealth('dsh', { clients: {} }, { sourceChecks: checks });
    assert.equal(health.clients.dsh.source.state, 'detected');
    assert.equal(health.clients.dsh.overall, 'waiting');
  } finally {
    os.homedir = originalHomedir;
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
