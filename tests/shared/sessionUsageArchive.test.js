'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');

let archiveApi = {};
try {
  archiveApi = require('../../src/shared/sessionUsageArchive');
} catch (_) {}

const {
  applySessionUsageArchive,
  captureSessionUsageArchive,
  clearSessionUsageArchive,
  normalizeSessionUsageArchive,
  readSessionUsageArchive,
  sessionUsageArchiveDate,
  sessionUsageArchivePath,
  writeSessionUsageArchive
} = archiveApi;

function liveSummary() {
  return {
    deviceId: 'macbook',
    today: {
      totalTokens: 150,
      costUsd: 1.5,
      clients: { opencode: 100, codex: 50 },
      clientCosts: { opencode: 1.25, codex: 0.25 },
      models: { 'claude-3-5-sonnet': 100, 'gpt-5': 50 },
      modelCosts: { 'claude-3-5-sonnet': 1.25, 'gpt-5': 0.25 },
      clientModels: { opencode: { 'claude-3-5-sonnet': 100 }, codex: { 'gpt-5': 50 } },
      clientModelCosts: { opencode: { 'claude-3-5-sonnet': 1.25 }, codex: { 'gpt-5': 0.25 } },
      sessions: {
        'opencode:o1': {
          client: 'opencode',
          sessionId: 'o1',
          totalTokens: 100,
          costUsd: 1.25,
          messageCount: 4,
          inputTokens: 10,
          outputTokens: 30,
          cacheReadTokens: 50,
          cacheWriteTokens: 10,
          models: { 'claude-3-5-sonnet': 100 },
          modelCosts: { 'claude-3-5-sonnet': 1.25 },
          lastUsedAt: '2026-07-09T08:00:00.000Z'
        },
        'codex:c1': {
          client: 'codex',
          sessionId: 'c1',
          totalTokens: 50,
          costUsd: 0.25,
          messageCount: 2,
          inputTokens: 20,
          outputTokens: 30,
          models: { 'gpt-5': 50 },
          modelCosts: { 'gpt-5': 0.25 },
          lastUsedAt: '2026-07-09T08:10:00.000Z'
        }
      }
    },
    month: {
      totalTokens: 150,
      costUsd: 1.5,
      clients: { opencode: 100, codex: 50 },
      clientCosts: { opencode: 1.25, codex: 0.25 },
      models: { 'claude-3-5-sonnet': 100, 'gpt-5': 50 },
      modelCosts: { 'claude-3-5-sonnet': 1.25, 'gpt-5': 0.25 },
      clientModels: { opencode: { 'claude-3-5-sonnet': 100 }, codex: { 'gpt-5': 50 } },
      clientModelCosts: { opencode: { 'claude-3-5-sonnet': 1.25 }, codex: { 'gpt-5': 0.25 } },
      sessions: {
        'opencode:o1': {
          client: 'opencode',
          sessionId: 'o1',
          totalTokens: 100,
          costUsd: 1.25,
          messageCount: 4,
          inputTokens: 10,
          outputTokens: 30,
          cacheReadTokens: 50,
          cacheWriteTokens: 10,
          models: { 'claude-3-5-sonnet': 100 },
          modelCosts: { 'claude-3-5-sonnet': 1.25 },
          lastUsedAt: '2026-07-09T08:00:00.000Z'
        }
      }
    },
    allTime: {
      totalTokens: 150,
      costUsd: 1.5,
      clients: { opencode: 100, codex: 50 },
      clientCosts: { opencode: 1.25, codex: 0.25 },
      models: { 'claude-3-5-sonnet': 100, 'gpt-5': 50 },
      modelCosts: { 'claude-3-5-sonnet': 1.25, 'gpt-5': 0.25 },
      clientModels: { opencode: { 'claude-3-5-sonnet': 100 }, codex: { 'gpt-5': 50 } },
      clientModelCosts: { opencode: { 'claude-3-5-sonnet': 1.25 }, codex: { 'gpt-5': 0.25 } },
      sessions: {
        'opencode:o1': {
          client: 'opencode',
          sessionId: 'o1',
          totalTokens: 100,
          costUsd: 1.25,
          messageCount: 4,
          inputTokens: 10,
          outputTokens: 30,
          cacheReadTokens: 50,
          cacheWriteTokens: 10,
          models: { 'claude-3-5-sonnet': 100 },
          modelCosts: { 'claude-3-5-sonnet': 1.25 },
          lastUsedAt: '2026-07-09T08:00:00.000Z'
        }
      }
    }
  };
}

