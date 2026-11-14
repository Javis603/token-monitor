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

test('Qoder is default-tracked and a moved international root invalidates its anchor', () => {
  assert.ok(KNOWN_CLIENTS.split(',').includes('qoder'));
  assert.ok(DEFAULT_CLIENTS.split(',').includes('qoder'));
  assert.ok(DEFAULT_CLIENTS.split(',').includes('qodercn'));
  const fingerprint = (clients, root) => configFingerprint(clients, '', true, null, 'pricing', {
    homeDir: path.resolve('/qoder-fixture'), platform: 'linux', env: { QODER_CONFIG_DIR: root }
  });
  assert.notEqual(fingerprint('qoder', '/first'), fingerprint('qoder', '/second'));
  assert.equal(fingerprint('codex', '/first'), fingerprint('codex', '/second'));
});

test('Qoder disjoint reasoning closes period, session and history token totals', () => {
  const { extractUsageFromTokscale } = require('../../src/shared/usage');
  const { parseGraphResult } = require('../../src/shared/history');
  for (const client of ['qoder', 'qodercn']) {
    const row = { client, session: 'reasoning-session', model: 'gemini-2.5-pro', input: 60, cacheRead: 40, output: 20, reasoning: 10,
      performance: { timedTokens: 130, timedOutputTokens: 20, timedReasoningTokens: 10, totalDurationMs: 1000 } };
    const period = extractUsageFromTokscale({ entries: [row] });
    assert.equal(period.totalTokens, 130, client);
    assert.equal(period.outputTokens, 30, client);
    assert.equal(period.timedOutputTokens, 30, client);
    const session = Object.values(period.sessions)[0];
    assert.equal(session.totalTokens, 130, client);
    assert.equal(session.outputTokens, 30, client);
    assert.equal(session.reasoningTokens, 10, client);
    const graph = parseGraphResult({ contributions: [{ date: '2026-11-11', clients: [{ client, modelId: row.model, tokens: row }] }] });
    assert.equal(graph.contributions[0].tokens, 130, client);
    assert.equal(graph.contributions[0].outputTokens, 30, client);
    assert.equal(extractUsageFromTokscale({ entries: [{ ...row, totalTokens: 130 }] }).totalTokens, 130, client);
  }
});
