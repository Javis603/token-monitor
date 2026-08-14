'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
const { resetDshFileCache } = require('../../src/shared/dshUsage');

function writeDshSession(root, sessionId, time, usage) {
  const dir = path.join(root, 'proj', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), [
    JSON.stringify({ type: 'session', version: 0, id: sessionId, createdAt: time, cwd: '/work/project', delegationDepth: 0 }),
    JSON.stringify({
      type: 'assistant/message',
      seq: 0,
      time,
      data: {
        turn: 1,
        step: 1,
        content: [{ type: 'text', text: 'ok' }],
        provenance: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        usage
      }
    })
  ].join('\n') + '\n');
}

function pricingLookup(modelId) {
  if (modelId === 'deepseek-v4-flash') {
    return Promise.resolve({
      pricing: {
        inputCostPerToken: 0.0000003,
        outputCostPerToken: 0.000001,
        cacheReadInputTokenCost: 0.0000001,
        cacheCreationInputTokenCost: 0.000001
      }
    });
  }
  return Promise.reject(new Error(`no price for ${modelId}`));
}

test('collectUsageOnce merges dsh usage into periods, partitions, and history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-collector-'));
  const now = new Date('2026-08-15T12:00:00Z');
  writeDshSession(root, 'session-a', Date.parse('2026-08-15T08:00:00Z'), {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 20,
    reasoningTokens: 3
  });
  resetDshFileCache();
  let captured = null;
  const summary = await collectUsageOnce({
    clients: 'dsh',
    allTimeSince: '2024-01-01',
    deviceId: 'dsh-test',
    now,
    dshRoots: [root],
    projectsEnabled: true,
    historyEnabled: true,
    includeHistory: true,
    lookupModelPricing: pricingLookup,
    pricingRevision: 0,
    runTokscale: async () => { throw new Error('tokscale must not run for dsh'); },
    onAnchorComputed: (anchor) => { captured = anchor; }
  });
  assert.equal(summary.today.totalTokens, 35);
  assert.equal(summary.today.cacheReadTokens, 20);
  assert.equal(summary.today.clients.dsh, 35);
  assert.equal(summary.month.totalTokens, 35);
  assert.equal(summary.allTime.totalTokens, 35);
  assert.deepEqual(summary.trackedClients, ['dsh']);
  assert.ok(summary.today.sessions['dsh:session-a']);
  assert.equal(summary.today.sessions['dsh:session-a'].projectLabel, 'project');
  assert.ok(Math.abs(summary.today.costUsd - (10 * 0.0000003 + 5 * 0.000001 + 20 * 0.0000001)) < 1e-12);
  assert.ok(captured.todayPartitions.dsh);
  assert.equal(summary.history.daily[0].perClient.dsh.tokens, 35);

  // A targeted watch tick must refresh only the dsh partition and derive
  // month/allTime through the exact delta.
  const appendFile = path.join(root, 'proj', 'session-a', 'session.jsonl');
  fs.appendFileSync(appendFile, `${JSON.stringify({
    type: 'assistant/message',
    seq: 1,
    time: Date.parse('2026-08-15T09:00:00Z'),
    data: {
      turn: 2,
      step: 1,
      content: [{ type: 'text', text: 'again' }],
      provenance: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      usage: { inputTokens: 100, outputTokens: 50 }
    }
  })}\n`);
  const warm = await collectUsageOnce({
    clients: 'dsh',
    allTimeSince: '2024-01-01',
    deviceId: 'dsh-test',
    now,
    dshRoots: [root],
    projectsEnabled: true,
    lookupModelPricing: pricingLookup,
    pricingRevision: 0,
    targetClients: 'dsh',
    todayOnlyAnchor: {
      dateKey: localTodayKey(now),
      today: captured.windowsPeriods.today,
      month: captured.windowsPeriods.month,
      allTime: captured.windowsPeriods.allTime,
      todayPartitions: captured.todayPartitions
    }
  });
  assert.equal(warm.today.totalTokens, 185);
  assert.equal(warm.month.totalTokens, 185);
  assert.equal(warm.allTime.totalTokens, 185);
  resetDshFileCache();
});

test('collectUsageOnce leaves dsh out when it is not tracked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-collector-'));
  const now = new Date('2026-08-15T12:00:00Z');
  writeDshSession(root, 'session-b', Date.parse('2026-08-15T08:00:00Z'), {
    inputTokens: 10,
    outputTokens: 5
  });
  resetDshFileCache();
  const summary = await collectUsageOnce({
    clients: 'claude',
    allTimeSince: '2024-01-01',
    deviceId: 'dsh-test',
    now,
    dshRoots: [root],
    runTokscale: async () => ({ entries: [] })
  });
  assert.equal(summary.today.totalTokens, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(summary.today.clients, 'dsh'), false);
  resetDshFileCache();
});