function summaryAfterOpenCodeDelete() {
  return {
    deviceId: 'macbook',
    today: {
      totalTokens: 50,
      costUsd: 0.25,
      clients: { codex: 50 },
      clientCosts: { codex: 0.25 },
      models: { 'gpt-5': 50 },
      modelCosts: { 'gpt-5': 0.25 },
      clientModels: { codex: { 'gpt-5': 50 } },
      clientModelCosts: { codex: { 'gpt-5': 0.25 } },
      sessions: {
        'codex:c1': {
          client: 'codex',
          sessionId: 'c1',
          totalTokens: 50,
          costUsd: 0.25,
          messageCount: 2,
          inputTokens: 20,
          outputTokens: 30,
          models: { 'gpt-5': 50 },
          modelCosts: { 'gpt-5': 0.25 },
          lastUsedAt: '2026-07-09T08:10:00.000Z'
        }
      }
    },
    month: {
      totalTokens: 50,
      costUsd: 0.25,
      clients: { codex: 50 },
      clientCosts: { codex: 0.25 },
      models: { 'gpt-5': 50 },
      modelCosts: { 'gpt-5': 0.25 },
      clientModels: { codex: { 'gpt-5': 50 } },
      clientModelCosts: { codex: { 'gpt-5': 0.25 } },
      sessions: {}
    },
    allTime: {
      totalTokens: 50,
      costUsd: 0.25,
      clients: { codex: 50 },
      clientCosts: { codex: 0.25 },
      models: { 'gpt-5': 50 },
      modelCosts: { 'gpt-5': 0.25 },
      clientModels: { codex: { 'gpt-5': 50 } },
      clientModelCosts: { codex: { 'gpt-5': 0.25 } },
      sessions: {}
    }
  };
}

test('captures and reapplies missing sessions for any client without double-counting live sessions', () => {
  assert.equal(typeof captureSessionUsageArchive, 'function');
  assert.equal(typeof applySessionUsageArchive, 'function');

  const archive = captureSessionUsageArchive({}, liveSummary(), new Date('2026-07-09T08:15:00.000Z'));
  const visible = applySessionUsageArchive(summaryAfterOpenCodeDelete(), archive, {
    now: new Date('2026-07-09T08:20:00.000Z')
  });

  assert.equal(visible.today.totalTokens, 150);
  assert.equal(visible.today.clients.opencode, 100);
  assert.equal(visible.today.clientCosts.opencode, 1.25);
  assert.equal(visible.today.clientCacheReads.opencode, 50);
  assert.equal(visible.today.clientCacheWrites.opencode, 10);
  assert.equal(visible.today.clientOutputs.opencode, 30);
  assert.equal(visible.today.models['claude-3-5-sonnet'], 100);
  assert.equal(visible.today.modelCacheReads['claude-3-5-sonnet'], 50);
  assert.equal(visible.today.sessions['opencode:o1'].archived, true);
  assert.equal(visible.today.sessions['opencode:o1'].totalTokens, 100);
  assert.equal(visible.today.sessions['codex:c1'].archived, undefined);
  assert.equal(visible.today.clients.codex, 50);
  assert.equal(visible.today.totalTokens, visible.today.clients.opencode + visible.today.clients.codex);

  assert.equal(visible.month.sessions['opencode:o1'].archived, true);
  assert.equal(visible.allTime.sessions['opencode:o1'].archived, true);
});

test('archive day and month windows expire while all-time stays available', () => {
  const archive = captureSessionUsageArchive({}, liveSummary(), new Date('2026-07-09T08:15:00.000Z'));
  const nextMonth = applySessionUsageArchive(summaryAfterOpenCodeDelete(), archive, {
    now: new Date('2026-08-01T00:20:00.000Z')
  });

  assert.equal(nextMonth.today.sessions['opencode:o1'], undefined);
  assert.equal(nextMonth.month.sessions['opencode:o1'], undefined);
  assert.equal(nextMonth.allTime.sessions['opencode:o1'].archived, true);
  assert.equal(nextMonth.allTime.clients.opencode, 100);
});

