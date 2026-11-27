'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  filterReasonixSyntheticSessions,
  isReasonixSyntheticSession
} = require('../../src/shared/providers/reasonix/sessionGuard');
const { createDeviceState } = require('../../src/shared/usage/deviceState');
const {
  applySessionUsageArchive,
  captureSessionUsageArchive,
  normalizeSessionUsageArchive,
  readSessionUsageArchive
} = require('../../src/shared/usage/sessionUsageArchive');
const { composeLocalSyncStats } = require('../../src/electron/syncDisplayStats');
const { mergedLocalAllTimeSessions } = require('../../src/shared/localSessions');
const { syncPayload } = require('../../src/shared/syncPayload');
const { aggregateDevices, normalizeDeviceRecord, normalizePeriod } = require('../../src/shared/usage');
const { sessionIdLabel, sessionRowsForPeriod } = require('../../src/electron/renderer/sessionRows');

const syntheticSession = {
  client: 'reasonix',
  sessionId: 'reasonix-stats:/Users/test/.reasonix/stats/2026-08-08.jsonl',
  totalTokens: 61409,
  messageCount: 4,
  costUsd: 0.03
};
const syntheticKey = `reasonix:${syntheticSession.sessionId}`;
const nativeSessionTime = new Date(2026, 7, 8, 14, 29, 0);
const codexNativeSession = {
  native: true,
  client: 'codex',
  sessionId: 'codex:native-id',
  totalTokens: 0,
  tokenDataUnavailable: true,
  lastUsedAt: nativeSessionTime.toISOString()
};
const legacyReasonixNativeSession = {
  native: true,
  client: 'reasonix',
  sessionId: 'reasonix:branch-id',
  model: 'deepseek/deepseek-v4-flash',
  totalTokens: 140,
  messageCount: 2,
  lastUsedAt: nativeSessionTime.toISOString()
};

function periodWithSynthetic(extra = {}) {
  return {
    totalTokens: syntheticSession.totalTokens,
    sessions: { [syntheticKey]: { ...syntheticSession } },
    ...extra
  };
}

function nativeViews() {
  return {
    today: { [codexNativeSession.sessionId]: codexNativeSession },
    month: { [codexNativeSession.sessionId]: codexNativeSession },
    allTime: { [codexNativeSession.sessionId]: codexNativeSession }
  };
}

test('Reasonix synthetic predicate is fail-closed for ordinary sessions', () => {
  assert.equal(isReasonixSyntheticSession(syntheticSession, syntheticKey), true);
  assert.equal(isReasonixSyntheticSession({ client: 'codex', sessionId: 'other' }, syntheticKey), true);
  assert.equal(isReasonixSyntheticSession({ client: 'codex', sessionId: syntheticSession.sessionId }, 'codex:other'), true);
  assert.equal(isReasonixSyntheticSession({ client: 'reasonix', sessionId: 'reasonix:branch-id' }, 'reasonix:branch-id'), true);
  assert.equal(isReasonixSyntheticSession({ client: 'reasonix-stats', sessionId: 'stats' }, 'legacy:stats'), true);
  assert.equal(isReasonixSyntheticSession({ client: 'codex', sessionId: 'other' }, 'codex:other'), false);
  assert.deepEqual(filterReasonixSyntheticSessions({ [syntheticKey]: syntheticSession, 'codex:real': { client: 'codex' } }), {
    'codex:real': { client: 'codex' }
  });
});

test('ingestion and hub/display merge never retain Reasonix in period.sessions', () => {
  const rawRecord = {
    deviceId: 'reasonix-fixture',
    updatedAt: '2026-08-08T06:30:00.000Z',
    today: periodWithSynthetic(),
    month: periodWithSynthetic(),
    allTime: periodWithSynthetic()
  };

  const normalized = normalizeDeviceRecord(rawRecord);
  for (const periodName of ['today', 'month', 'allTime']) {
    assert.deepEqual(normalized.periods[periodName].sessions, {});
  }

  const aggregate = aggregateDevices([rawRecord], 0, Date.parse('2026-08-08T06:31:00.000Z'));
  for (const periodName of ['today', 'month', 'allTime']) {
    assert.deepEqual(aggregate.periods[periodName].sessions, {});
    assert.doesNotMatch(JSON.stringify(aggregate.periods[periodName]), /\/Users\/test/);
  }

  const display = composeLocalSyncStats(null, {
    ...rawRecord,
    nativeSessions: nativeViews()
  });
  for (const periodName of ['today', 'month', 'allTime']) {
    assert.deepEqual(display.periods[periodName].sessions, {});
  }
  assert.ok(display.nativeSessions.today[codexNativeSession.sessionId]);

  const allTimeView = mergedLocalAllTimeSessions({
    month: { sessions: { [syntheticKey]: syntheticSession } },
    allTime: { sessions: {} }
  }, rawRecord);
  assert.deepEqual(allTimeView, {});
});

