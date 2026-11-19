'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { extractUsageFromTokscale } = require('../../src/shared/usage');

test('entry context occupancy reaches the normalized session', () => {
  const period = extractUsageFromTokscale({
    entries: [{
      client: 'qoder',
      sessionId: 'session-context',
      model: 'DeepSeek-V4.1-Flash 1024',
      input: 120,
      output: 30,
      cacheRead: 980,
      cost: 0.02,
      messageCount: 2,
      contextTokens: 1_100,
      contextWindow: 1_000_000,
      startedAt: '2026-11-19T03:00:00.000Z',
      lastUsedAt: '2026-11-19T03:10:00.000Z'
    }]
  });

  assert.equal(period.sessions['qoder:session-context'].contextTokens, 1100);
  assert.equal(period.sessions['qoder:session-context'].contextWindow, 1000000);
});

test('entry context is optional and a missing pair stays zero', () => {
  const period = extractUsageFromTokscale({
    entries: [{
      client: 'qoder',
      sessionId: 'session-no-context',
      model: 'DeepSeek-V4.1-Flash 1024',
      input: 10,
      output: 5,
      cost: 0.01,
      messageCount: 1,
      startedAt: '2026-11-19T03:00:00.000Z',
      lastUsedAt: '2026-11-19T03:01:00.000Z'
    }]
  });

  assert.equal(period.sessions['qoder:session-no-context'].contextTokens, 0);
  assert.equal(period.sessions['qoder:session-no-context'].contextWindow, 0);
});
