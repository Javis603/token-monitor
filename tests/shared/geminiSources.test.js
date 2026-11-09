'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { clientSourceRoots } = require('../../src/shared/clientSources');
const { SOURCE_MARKERS } = require('../../src/shared/clientSourceRegistration');
const { clientsCsvForSetting } = require('../../src/shared/clientTracking');
const { clientsForWatchPath, clientWatchCandidates } = require('../../src/shared/collector');
const { extractUsageFromTokscale, normalizeClientName } = require('../../src/shared/usage');
const { sumOutputTokens, sumTokens } = require('../../src/shared/history');

test('Gemini CLI source follows GEMINI_CLI_HOME and stays off the Antigravity roots', () => {
  const homeDir = '/Users/tm/profile';
  const fallback = path.join(homeDir, '.gemini', 'tmp');
  const roots = clientSourceRoots('gemini,antigravity', { homeDir, env: {} });
  assert.deepEqual(roots.gemini.map(({ id, dir }) => [id, dir]), [['gemini-sessions', fallback]]);
  assert.equal(
    clientSourceRoots('gemini', { homeDir, env: { GEMINI_CLI_HOME: '   ' } }).gemini[0].dir,
    fallback
  );
  assert.equal(
    clientSourceRoots('gemini', { homeDir, env: { GEMINI_CLI_HOME: '/custom/gemini' } }).gemini[0].dir,
    path.join('/custom/gemini', 'tmp')
  );
  assert.equal(
    clientSourceRoots('gemini', {
      homeDir,
      platform: 'win32',
      env: { HOME: 'D:\\tokscale-home' }
    }).gemini[0].dir,
    path.join('D:\\tokscale-home', '.gemini', 'tmp')
  );

  const antigravityDirs = roots.antigravity.map(({ dir }) => dir);
  assert.ok(antigravityDirs.every((dir) => !dir.endsWith(`${path.sep}tmp`) && !dir.includes(`${path.sep}tmp${path.sep}`)));
  assert.equal(clientSourceRoots('antigravity', { homeDir, env: {} }).gemini, undefined);

  const marker = SOURCE_MARKERS.find((entry) => entry.client === 'gemini');
  assert.deepEqual(marker, { marker: '.gemini/tmp', client: 'gemini' });
  assert.equal(Object.hasOwn(marker, 'hostCheckId'), false);

  const watched = clientWatchCandidates('gemini,antigravity', { homeDir, env: {} });
  const session = path.join(watched.gemini[0], 'contract', 'chats', 'session-gemini-contract.json');
  const antigravityDb = path.join(homeDir, '.gemini', 'antigravity', 'conversations', 'chat.db');
  assert.deepEqual(clientsForWatchPath(session, watched), ['gemini']);
  assert.deepEqual(clientsForWatchPath(antigravityDb, watched), ['antigravity']);
});

test('a saved tool selection does not gain Gemini, and names stay distinct from Antigravity', () => {
  assert.equal(clientsCsvForSetting('claude,codex'), 'claude,codex');
  assert.equal(clientsCsvForSetting(undefined).split(',').includes('gemini'), true);
  assert.equal(normalizeClientName('gemini'), 'gemini');
  assert.equal(normalizeClientName('Gemini CLI'), 'gemini');
  assert.equal(normalizeClientName('antigravity'), 'antigravity');
  assert.equal(normalizeClientName('antigravity-cli'), 'antigravity');
});

test('Gemini thoughts stay additive in live totals and History', () => {
  const row = {
    client: 'gemini',
    sessionId: 'session-gemini-contract',
    model: 'gemini-3.1-pro-preview',
    input: 19,
    output: 2,
    cacheRead: 5,
    cacheWrite: 0,
    reasoning: 3
  };
  const usage = extractUsageFromTokscale({ entries: [row] });
  assert.equal(usage.totalTokens, 29);
  assert.equal(usage.clients.gemini, 29);
  assert.equal(usage.clientOutputs.gemini, 5);
  assert.equal(usage.sessions['gemini:session-gemini-contract'].totalTokens, 29);
  assert.equal(sumTokens(row, 'gemini'), 29);
  assert.equal(sumOutputTokens(row, 'gemini'), 5);
});
