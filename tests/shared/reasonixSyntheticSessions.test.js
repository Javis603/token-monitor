'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  filterReasonixSyntheticSessions,
  isReasonixSyntheticSession
} = require('../../src/shared/reasonixSessionGuard');
const { createDeviceState } = require('../../src/shared/deviceState');
const {
  applySessionUsageArchive,
  captureSessionUsageArchive,
  normalizeSessionUsageArchive,
  readSessionUsageArchive
} = require('../../src/shared/sessionUsageArchive');
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
const nativeSession = {
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
    today: { [nativeSession.sessionId]: nativeSession },
    month: { [nativeSession.sessionId]: nativeSession },
    allTime: { [nativeSession.sessionId]: nativeSession }
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
  assert.ok(display.nativeSessions.today[nativeSession.sessionId]);

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
        sessionId: nativeSession.sessionId,
        capturedAt: '2026-08-08T06:30:00.000Z',
        periods: { allTime: { ...nativeSession } }
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
  assert.ok(preview.nativeSessions.today[nativeSession.sessionId]);
  assert.equal(records.length, 2);
  assert.doesNotMatch(JSON.stringify(records.at(-1)), /\/Users\/test/);
});

test('sync and renderer expose only native Reasonix and never serialize the stats path', () => {
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
    nativeSessions: { [nativeSession.sessionId]: nativeSession },
    clientLabels: { reasonix: 'Reasonix' },
    clientColors: { reasonix: '#4d6bfe' },
    now: new Date(2026, 7, 8, 14, 30, 0)
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client, 'reasonix');
  assert.equal(rows[0].key, 'session:reasonix:branch-id');
  assert.equal(rows[0].name, 'Reasonix · deepseek/deepseek-v4-flash');
  assert.equal(rows[0].subtitle, '14:29 · 2 msgs');
  assert.equal(rows[0].detail, 'branch-id');
  assert.deepEqual(rows.map((row) => row.client), ['reasonix']);
  assert.doesNotMatch(JSON.stringify(rows), /\/Users\/test/);
  assert.equal(sessionIdLabel(syntheticSession.sessionId), '');
  assert.equal(sessionIdLabel(`reasonix:${syntheticSession.sessionId}`), '');
});

test('ordinary period normalization still drops all Reasonix forms while native namespace remains explicit', () => {
  const normalized = normalizePeriod({
    sessions: {
      [syntheticKey]: syntheticSession,
      'reasonix:branch-id': nativeSession,
      'codex:real': { client: 'codex', sessionId: 'real', totalTokens: 5 }
    }
  });
  assert.deepEqual(Object.keys(normalized.sessions), ['codex:real']);
});
