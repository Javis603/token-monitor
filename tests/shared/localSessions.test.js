'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mergedLocalAllTimeSessions } = require('../../src/shared/localSessions');

test('rebuilds all-time sessions from the local device when the hub dropped them', () => {
  const periods = {
    month: { sessions: {} },
    allTime: { sessions: {} } // stripped on the wire by syncPayload (#118)
  };
  const localDevice = {
    allTime: { sessions: { 'claude:s1': { totalTokens: 100, client: 'claude', sessionId: 's1' } } }
  };

  assert.deepEqual(mergedLocalAllTimeSessions(periods, localDevice), {
    'claude:s1': { totalTokens: 100, client: 'claude', sessionId: 's1' }
  });
});

test('unions cross-device month sessions the local device does not have', () => {
  const periods = {
    month: { sessions: { 'codex:remote': { totalTokens: 20, client: 'codex', sessionId: 'remote' } } },
    allTime: { sessions: {} }
  };
  const localDevice = {
    allTime: { sessions: { 'claude:local': { totalTokens: 100, client: 'claude', sessionId: 'local' } } }
  };

  assert.deepEqual(
    Object.keys(mergedLocalAllTimeSessions(periods, localDevice)).sort(),
    ['claude:local', 'codex:remote']
  );
});

test('local all-time value wins over the month-scoped value for the same session', () => {
  const periods = {
    month: { sessions: { 'claude:s1': { totalTokens: 30, client: 'claude', sessionId: 's1' } } },
    allTime: { sessions: {} }
  };
  const localDevice = {
    allTime: { sessions: { 'claude:s1': { totalTokens: 100, client: 'claude', sessionId: 's1' } } }
  };

  assert.equal(mergedLocalAllTimeSessions(periods, localDevice)['claude:s1'].totalTokens, 100);
});

test('falls back to the hub month sessions as the startup placeholder before local data lands', () => {
  const periods = {
    month: { sessions: {
      'codex:recent': { totalTokens: 20, client: 'codex', sessionId: 'recent', lastUsedAt: '2026-07-12T09:00:00Z' }
    } },
    allTime: { sessions: {} } // stripped on the wire
  };

  // No local device yet (first frame after launch) -> the TOTAL view shows the hub's
  // cross-device month sessions instead of blanking / falling back to a model list.
  assert.deepEqual(mergedLocalAllTimeSessions(periods, null), {
    'codex:recent': { totalTokens: 20, client: 'codex', sessionId: 'recent', lastUsedAt: '2026-07-12T09:00:00Z' }
  });
  assert.deepEqual(mergedLocalAllTimeSessions(periods, undefined), periods.month.sessions);
});

test('tolerates missing periods and device without throwing', () => {
  assert.deepEqual(mergedLocalAllTimeSessions(undefined, undefined), {});
  assert.deepEqual(mergedLocalAllTimeSessions({}, {}), {});
  assert.deepEqual(mergedLocalAllTimeSessions({ allTime: {} }, { allTime: {} }), {});
});