test('uses the collector snapshot time when delivery crosses a period boundary', () => {
  const collectedAt = new Date(2026, 6, 31, 23, 59);
  const deliveredAt = new Date(2026, 7, 1, 0, 1);
  const summary = liveSummary();
  summary.updatedAt = collectedAt.toISOString();

  const archiveDate = sessionUsageArchiveDate(summary, deliveredAt);
  const archive = captureSessionUsageArchive({}, summary, archiveDate);
  const nextPeriod = applySessionUsageArchive(summaryAfterOpenCodeDelete(), archive, {
    now: deliveredAt
  });

  assert.equal(archiveDate.toISOString(), collectedAt.toISOString());
  assert.equal(nextPeriod.today.sessions['opencode:o1'], undefined);
  assert.equal(nextPeriod.month.sessions['opencode:o1'], undefined);
  assert.equal(nextPeriod.allTime.sessions['opencode:o1'].archived, true);
});

test('month refresh does not make an old today session apply to a new day', () => {
  const archive = captureSessionUsageArchive({}, liveSummary(), new Date('2026-07-09T08:15:00.000Z'));
  const monthOnlyRefresh = {
    deviceId: 'macbook',
    month: {
      totalTokens: 125,
      costUsd: 1.5,
      clients: { opencode: 125 },
      clientCosts: { opencode: 1.5 },
      models: { 'claude-3-5-sonnet': 125 },
      modelCosts: { 'claude-3-5-sonnet': 1.5 },
      sessions: {
        'opencode:o1': {
          client: 'opencode',
          sessionId: 'o1',
          totalTokens: 125,
          costUsd: 1.5,
          models: { 'claude-3-5-sonnet': 125 },
          modelCosts: { 'claude-3-5-sonnet': 1.5 },
          lastUsedAt: '2026-07-09T08:00:00.000Z'
        }
      }
    },
    allTime: {
      totalTokens: 125,
      costUsd: 1.5,
      clients: { opencode: 125 },
      clientCosts: { opencode: 1.5 },
      models: { 'claude-3-5-sonnet': 125 },
      modelCosts: { 'claude-3-5-sonnet': 1.5 },
      sessions: {
        'opencode:o1': {
          client: 'opencode',
          sessionId: 'o1',
          totalTokens: 125,
          costUsd: 1.5,
          models: { 'claude-3-5-sonnet': 125 },
          modelCosts: { 'claude-3-5-sonnet': 1.5 },
          lastUsedAt: '2026-07-09T08:00:00.000Z'
        }
      }
    }
  };

  const refreshed = captureSessionUsageArchive(archive, monthOnlyRefresh, new Date('2026-07-10T08:15:00.000Z'));
  const visible = applySessionUsageArchive({ today: { sessions: {} }, month: { sessions: {} }, allTime: { sessions: {} } }, refreshed, {
    now: new Date('2026-07-10T08:20:00.000Z')
  });

  assert.equal(visible.today.sessions['opencode:o1'], undefined);
  assert.equal(visible.month.sessions['opencode:o1'].totalTokens, 125);
  assert.equal(visible.allTime.sessions['opencode:o1'].totalTokens, 125);
});

test('normalizes legacy and malformed archive entries without losing usable sessions', () => {
  assert.equal(typeof normalizeSessionUsageArchive, 'function');

  const normalized = normalizeSessionUsageArchive({
    sessions: {
      'OpenCode:o1': {
        client: 'OpenCode',
        sessionId: 'o1',
        capturedAt: '2026-07-09T08:15:00.000Z',
        periods: {
          allTime: {
            client: 'OpenCode',
            sessionId: 'o1',
            totalTokens: 12,
            models: { 'gpt-5': 12 }
          }
        }
      },
      broken: {
        periods: {
          allTime: { totalTokens: 100 }
        }
      }
    }
  });

  assert.deepEqual(Object.keys(normalized.sessions), ['opencode:o1']);
  assert.equal(normalized.sessions['opencode:o1'].periods.allTime.totalTokens, 12);
  assert.equal(normalized.sessions['opencode:o1'].periods.today, undefined);
});

test('capture does not churn timestamps when session data is unchanged', () => {
  const first = captureSessionUsageArchive({}, liveSummary(), new Date('2026-07-09T08:15:00.000Z'));
  const second = captureSessionUsageArchive(first, liveSummary(), new Date('2026-07-09T08:30:00.000Z'));

  assert.equal(second.sessions['opencode:o1'].capturedAt, '2026-07-09T08:15:00.000Z');
  assert.deepEqual(second, first);
});

