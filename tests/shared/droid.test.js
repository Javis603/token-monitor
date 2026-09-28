'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  clientSourceChecks,
  clientSourceRoots,
  clientWatchCandidates,
  deriveClientHealth,
  watchPathsForClients
} = require('../../src/shared/collector');
const { CLIENT_LABELS } = require('../../src/shared/clientCatalog');
const { CUSTOM_SCAN_CLIENT_IDS, tokscaleExtraDirsEnv } = require('../../src/shared/customScanPaths');
const { parseGraphResult } = require('../../src/shared/history');
const { extractUsageFromTokscale, normalizeClientName } = require('../../src/shared/usage');
const { homeHasData } = require('../../src/shared/wslUsage');

test('Factory Droid keeps the canonical droid id without matching Android clients', () => {
  assert.equal(CLIENT_LABELS.droid, 'Factory Droid');
  assert.equal(normalizeClientName('Droid'), 'droid');
  assert.equal(normalizeClientName('android'), 'android');
  assert.equal(normalizeClientName('android-studio'), 'android-studio');
});

test('Droid sessions feed the home-relative source, watcher, and health paths', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-home-'));
  const sessions = path.join(home, '.factory', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  try {
    const options = { homeDir: home, env: {}, platform: process.platform };
    assert.deepEqual(clientSourceRoots('droid', options).droid, [
      { id: 'droid-sessions', dir: sessions }
    ]);
    assert.deepEqual(clientWatchCandidates('droid', options).droid, [sessions]);
    assert.deepEqual(watchPathsForClients('droid', options), [sessions]);
    const checks = clientSourceChecks('droid', options);
    assert.deepEqual(checks.droid, [{ id: 'droid-sessions', exists: true }]);
    assert.equal(deriveClientHealth('droid', { clients: {} }, { sourceChecks: checks }).clients.droid.source.state, 'detected');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Droid supports custom Tokscale roots and WSL discovery', () => {
  assert.equal(CUSTOM_SCAN_CLIENT_IDS.includes('droid'), true);
  assert.equal(
    tokscaleExtraDirsEnv({ droid: ['/var/data/droid'] }, '', { platform: 'linux' }),
    'droid:/var/data/droid'
  );
  const home = String.raw`\\wsl$\Ubuntu\home\u`;
  assert.deepEqual(
    homeHasData(home, (candidate) => candidate === `${home}\\.factory\\sessions`),
    ['droid']
  );
});

test('Droid usage keeps Tokscale token categories and session attribution', () => {
  const period = extractUsageFromTokscale({
    groupBy: 'client,session,model',
    entries: [{
      client: 'droid',
      model: 'claude-sonnet-4-5',
      sessionId: 'session-1',
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 10,
      totalTokens: 160
    }]
  });
  assert.equal(period.totalTokens, 160);
  assert.equal(period.clients.droid, 160);
  assert.equal(period.clientOutputs.droid, 20);
  assert.equal(period.clientCacheReads.droid, 30);
  assert.equal(period.clientCacheWrites.droid, 10);
  assert.equal(period.sessions['droid:session-1'].client, 'droid');
});

test('Droid usage folds disjoint thinking tokens into public output', () => {
  const period = extractUsageFromTokscale({
    groupBy: 'client,session,model',
    entries: [{
      client: 'droid',
      model: 'claude-sonnet-4-5',
      sessionId: 'session-reasoning',
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 10,
      reasoning: 7,
      totalTokens: 167
    }]
  });

  assert.equal(period.totalTokens, 167);
  assert.equal(period.outputTokens, 27);
  assert.equal(period.clientOutputs.droid, 27);
  assert.equal(period.sessions['droid:session-reasoning'].outputTokens, 27);
  assert.equal(period.sessions['droid:session-reasoning'].reasoningTokens, 7);
});

test('Droid graph history includes disjoint thinking tokens', () => {
  const parsed = parseGraphResult({
    contributions: [{
      date: '2026-09-13',
      clients: [{
        client: 'droid',
        modelId: 'claude-sonnet-4-5',
        tokens: {
          input: 100,
          output: 20,
          cacheRead: 30,
          cacheWrite: 10,
          reasoning: 7
        }
      }]
    }]
  });
  const day = parsed.contributions[0];

  assert.equal(day.tokens, 167);
  assert.equal(day.outputTokens, 27);
  assert.equal(day.perClient.droid.tokens, 167);
  assert.equal(day.perClient.droid.outputTokens, 27);
  assert.equal(day.perModel['claude-sonnet-4-5'].tokens, 167);
  assert.equal(day.perModel['claude-sonnet-4-5'].outputTokens, 27);
});
