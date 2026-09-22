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
  updateSessionUsageArchive,
  writeSessionUsageArchive
} = archiveApi;
const { normalizePeriod } = require('../../src/shared/usage');

const { localDate } = require('../helpers/localTime');

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
      outputTokens: 30,
      capabilities: { tokenComponents: true },
      clients: { codex: 50 },
      clientCosts: { codex: 0.25 },
      clientOutputs: { codex: 30 },
      models: { 'gpt-5': 50 },
      modelCosts: { 'gpt-5': 0.25 },
      modelOutputs: { 'gpt-5': 30 },
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
      outputTokens: 30,
      capabilities: { tokenComponents: true },
      clients: { codex: 50 },
      clientCosts: { codex: 0.25 },
      clientOutputs: { codex: 30 },
      models: { 'gpt-5': 50 },
      modelCosts: { 'gpt-5': 0.25 },
      modelOutputs: { 'gpt-5': 30 },
      clientModels: { codex: { 'gpt-5': 50 } },
      clientModelCosts: { codex: { 'gpt-5': 0.25 } },
      sessions: {}
    },
    allTime: {
      totalTokens: 50,
      costUsd: 0.25,
      outputTokens: 30,
      capabilities: { tokenComponents: true },
      clients: { codex: 50 },
      clientCosts: { codex: 0.25 },
      clientOutputs: { codex: 30 },
      models: { 'gpt-5': 50 },
      modelCosts: { 'gpt-5': 0.25 },
      modelOutputs: { 'gpt-5': 30 },
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
  assert.equal(visible.today.capabilities.tokenComponents, false);
  assert.equal(visible.today.unclassifiedTokens, 10);
  assert.equal(visible.today.clientUnclassifiedTokens.opencode, 10);
  assert.equal(visible.today.modelUnclassifiedTokens['claude-3-5-sonnet'], 10);
  assert.equal(visible.today.sessions['opencode:o1'].archived, true);
  assert.equal(visible.today.sessions['opencode:o1'].totalTokens, 100);
  assert.equal(visible.today.sessions['codex:c1'].archived, undefined);
  assert.equal(visible.today.clients.codex, 50);
  assert.equal(visible.today.totalTokens, visible.today.clients.opencode + visible.today.clients.codex);

  assert.equal(visible.month.sessions['opencode:o1'].archived, true);
  assert.equal(visible.allTime.sessions['opencode:o1'].archived, true);
});