test('persists archive data outside settings via injectable storage helpers', () => {
  assert.equal(typeof sessionUsageArchivePath, 'function');
  assert.equal(typeof readSessionUsageArchive, 'function');
  assert.equal(typeof writeSessionUsageArchive, 'function');

  const archivePath = sessionUsageArchivePath({
    env: { TOKEN_MONITOR_SHARED_DIR: '/tmp/token-monitor-test' }
  });
  assert.equal(archivePath, path.join('/tmp/token-monitor-test', 'session-usage-archive.json'));

  const writes = [];
  const archive = captureSessionUsageArchive({}, liveSummary(), new Date('2026-07-09T08:15:00.000Z'));
  writeSessionUsageArchive(archive, {
    path: archivePath,
    writeJsonAtomic: (filePath, value) => writes.push({ filePath, value })
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].filePath, archivePath);
  assert.equal(writes[0].value.sessions['opencode:o1'].periods.allTime.totalTokens, 100);

  const readBack = readSessionUsageArchive({
    path: archivePath,
    readJson: (filePath, fallback) => {
      assert.equal(filePath, archivePath);
      return writes[0]?.value || fallback;
    }
  });
  assert.equal(readBack.sessions['opencode:o1'].periods.allTime.totalTokens, 100);
});

test('clears persisted archive data and treats a missing file as already clear', () => {
  const calls = [];
  assert.equal(clearSessionUsageArchive({ path: '/tmp/archive.json', unlinkSync: (filePath) => calls.push(filePath) }), true);
  assert.deepEqual(calls, ['/tmp/archive.json']);
  assert.equal(clearSessionUsageArchive({
    path: '/tmp/archive.json',
    unlinkSync: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
  }), false);
});

test('allocates archived token components across models without rounding drift', () => {
  const summary = liveSummary();
  const session = summary.allTime.sessions['opencode:o1'];
  session.models = { alpha: 1, beta: 1, gamma: 1 };
  session.cacheReadTokens = 2;
  session.cacheWriteTokens = 2;
  session.outputTokens = 2;
  const archive = captureSessionUsageArchive({}, summary, new Date('2026-07-09T08:15:00.000Z'));
  const visible = applySessionUsageArchive({ allTime: { sessions: {} } }, archive);

  assert.equal(Object.values(visible.allTime.modelCacheReads).reduce((sum, value) => sum + value, 0), 2);
  assert.equal(Object.values(visible.allTime.modelCacheWrites).reduce((sum, value) => sum + value, 0), 2);
  assert.equal(Object.values(visible.allTime.modelOutputs).reduce((sum, value) => sum + value, 0), 2);
});

test('allocates tied model remainders independently of map property order', () => {
  const captureWithModels = (models) => {
    const summary = liveSummary();
    Object.assign(summary.allTime.sessions['opencode:o1'], {
      models,
      cacheReadTokens: 2,
      cacheWriteTokens: 2,
      outputTokens: 2
    });
    const archive = captureSessionUsageArchive({}, summary, new Date('2026-07-09T08:15:00.000Z'));
    return applySessionUsageArchive({ allTime: { sessions: {} } }, archive).allTime;
  };

  const forward = captureWithModels({ alpha: 1, beta: 1, gamma: 1 });
  const reverse = captureWithModels({ gamma: 1, beta: 1, alpha: 1 });
  assert.deepEqual(forward.modelCacheReads, reverse.modelCacheReads);
  assert.deepEqual(forward.modelCacheWrites, reverse.modelCacheWrites);
  assert.deepEqual(forward.modelOutputs, reverse.modelOutputs);
});

test('reapplies a large session archive without repeatedly normalizing growing periods', () => {
  const archive = { version: 1, sessions: {} };
  for (let index = 0; index < 2000; index += 1) {
    const sessionId = `session-${index}`;
    archive.sessions[`codex:${sessionId}`] = {
      client: 'codex',
      sessionId,
      capturedAt: '2026-07-15T00:00:00.000Z',
      periods: {
        allTime: {
          client: 'codex',
          sessionId,
          totalTokens: index + 1,
          cacheReadTokens: index,
          outputTokens: 2,
          models: { 'gpt-5': index + 1 }
        }
      }
    };
  }

  const startedAt = performance.now();
  const visible = applySessionUsageArchive({ allTime: { sessions: {} } }, archive, {
    now: new Date('2026-07-15T00:00:00.000Z')
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(Object.keys(visible.allTime.sessions).length, 2000);
  assert.ok(elapsedMs < 250, `large archive apply took ${elapsedMs.toFixed(1)}ms`);
});
