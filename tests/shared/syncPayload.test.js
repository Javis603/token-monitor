'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { syncPayload } = require('../../src/shared/syncPayload');

test('syncPayload bounds uploads by omitting all-time sessions', () => {
  const summary = {
    deviceId: 'dev-a',
    today: { totalTokens: 10, sessions: { today: { totalTokens: 10 } } },
    month: { totalTokens: 20, sessions: { month: { totalTokens: 20 } } },
    allTime: {
      totalTokens: 30,
      clients: { claude: 30 },
      models: { opus: 30 },
      sessions: { old: { totalTokens: 30 } }
    },
    history: { daily: [{ date: '2026-07-11', totalTokens: 10 }] },
    limits: { providers: [] }
  };

  const payload = syncPayload(summary);

  assert.equal(Object.hasOwn(payload.allTime, 'sessions'), false);
  assert.deepEqual(payload.today, summary.today);
  assert.deepEqual(payload.month, summary.month);
  assert.deepEqual(payload.allTime.clients, summary.allTime.clients);
  assert.deepEqual(payload.allTime.models, summary.allTime.models);
  assert.deepEqual(payload.history, summary.history);
  assert.equal(summary.allTime.sessions.old.totalTokens, 30);
});
