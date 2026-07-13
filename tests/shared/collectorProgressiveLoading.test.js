'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectUsageOnce } = require('../../src/shared/collector');
const { emptyPeriod } = require('../../src/shared/usage');

// Stub tokscale so the full scan returns controlled data per period.
let calls = 0;
async function sequentialTokscale() {
  calls += 1;
  if (calls === 1) {
    // --today
    return { entries: [{ client: 'claude', sessionId: 's1', model: 'claude-opus-4-8', input: 100, output: 5, cost: 1 }] };
  }
  if (calls === 2) {
    // --month
    return { entries: [
      { client: 'claude', sessionId: 's1', model: 'claude-opus-4-8', input: 500, output: 20, cost: 5 },
      { client: 'claude', sessionId: 's2', model: 'claude-sonnet-4-8', input: 200, output: 10, cost: 1 }
    ] };
  }
  // --since allTime
  return { entries: [
    { client: 'claude', sessionId: 's1', model: 'claude-opus-4-8', input: 2000, output: 90, cost: 20 },
    { client: 'claude', sessionId: 's2', model: 'claude-sonnet-4-8', input: 800, output: 40, cost: 4 }
  ] };
}

test('progressive loading fires onProgress after each period scan', async () => {
  calls = 0;
  const partials = [];
  const summary = await collectUsageOnce({
    clients: 'claude',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    historyEnabled: false,
    runTokscale: sequentialTokscale,
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    onProgress: (data) => partials.push({ ...data })
  });
  // First partial: today only
  assert.equal(partials.length, 2, 'should fire onProgress twice (today, month)');
  assert.equal(partials[0].today.totalTokens, 105, 'first partial should have today tokens');
  assert.equal(partials[0].month, undefined, 'first partial should not yet have month');
  assert.equal(partials[0].allTime, undefined, 'first partial should not yet have allTime');
  // No history or limits in partials — carryDeviceHistory contract
  assert.equal('history' in partials[0], false, 'partial must not have history key');
  assert.equal('limits' in partials[0], false, 'partial must not have limits key');
  // Second partial: today + month
  assert.equal(partials[1].today.totalTokens, 105, 'second partial should still have today');
  assert.equal(partials[1].month.totalTokens, 730, 'second partial should have month tokens');
  assert.equal(partials[1].allTime, undefined, 'second partial should not yet have allTime');
  assert.equal('history' in partials[1], false, 'second partial must not have history key');
  assert.equal('limits' in partials[1], false, 'second partial must not have limits key');
  // Final summary must include all periods
  assert.equal(summary.today.totalTokens, 105, 'final today');
  assert.equal(summary.month.totalTokens, 730, 'final month');
  assert.equal(summary.allTime.totalTokens, 2930, 'final allTime');
});

test('progressive previews include opaque project attribution', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-progress-project-'));
  try {
    const transcriptDir = path.join(home, '.claude', 'projects', 'repo');
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, 's1.jsonl'), `${JSON.stringify({ cwd: '/work/private-repo', timestamp: '2026-01-01T00:00:00Z' })}\n`);
    const partials = [];
    await collectUsageOnce({
      clients: 'claude', allTimeSince: '2025-01-01', deviceId: 'dev1', homeDir: home,
      limitsEnabled: false, historyEnabled: false,
      runTokscale: async () => ({ entries: [{ client: 'claude', sessionId: 's1', model: 'm', input: 1 }] }),
      collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
      onProgress: (value) => partials.push(value)
    });
    assert.match(partials[0].today.sessions['claude:s1'].projectId, /^sha256:/);
    assert.equal(partials[0].today.sessions['claude:s1'].projectLabel, 'private-repo');
    assert.equal(Object.hasOwn(partials[0].today.sessions['claude:s1'], 'projectPath'), false);
    assert.equal(partials[1].month.sessions['claude:s1'].projectLabel, 'private-repo');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('progressive project attribution resolves unchanged sessions once per tick', async () => {
  let metadataReads = 0;
  const partials = [];
  const summary = await collectUsageOnce({
    clients: 'opencode', allTimeSince: '2025-01-01', deviceId: 'dev1',
    limitsEnabled: false, historyEnabled: false,
    runTokscale: async () => ({ entries: [{ client: 'opencode', sessionId: 's1', model: 'm', input: 1 }] }),
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    sessionMetadataDeps: {
      readOpencodeMeta: (ids) => {
        metadataReads += 1;
        return new Map([...ids].map((id) => [id, { projectPath: '/work/project' }]));
      }
    },
    onProgress: (value) => partials.push(value)
  });
  assert.equal(metadataReads, 1);
  assert.equal(partials[0].today.sessions['opencode:s1'].projectLabel, 'project');
  assert.equal(summary.allTime.sessions['opencode:s1'].projectLabel, 'project');
});