test('legacy archive reads, captures, and applies without resurrecting Reasonix generic entries', () => {
  const legacyArchive = {
    version: 1,
    sessions: {
      [syntheticKey]: {
        client: 'reasonix',
        sessionId: syntheticSession.sessionId,
        capturedAt: '2026-08-08T06:30:00.000Z',
        periods: { allTime: { ...syntheticSession } }
      },
      'reasonix:branch-id': {
        client: 'reasonix',
        sessionId: legacyReasonixNativeSession.sessionId,
        capturedAt: '2026-08-08T06:30:00.000Z',
        periods: { allTime: { ...legacyReasonixNativeSession } }
      }
    }
  };

  assert.deepEqual(normalizeSessionUsageArchive(legacyArchive).sessions, {});
  assert.deepEqual(readSessionUsageArchive({ path: '/tmp/legacy-session-archive.json', readJson: () => legacyArchive }).sessions, {});
  assert.deepEqual(captureSessionUsageArchive({}, {
    today: { sessions: { [syntheticKey]: syntheticSession } },
    month: { sessions: { [syntheticKey]: syntheticSession } },
    allTime: { sessions: { [syntheticKey]: syntheticSession } }
  }, new Date('2026-08-08T06:31:00.000Z')).sessions, {});

  const visible = applySessionUsageArchive({
    today: { sessions: { [syntheticKey]: syntheticSession } },
    month: { sessions: { [syntheticKey]: syntheticSession } },
    allTime: { sessions: { [syntheticKey]: syntheticSession } }
  }, legacyArchive, { now: new Date('2026-08-08T06:31:00.000Z') });
  for (const periodName of ['today', 'month', 'allTime']) {
    assert.deepEqual(visible[periodName].sessions, {});
  }
});

test('deviceState carry-forward drops old generic Reasonix sessions but keeps native views', () => {
  const records = [];
  const state = createDeviceState({ onRecord: (record) => records.push(record) });
  state.updateUsage({
    today: periodWithSynthetic(),
    month: periodWithSynthetic(),
    allTime: periodWithSynthetic(),
    nativeSessions: nativeViews()
  });
  const preview = state.updateUsage({ today: { sessions: {} } }, 'progress', { preview: true });

  for (const periodName of ['today', 'month', 'allTime']) {
    assert.deepEqual(preview[periodName].sessions, {});
  }
  assert.ok(preview.nativeSessions.today[codexNativeSession.sessionId]);
  assert.equal(records.length, 2);
  assert.doesNotMatch(JSON.stringify(records.at(-1)), /\/Users\/test/);
});

test('sync and renderer drop Reasonix sessions in both ordinary and legacy native maps and never serialize stats paths', () => {
  const payload = syncPayload({
    today: periodWithSynthetic({ sessions: {
      [syntheticKey]: syntheticSession,
      'codex:real': { client: 'codex', sessionId: 'real', totalTokens: 5 }
    } }),
    month: periodWithSynthetic(),
    allTime: periodWithSynthetic()
  });
  assert.doesNotMatch(JSON.stringify(payload), /\/Users\/test/);
  assert.ok(payload.today.sessions['codex:real']);
  assert.deepEqual(payload.month.sessions, {});

  const rows = sessionRowsForPeriod({ sessions: { [syntheticKey]: syntheticSession } }, {
    nativeSessions: { [legacyReasonixNativeSession.sessionId]: legacyReasonixNativeSession },
    clientLabels: { reasonix: 'Reasonix' },
    clientColors: { reasonix: '#4d6bfe' },
    now: new Date(2026, 7, 8, 14, 30, 0)
  });
  assert.deepEqual(rows, []);
  assert.equal(sessionIdLabel(syntheticSession.sessionId), '');
  assert.equal(sessionIdLabel(`reasonix:${syntheticSession.sessionId}`), '');
});

test('ordinary period normalization still drops all Reasonix forms', () => {
  const normalized = normalizePeriod({
    sessions: {
      [syntheticKey]: syntheticSession,
      'reasonix:branch-id': legacyReasonixNativeSession,
      'codex:real': { client: 'codex', sessionId: 'real', totalTokens: 5 }
    }
  });
  assert.deepEqual(Object.keys(normalized.sessions), ['codex:real']);
});
