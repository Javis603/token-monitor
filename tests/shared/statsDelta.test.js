'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyStatsDelta, buildStatsDelta, fingerprintStats } = require('../../src/shared/statsDelta');

function period(totalTokens, sessions) {
  return {
    totalTokens,
    costUsd: totalTokens / 1000,
    clients: { claude: totalTokens },
    clientCosts: { claude: totalTokens / 1000 },
    models: { sonnet: totalTokens },
    modelCosts: { sonnet: totalTokens / 1000 },
    sessions
  };
}

function stats(id, source, { today, month, allTimeSessions } = {}) {
  const allTime = period(month.totalTokens, {});
  delete allTime.sessions;
  if (allTimeSessions) allTime.sessions = allTimeSessions;
  return {
    updatedAt: `2026-11-15T00:00:0${id}.000Z`,
    staleAfterMs: 0,
    periods: { today, month, allTime },
    devices: [],
    limits: { providers: [] },
    historyRevision: `rev-${id}`,
    snapshot: { id, source }
  };
}

function row(id, tokens) {
  return {
    client: 'claude',
    sessionId: id,
    totalTokens: tokens,
    costUsd: tokens / 1000,
    models: { sonnet: tokens },
    modelCosts: { sonnet: tokens / 1000 },
    lastUsedAt: `2026-11-15T00:00:${String(tokens % 60).padStart(2, '0')}.000Z`
  };
}

test('a changed row and a removed row apply to the previous snapshot', () => {
  const previous = stats(1, 7, {
    today: period(30, { 'claude:a': row('a', 10), 'claude:b': row('b', 20) }),
    month: period(30, { 'claude:a': row('a', 10), 'claude:b': row('b', 20) }),
    allTimeSessions: { 'claude:a': row('a', 100) }
  });
  const next = stats(2, 7, {
    today: period(45, { 'claude:a': row('a', 15) }),
    month: period(45, { 'claude:a': row('a', 15) })
  });
  const built = buildStatsDelta(fingerprintStats(previous), next);
  assert.ok(built.delta);
  assert.deepEqual(Object.keys(built.delta.sessions.today.upsert), ['claude:a']);
  assert.deepEqual(built.delta.sessions.today.remove, ['claude:b']);
  assert.deepEqual(built.delta.sessions.month.remove, ['claude:b']);
  assert.equal(built.delta.stats.periods.today.sessions, undefined);
  assert.equal(built.delta.stats.snapshot, undefined);

  const applied = applyStatsDelta(previous, built.delta);
  const expected = {
    ...next,
    periods: {
      ...next.periods,
      allTime: { ...next.periods.allTime, sessions: previous.periods.allTime.sessions }
    }
  };
  assert.deepEqual(applied, expected);
  assert.equal(applied.periods.month.sessions['claude:b'], undefined);
  assert.equal(applied.periods.month.sessions['claude:a'].totalTokens, 15);
});

test('an unchanged snapshot needs no row upserts and still applies', () => {
  const previous = stats(1, 7, {
    today: period(10, { 'claude:a': row('a', 10) }),
    month: period(10, { 'claude:a': row('a', 10) })
  });
  const next = stats(2, 7, {
    today: period(10, { 'claude:a': row('a', 10) }),
    month: period(10, { 'claude:a': row('a', 10) })
  });
  const built = buildStatsDelta(fingerprintStats(previous), next);
  assert.deepEqual(built.delta.sessions.today, { upsert: {}, remove: [] });
  const applied = applyStatsDelta(previous, built.delta);
  assert.deepEqual(applied, next);
});

test('a period with no row changes keeps its previous session map', () => {
  const previous = stats(1, 7, {
    today: period(10, { 'claude:a': row('a', 10) }),
    month: period(10, { 'claude:a': row('a', 10) }),
    allTimeSessions: { 'claude:a': row('a', 100), 'claude:b': row('b', 200) }
  });
  const next = stats(2, 7, {
    today: period(10, { 'claude:a': row('a', 10) }),
    month: period(10, { 'claude:a': row('a', 10) })
  });
  const applied = applyStatsDelta(previous, buildStatsDelta(fingerprintStats(previous), next).delta);
  assert.deepEqual(applied, {
    ...next,
    periods: {
      ...next.periods,
      allTime: { ...next.periods.allTime, sessions: previous.periods.allTime.sessions }
    }
  });
  assert.equal(applied.periods.allTime.sessions, previous.periods.allTime.sessions);
  assert.equal(applied.periods.today.sessions, previous.periods.today.sessions);
  assert.equal(applied.periods.month.sessions, previous.periods.month.sessions);
});

