'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { clientSourceRoots } = require('../../src/shared/clientSources');
const { clientWatchCandidates, configFingerprint, tokscaleClientFilter } = require('../../src/shared/collector');
const { DEFAULT_CLIENTS, KNOWN_CLIENTS } = require('../../src/shared/clientTracking');
const { normalizeClientName } = require('../../src/shared/usage');
const { MARKER_CLIENTS } = require('../../src/shared/clientSourceRegistration');

test('Qoder international and CN have independent roots and scan partitions', () => {
  const home = path.resolve('/qoder-fixture');
  const env = { QODER_CONFIG_DIR: path.join(home, 'global'), QODERCN_CONFIG_DIR: path.join(home, 'cn') };
  const options = { homeDir: home, platform: 'linux', env };
  const roots = clientSourceRoots('qoder,qodercn', options);
  assert.equal(roots.qoder[0].dir, path.join(home, 'global', 'projects'));
  assert.equal(roots.qodercn.find(root => root.id === 'qodercn-projects').dir, path.join(home, 'cn', 'projects'));
  assert.deepEqual(clientWatchCandidates('qoder', options), { qoder: [path.join(home, 'global', 'projects')] });
  assert.equal(tokscaleClientFilter('qoder'), 'qoder');
  assert.equal(tokscaleClientFilter('qodercn'), 'qodercn');
  assert.equal(normalizeClientName('qoder'), 'qoder');
  assert.equal(normalizeClientName('qoder-cn'), 'qodercn');
  assert.equal(MARKER_CLIENTS['.qoder/projects'], 'qoder');
});

test('Qoder is opt-in and a moved international root invalidates its anchor', () => {
  assert.ok(KNOWN_CLIENTS.split(',').includes('qoder'));
  assert.ok(!DEFAULT_CLIENTS.split(',').includes('qoder'));
  const fingerprint = (clients, root) => configFingerprint(clients, '', true, '', '', null, 'pricing', {
    homeDir: path.resolve('/qoder-fixture'), platform: 'linux', env: { QODER_CONFIG_DIR: root }
  });
  assert.notEqual(fingerprint('qoder', '/first'), fingerprint('qoder', '/second'));
  assert.equal(fingerprint('codex', '/first'), fingerprint('codex', '/second'));
});