test('archive day and month windows expire while all-time stays available', () => {
  // The month window expires on the local calendar month, and this is the one
  // pair in the file that straddles a month edge: `2026-08-01T00:20Z` is still
  // July locally at every negative offset, so as a `Z` literal the read lands in
  // the same month it was captured in and the window under test never expires.
  const archive = captureSessionUsageArchive({}, liveSummary(), localDate(2026, 7, 9, 8, 15));
  const nextMonth = applySessionUsageArchive(summaryAfterOpenCodeDelete(), archive, {
    now: localDate(2026, 8, 1, 0, 20)
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

test('canonical capture updates only changed rows in place', () => {
  const archive = captureSessionUsageArchive({}, liveSummary(), new Date('2026-07-09T08:15:00.000Z'));
  const changedSummary = liveSummary();
  changedSummary.allTime.sessions['opencode:o1'].totalTokens = 101;
  const result = updateSessionUsageArchive(archive, changedSummary, new Date('2026-07-09T08:30:00.000Z'));

  assert.equal(result.archive, archive);
  assert.deepEqual([...result.changedKeys], ['opencode:o1']);
  assert.equal(result.archive.sessions['opencode:o1'].periods.allTime.totalTokens, 101);
});

test('canonical capture safely prunes malformed entries without period windows', () => {
  const archive = {
    version: 1,
    sessions: {
      'opencode:o1': {
        client: 'opencode',
        sessionId: 'o1',
        day: '2026-07-08',
        month: '2026-06',
        periods: {
          today: { client: 'opencode', sessionId: 'o1', totalTokens: 10 },
          month: { client: 'opencode', sessionId: 'o1', totalTokens: 20 },
          allTime: { client: 'opencode', sessionId: 'o1', totalTokens: 30 }
        }
      }
    }
  };

  const result = updateSessionUsageArchive(archive, null, new Date(2026, 6, 9, 8, 30));

  assert.deepEqual([...result.changedKeys], ['opencode:o1']);
  assert.equal(archive.sessions['opencode:o1'].periods.today, undefined);
  assert.equal(archive.sessions['opencode:o1'].periods.month, undefined);
  assert.equal(archive.sessions['opencode:o1'].periods.allTime.totalTokens, 30);
});

test('canonical summary apply can reuse the caller-owned normalized record', () => {
  const archive = captureSessionUsageArchive({}, liveSummary(), new Date('2026-07-09T08:15:00.000Z'));
  const summary = {
    allTime: normalizePeriod({
      sessions: {
        'codex:c1': liveSummary().today.sessions['codex:c1']
      }
    })
  };
  const visible = applySessionUsageArchive(summary, archive, {
    now: new Date('2026-07-09T08:20:00.000Z'),
    canonical: true,
    canonicalSummary: true,
    mutate: true
  });

  assert.equal(visible, summary);
  assert.equal(visible.allTime.sessions['opencode:o1'].archived, true);
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

test('multi-model archived sessions keep model components Unclassified instead of guessing a split', () => {
  const summary = liveSummary();
  const session = summary.allTime.sessions['opencode:o1'];
  session.models = { alpha: 34, beta: 33, gamma: 33 };
  session.cacheReadTokens = 60;
  session.cacheWriteTokens = 10;
  session.outputTokens = 20;
  const archive = captureSessionUsageArchive({}, summary, new Date('2026-07-09T08:15:00.000Z'));
  const visible = applySessionUsageArchive({ allTime: { sessions: {} } }, archive);

  assert.equal(visible.allTime.cacheReadTokens, 60);
  assert.equal(visible.allTime.cacheWriteTokens, 10);
  assert.equal(visible.allTime.outputTokens, 20);
  assert.equal(visible.allTime.clientCacheReads.opencode, 60);
  assert.deepEqual(visible.allTime.modelCacheReads, {});
  assert.deepEqual(visible.allTime.modelCacheWrites, {});
  assert.deepEqual(visible.allTime.modelOutputs, {});
  assert.deepEqual(visible.allTime.modelUnclassifiedTokens, { alpha: 34, beta: 33, gamma: 33 });
  assert.equal(visible.allTime.capabilities.tokenComponents, false);
});

test('multi-model archive classification is independent of map property order', () => {
  const captureWithModels = (models) => {
    const summary = liveSummary();
    Object.assign(summary.allTime.sessions['opencode:o1'], {
      models,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      outputTokens: 20
    });
    const archive = captureSessionUsageArchive({}, summary, new Date('2026-07-09T08:15:00.000Z'));
    return applySessionUsageArchive({ allTime: { sessions: {} } }, archive).allTime;
  };

  const forward = captureWithModels({ alpha: 34, beta: 33, gamma: 33 });
  const reverse = captureWithModels({ gamma: 33, beta: 33, alpha: 34 });
  assert.deepEqual(forward.modelCacheReads, reverse.modelCacheReads);
  assert.deepEqual(forward.modelCacheWrites, reverse.modelCacheWrites);
  assert.deepEqual(forward.modelOutputs, reverse.modelOutputs);
  assert.deepEqual(forward.modelUnclassifiedTokens, reverse.modelUnclassifiedTokens);
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
  assert.ok(elapsedMs < 500, `large archive apply took ${elapsedMs.toFixed(1)}ms`);
});

// Same invariant as the client archive: the periods a progressive preview omits
// are what mark it partial, and deviceState carries clientStatus / clientHealth /
// wslStatus / periodWindows forward on exactly that signal. Materializing a
// period here made every preview look like a complete record, so those fields
// vanished from the device for the length of a full scan.
test('reapplying an archive never invents a period the preview omitted', () => {
  const archive = captureSessionUsageArchive({}, liveSummary(), new Date('2026-07-09T08:15:00.000Z'));
  const preview = { deviceId: 'macbook', updatedAt: '2026-07-09T08:20:00.000Z', today: summaryAfterOpenCodeDelete().today };
  const visible = applySessionUsageArchive(preview, archive, { now: new Date('2026-07-09T08:20:00.000Z') });
  assert.equal('month' in visible, false);
  assert.equal('allTime' in visible, false);
  assert.equal(visible.today.sessions['opencode:o1'].archived, true);
});

const CURSOR_MODEL = 'cursor-grok-4.6-high';
const CURSOR_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW = new Date('2026-09-12T12:00:00.000Z');

function cursorSession(sessionId, tokens) {
  return {
    client: 'cursor',
    sessionId,
    totalTokens: tokens,
    costUsd: tokens / 100,
    models: { [CURSOR_MODEL]: tokens },
    modelCosts: { [CURSOR_MODEL]: tokens / 100 }
  };
}

function cursorSummary(sessions) {
  const totalTokens = sessions.reduce((sum, session) => sum + session.totalTokens, 0);
  const costUsd = sessions.reduce((sum, session) => sum + session.costUsd, 0);
  return {
    allTime: {
      totalTokens,
      costUsd,
      clients: { cursor: totalTokens },
      clientCosts: { cursor: costUsd },
      models: { [CURSOR_MODEL]: totalTokens },
      modelCosts: { [CURSOR_MODEL]: costUsd },
      sessions: Object.fromEntries(sessions.map((session) => [`cursor:${session.sessionId}`, session]))
    }
  };
}

function legacyEventArchive(events) {
  return {
    sessions: Object.fromEntries(events.map(([sessionId, tokens]) => [`cursor:${sessionId}`, {
      client: 'cursor',
      sessionId,
      capturedAt: '2026-08-30T06:33:52.626Z',
      day: '2026-08-30',
      month: '2026-08',
      periods: { allTime: cursorSession(sessionId, tokens) }
    }]))
  };
}

// A Cursor JSON cache index holding `[isoTimestamp, sessionId, totalTokens]`.
function cursorUsageEvents(events, signature = 'cache-v1') {
  let lookups = 0;
  const read = () => {
    return {
      signature,
      sessionsAt(time, totalTokens) {
        lookups += 1;
        return [...new Set(events
          .filter(([at, , tokens]) => Date.parse(at) === time && tokens === totalTokens)
          .map(([, sessionId]) => sessionId))];
      }
    };
  };
  read.lookups = () => lookups;
  return read;
}

const LEGACY_EVENTS = [
  ['cursor-active-2026-08-13T02:10:00.000Z', 300],
  ['cursor-active-2026-08-13T02:42:39.510Z', 700]
];
const CACHED_EVENTS = [
  ['2026-08-13T02:10:00.000Z', CURSOR_UUID, 300],
  ['2026-08-13T02:42:39.510Z', CURSOR_UUID, 700]
];

function linkedArchive(events = CACHED_EVENTS) {
  return updateSessionUsageArchive(
    normalizeSessionUsageArchive(legacyEventArchive(LEGACY_EVENTS)),
    cursorSummary([cursorSession(CURSOR_UUID, 1000)]),
    NOW,
    { cursorUsageEvents: cursorUsageEvents(events) }
  );
}

test('legacy Cursor events are linked to the session the JSON cache files them under', () => {
  const { archive, changedKeys } = linkedArchive();

  for (const [sessionId] of LEGACY_EVENTS) {
    assert.equal(archive.sessions[`cursor:${sessionId}`].supersededBy, `cursor:${CURSOR_UUID}`);
    assert.equal(archive.sessions[`cursor:${sessionId}`].periods.allTime.totalTokens > 0, true);
    assert.equal(changedKeys.has(`cursor:${sessionId}`), true);
  }
  const visible = applySessionUsageArchive(cursorSummary([cursorSession(CURSOR_UUID, 1000)]), archive, { now: NOW });
  assert.equal(visible.allTime.totalTokens, 1000);
});

test('linked legacy Cursor events stay skipped once their session only survives in the archive', () => {
  const { archive } = linkedArchive();
  const visible = applySessionUsageArchive(cursorSummary([]), archive, { now: NOW });

  assert.equal(visible.allTime.totalTokens, 1000);
  assert.equal(visible.allTime.sessions[`cursor:${CURSOR_UUID}`].archived, true);
});

test('linked legacy Cursor events replay when their session is nowhere to be found', () => {
  const archive = normalizeSessionUsageArchive(legacyEventArchive(LEGACY_EVENTS));
  for (const entry of Object.values(archive.sessions)) entry.supersededBy = `cursor:${CURSOR_UUID}`;
  const visible = applySessionUsageArchive(cursorSummary([]), archive, { now: NOW });

  assert.equal(visible.allTime.totalTokens, 1000);
  assert.equal(visible.allTime.sessions['cursor:cursor-active-2026-08-13T02:10:00.000Z'].archived, true);
});

for (const [name, events] of [
  ['no cached event has its timestamp and tokens', [['2026-08-13T02:42:39.510Z', CURSOR_UUID, 699]]],
  ['cached events in two sessions match it', [
    ['2026-08-13T02:42:39.510Z', CURSOR_UUID, 700],
    ['2026-08-13T02:42:39.510Z', 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', 700]
  ]]
]) {
  test(`a legacy Cursor event stays unlinked and replays when ${name}`, () => {
    const { archive } = linkedArchive(events);
    const key = 'cursor:cursor-active-2026-08-13T02:42:39.510Z';
    assert.equal(archive.sessions[key].supersededBy, undefined);

    const visible = applySessionUsageArchive(cursorSummary([cursorSession(CURSOR_UUID, 1000)]), archive, { now: NOW });
    assert.equal(visible.allTime.sessions[key].archived, true);
  });
}

test('a legacy Cursor row captured later is linked from the cache already read', () => {
  const archive = normalizeSessionUsageArchive(legacyEventArchive([LEGACY_EVENTS[0]]));
  const cache = cursorUsageEvents(CACHED_EVENTS);
  updateSessionUsageArchive(archive, cursorSummary([]), NOW, { cursorUsageEvents: cache });
  assert.equal(archive.sessions[`cursor:${LEGACY_EVENTS[0][0]}`].supersededBy, `cursor:${CURSOR_UUID}`);

  const [lateId, lateTokens] = LEGACY_EVENTS[1];
  const late = updateSessionUsageArchive(
    archive,
    cursorSummary([cursorSession(lateId, lateTokens)]),
    NOW,
    { cursorUsageEvents: cache }
  );

  assert.equal(late.archive.sessions[`cursor:${lateId}`].supersededBy, `cursor:${CURSOR_UUID}`);
});

test('a pending legacy Cursor row grown by a later capture is looked up again', () => {
  const [legacyId, tokens] = LEGACY_EVENTS[1];
  const archive = normalizeSessionUsageArchive(legacyEventArchive([[legacyId, tokens - 1]]));
  const cache = cursorUsageEvents(CACHED_EVENTS);
  updateSessionUsageArchive(archive, cursorSummary([]), NOW, { cursorUsageEvents: cache });
  assert.equal(archive.sessions[`cursor:${legacyId}`].supersededBy, undefined);

  const grown = updateSessionUsageArchive(
    archive,
    cursorSummary([cursorSession(legacyId, tokens)]),
    NOW,
    { cursorUsageEvents: cache }
  );

  assert.equal(grown.archive.sessions[`cursor:${legacyId}`].supersededBy, `cursor:${CURSOR_UUID}`);
});

function linkedLegacyArchive(periodNames = ['allTime']) {
  const [legacyId, tokens] = LEGACY_EVENTS[1];
  const entry = legacyEventArchive([[legacyId, tokens]]).sessions[`cursor:${legacyId}`];
  entry.periods = Object.fromEntries(periodNames.map((period) => [period, cursorSession(legacyId, tokens)]));
  const archive = normalizeSessionUsageArchive({ sessions: { [`cursor:${legacyId}`]: entry } });
  updateSessionUsageArchive(archive, cursorSummary([]), NOW, { cursorUsageEvents: cursorUsageEvents(CACHED_EVENTS) });
  assert.equal(archive.sessions[`cursor:${legacyId}`].supersededBy, `cursor:${CURSOR_UUID}`);
  return { archive, legacyId, tokens };
}

test('linking reads the Cursor cache only while a row is still unlinked', () => {
  const archive = normalizeSessionUsageArchive(legacyEventArchive(LEGACY_EVENTS));
  const cache = cursorUsageEvents(CACHED_EVENTS);
  updateSessionUsageArchive(archive, cursorSummary([]), NOW, { cursorUsageEvents: cache });
  const lookups = cache.lookups();
  assert.equal(lookups, LEGACY_EVENTS.length);

  updateSessionUsageArchive(archive, cursorSummary([]), NOW, { cursorUsageEvents: cache });
  assert.equal(cache.lookups(), lookups);
});

test('a legacy Cursor row that grows after it was linked keeps that link', () => {
  const { archive, legacyId, tokens } = linkedLegacyArchive();

  const grown = updateSessionUsageArchive(
    archive,
    cursorSummary([cursorSession(legacyId, tokens + 40)]),
    NOW,
    { cursorUsageEvents: cursorUsageEvents([], 'cache-purged') }
  );

  assert.equal(grown.archive.sessions[`cursor:${legacyId}`].supersededBy, `cursor:${CURSOR_UUID}`);
});

test('a repriced legacy Cursor row keeps its link after the cache is gone', () => {
  const { archive, legacyId, tokens } = linkedLegacyArchive();
  const repriced = { ...cursorSession(legacyId, tokens), costUsd: 99, modelCosts: { [CURSOR_MODEL]: 99 } };

  const next = updateSessionUsageArchive(archive, cursorSummary([repriced]), NOW, {
    cursorUsageEvents: cursorUsageEvents([], 'cache-purged')
  });

  assert.equal(next.archive.sessions[`cursor:${legacyId}`].supersededBy, `cursor:${CURSOR_UUID}`);
  const visible = applySessionUsageArchive(cursorSummary([cursorSession(CURSOR_UUID, 1000)]), next.archive, { now: NOW });
  assert.equal(visible.allTime.totalTokens, 1000);
});

test('pruning an expired period keeps a legacy Cursor link after the cache is gone', () => {
  const { archive, legacyId } = linkedLegacyArchive(['today', 'allTime']);
  const nextDay = new Date(NOW.getTime() + 36 * 60 * 60 * 1000);

  const next = updateSessionUsageArchive(archive, cursorSummary([]), nextDay, {
    cursorUsageEvents: cursorUsageEvents([], 'cache-purged')
  });

  assert.equal(next.archive.sessions[`cursor:${legacyId}`].periods.today, undefined);
  assert.equal(next.archive.sessions[`cursor:${legacyId}`].supersededBy, `cursor:${CURSOR_UUID}`);
});

test('the Cursor session link survives normalization and is ignored on other rows', () => {
  const archive = legacyEventArchive([['cursor-team-a-2026-08-13T02:42:39', 700]]);
  archive.sessions['cursor:cursor-team-a-2026-08-13T02:42:39'].supersededBy = `cursor:${CURSOR_UUID}`;
  archive.sessions[`cursor:${CURSOR_UUID}`] = {
    ...legacyEventArchive([[CURSOR_UUID, 1000]]).sessions[`cursor:${CURSOR_UUID}`],
    supersededBy: 'cursor:other'
  };
  const normalized = normalizeSessionUsageArchive(archive);

  assert.equal(normalized.sessions['cursor:cursor-team-a-2026-08-13T02:42:39'].supersededBy, `cursor:${CURSOR_UUID}`);
  assert.equal(normalized.sessions[`cursor:${CURSOR_UUID}`].supersededBy, undefined);
});

test('legacy Cursor CSV timestamps without Z or fraction parse as UTC', () => {
  const { legacyCursorEventTime } = require('../../src/shared/providers/cursor/sessionGuard');
  const previousTimeZone = process.env.TZ;
  process.env.TZ = 'Asia/Hong_Kong';
  try {
    const expected = Date.UTC(2026, 7, 13, 2, 42, 39);
    for (const sessionId of [
      'cursor-active-2026-08-13T02:42:39Z',
      'cursor-active-2026-08-13T02:42:39',
      'cursor-team-a-2026-08-13T02:42:39.000',
      'cursor-team-a-2026-08-13T02:42:39.000Z'
    ]) {
      assert.equal(legacyCursorEventTime({ client: 'cursor', sessionId }), expected, sessionId);
    }
    assert.equal(legacyCursorEventTime({ client: 'cursor', sessionId: 'cursor-active-2026-08-13' }), null);
    assert.equal(legacyCursorEventTime({ client: 'cursor', sessionId: CURSOR_UUID }), null);
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});

test('still preserves Cursor conversation sessions after the live source drops them', () => {
  const archive = captureSessionUsageArchive({}, cursorSummary([cursorSession(CURSOR_UUID, 1000)]), NOW);
  const visible = applySessionUsageArchive({ allTime: { sessions: {} } }, archive, {
    now: new Date('2026-09-12T12:05:00.000Z')
  });

  assert.equal(visible.allTime.totalTokens, 1000);
  assert.equal(visible.allTime.clients.cursor, 1000);
  assert.equal(visible.allTime.sessions[`cursor:${CURSOR_UUID}`].archived, true);
});