test('final project attribution retries a transient progressive miss', async () => {
  let metadataReads = 0;
  const partials = [];
  const summary = await collectUsageOnce({
    clients: 'opencode', allTimeSince: '2025-01-01', deviceId: 'dev1',
    limitsEnabled: false, historyEnabled: false,
    runTokscale: async () => ({ entries: [{ client: 'opencode', sessionId: 's1', model: 'm', input: 1 }] }),
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    sessionMetadataDeps: {
      readOpencodeMeta: (ids) => {
        metadataReads += 1;
        if (metadataReads === 1) return new Map();
        return new Map([...ids].map((id) => [id, { projectPath: '/work/project' }]));
      }
    },
    onProgress: (value) => partials.push(value.today.sessions['opencode:s1'].projectId)
  });
  assert.equal(metadataReads, 2);
  assert.equal(partials[0], '');
  assert.equal(summary.today.sessions['opencode:s1'].projectLabel, 'project');
  assert.equal(summary.allTime.sessions['opencode:s1'].projectLabel, 'project');
});

test('disabling project tracking skips local metadata attribution', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-progress-project-disabled-'));
  try {
    const transcriptDir = path.join(home, '.claude', 'projects', 'repo');
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, 's1.jsonl'), `${JSON.stringify({ cwd: '/work/private-repo' })}\n`);
    const summary = await collectUsageOnce({
      clients: 'claude', allTimeSince: '2025-01-01', deviceId: 'dev1', homeDir: home,
      projectsEnabled: false, limitsEnabled: false, historyEnabled: false,
      runTokscale: async () => ({ entries: [{ client: 'claude', sessionId: 's1', model: 'm', input: 1 }] }),
      collectWslUsage: async (options) => {
        assert.equal(options.decoratePeriods, undefined);
        return { bundle: emptyWslBundle(), detected: [] };
      }
    });
    const session = summary.today.sessions['claude:s1'];
    assert.equal(summary.projectsEnabled, false);
    assert.equal(session.projectId, '');
    assert.equal(session.projectLabel, '');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('progressive loading skips onProgress on anchored ticks', async () => {
  calls = 0;
  const partials = [];
  const anchor = { dateKey: require('../../src/shared/collector').localTodayKey(), today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
  await collectUsageOnce({
    clients: 'claude',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    historyEnabled: false,
    todayOnlyAnchor: anchor,
    wslAnchor: emptyWslBundle(),
    runTokscale: sequentialTokscale,
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    onProgress: () => partials.push('called')
  });
  assert.equal(partials.length, 0, 'anchored tick should not fire onProgress');
});

test('anchored project attribution performs one final metadata pass', async () => {
  const runTokscale = async () => ({ entries: [{ client: 'opencode', sessionId: 's1', model: 'm', input: 1 }] });
  const initial = await collectUsageOnce({
    clients: 'opencode', allTimeSince: '2025-01-01', deviceId: 'dev1',
    projectsEnabled: false, limitsEnabled: false, historyEnabled: false,
    runTokscale,
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] })
  });
  let metadataReads = 0;
  const summary = await collectUsageOnce({
    clients: 'opencode', allTimeSince: '2025-01-01', deviceId: 'dev1',
    limitsEnabled: false, historyEnabled: false,
    todayOnlyAnchor: {
      dateKey: require('../../src/shared/collector').localTodayKey(),
      today: initial.today,
      month: initial.month,
      allTime: initial.allTime
    },
    wslAnchor: emptyWslBundle(),
    runTokscale,
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    sessionMetadataDeps: {
      readOpencodeMeta: (ids) => {
        metadataReads += 1;
        return new Map([...ids].map((id) => [id, { projectPath: '/work/project' }]));
      }
    }
  });
  assert.equal(metadataReads, 1);
  assert.equal(summary.today.sessions['opencode:s1'].projectLabel, 'project');
  assert.equal(summary.month.sessions['opencode:s1'].projectLabel, 'project');
  assert.equal(summary.allTime.sessions['opencode:s1'].projectLabel, 'project');
});

function emptyWslBundle() {
  return { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
}

test('progressive loading onProgress throw does not abort the full scan', async () => {
  calls = 0;
  let onProgressCalled = false;
  const summary = await collectUsageOnce({
    clients: 'claude',
    allTimeSince: '2025-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    historyEnabled: false,
    runTokscale: sequentialTokscale,
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    onProgress: () => {
      onProgressCalled = true;
      throw new Error('simulated progress error');
    }
  });
  // onProgress was called (and threw, but was caught)
  assert.equal(onProgressCalled, true, 'onProgress should have been called');
  // The full scan must still complete with all three periods
  assert.equal(summary.today.totalTokens, 105, 'today must survive an onProgress throw');
  assert.equal(summary.month.totalTokens, 730, 'month must survive an onProgress throw');
  assert.equal(summary.allTime.totalTokens, 2930, 'allTime must survive an onProgress throw');
});
