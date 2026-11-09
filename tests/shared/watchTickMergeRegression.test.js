'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const usage = require('../../src/shared/usage');
const merge = usage.mergeNormalizedPeriods || usage.mergePeriods;

test('overlapping archived overlay cannot archive a live host session', () => {
  const row = { client: 'claude', sessionId: 's', totalTokens: 10, models: { m: 10 } };
  const base = usage.normalizePeriod({ totalTokens: 10, sessions: { 'claude:s': row } });
  const overlay = usage.normalizePeriod({ totalTokens: 10, sessions: { 'claude:s': { ...row, archived: true } } });
  for (const host of [base, usage.applyPeriodDelta(base, usage.emptyPeriod(), usage.emptyPeriod())]) {
    const result = merge(host, overlay);
    assert.deepEqual(result, usage.mergePeriods(host, overlay));
    assert.notEqual(result.sessions['claude:s'].archived, true);
  }
});

test('negative cost-only overlay is retained', () => {
  const overlay = usage.emptyPeriod();
  overlay.costUsd = -1;
  assert.equal(merge(usage.emptyPeriod(), overlay).costUsd, -1);
});

test('watch Today normalizes freshly decorated session text', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-1349-home-'));
  const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
  const now = '2026-11-08T12:00:00.000Z';
  const options = {
    clients: 'claude', allTimeSince: '2025-01-01', deviceId: 'fixture',
    homeDir: home, env: {}, now, limitsEnabled: false, codexLocalUsageEnabled: false,
    wslScanEnabled: false,
    sessionMetadataDeps: {
      sessionMetadataResolvers: new Map([['claude', { resolve: () => new Map([
        ['s', { title: '  hello   world  ', projectId: 'p', projectLabel: '  My Proj  ' }]
      ]) }]])
    },
    runTokscale: async () => ({ entries: [{ client: 'claude', sessionId: 's', model: 'm', input: 10 }] })
  };
  try {
    const anchor = { dateKey: localTodayKey(new Date(now)), today: usage.emptyPeriod(), month: usage.emptyPeriod(), allTime: usage.emptyPeriod() };
    const result = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor });
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(result[name].sessions['claude:s'].title, 'hello world');
      assert.equal(result[name].sessions['claude:s'].projectLabel, 'My Proj');
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