test('fields removed by a full snapshot are removed by a delta too', () => {
  const previous = stats(1, 7, {
    today: period(10, { 'claude:a': row('a', 10) }),
    month: period(10, { 'claude:a': row('a', 10) })
  });
  const current = {
    ...previous,
    nativeSessions: { today: { old: row('old', 5) } },
    nativeProjects: { today: { old: { totalTokens: 5 } } },
    localRecentUsageActivity: { old: true },
    sessionDetailsOmitted: { month: true },
    periodProjectsOmitted: { month: true }
  };
  const next = stats(2, 7, {
    today: period(5, { 'claude:a': row('a', 5) }),
    month: period(5, { 'claude:a': row('a', 5) })
  });
  const applied = applyStatsDelta(current, buildStatsDelta(fingerprintStats(current), next).delta);
  assert.deepEqual(applied, next);
  for (const key of ['nativeSessions', 'nativeProjects', 'localRecentUsageActivity', 'sessionDetailsOmitted', 'periodProjectsOmitted']) {
    assert.equal(Object.hasOwn(applied, key), false, key);
  }
});

test('empty session maps survive a delta', () => {
  const previous = stats(1, 7, {
    today: period(0, {}),
    month: period(0, {})
  });
  const next = stats(2, 7, {
    today: period(0, {}),
    month: period(0, {})
  });
  const applied = applyStatsDelta(previous, buildStatsDelta(fingerprintStats(previous), next).delta);
  assert.deepEqual(applied.periods.today.sessions, {});
  assert.deepEqual(applied.periods.month.sessions, {});
  assert.deepEqual(applied, next);
});

test('a source change, a reused snapshot or a missing base requires a full read', () => {
  const previous = stats(1, 7, {
    today: period(10, { 'claude:a': row('a', 10) }),
    month: period(10, { 'claude:a': row('a', 10) })
  });
  const otherSource = stats(2, 8, {
    today: period(10, { 'claude:a': row('a', 10) }),
    month: period(10, { 'claude:a': row('a', 10) })
  });
  assert.equal(buildStatsDelta(fingerprintStats(previous), otherSource).delta, null);
  const sameSnapshot = { ...previous, snapshot: previous.snapshot, updatedAt: previous.updatedAt };
  assert.equal(buildStatsDelta(fingerprintStats(previous), sameSnapshot).delta, null);

  const next = stats(2, 7, {
    today: period(20, { 'claude:a': row('a', 20) }),
    month: period(20, { 'claude:a': row('a', 20) })
  });
  const delta = buildStatsDelta(fingerprintStats(previous), next).delta;
  assert.equal(applyStatsDelta({ ...previous, snapshot: { id: 99, source: 7 } }, delta), null);
  assert.equal(applyStatsDelta(null, delta), null);
});

test('the delta payload stays small when only one row changes', () => {
  const sessions = {};
  for (let i = 0; i < 1500; i += 1) sessions[`claude:s${i}`] = row(`s${i}`, i + 1);
  const previous = stats(1, 7, {
    today: period(1500, sessions),
    month: period(1500, sessions)
  });
  const changed = { ...sessions, 'claude:s750': row('s750', 9999) };
  const next = stats(2, 7, {
    today: period(1501, changed),
    month: period(1501, changed)
  });
  const built = buildStatsDelta(fingerprintStats(previous), next);
  assert.ok(built.delta);
  assert.equal(Object.keys(built.delta.sessions.month.upsert).length, 1);
  const fullBytes = JSON.stringify(next).length;
  const deltaBytes = JSON.stringify(built.delta).length;
  assert.ok(deltaBytes < fullBytes / 10, `delta ${deltaBytes} vs full ${fullBytes}`);
  const applied = applyStatsDelta(previous, built.delta);
  assert.deepEqual(applied, next);
});
