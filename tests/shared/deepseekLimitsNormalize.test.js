'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeLimitProvider } = require('../../src/shared/limits');

test('normalizeLimitProvider accepts deepseek + api source + balance block', () => {
  const p = normalizeLimitProvider({
    provider: 'deepseek',
    accountKey: 'sha256:abc',
    accountLabel: 'Pay-as-you-go',
    source: 'api',
    status: 'ok',
    updatedAt: '2026-06-07T10:00:00Z',
    windows: [],
    balance: {
      amount: 4.61,
      currency: 'CNY',
      todaySpend: 0.32,
      monthSpend: 18.4,
      allTimeSpend: 27.5,
      trackingSince: '2026-05-01T00:00:00Z',
      monthSinceTracking: true
    }
  });
  assert.equal(p.provider, 'deepseek');
  assert.equal(p.source, 'api');
  assert.deepEqual(p.windows, []);
  assert.equal(p.balance.amount, 4.61);
  assert.equal(p.balance.currency, 'CNY');
  assert.equal(p.balance.todaySpend, 0.32);
  assert.equal(p.balance.allTimeSpend, 27.5);
  assert.equal(p.balance.trackingSince, '2026-05-01T00:00:00.000Z');
  assert.equal(p.balance.monthSinceTracking, true);
});

test('normalizeLimitProvider yields balance: null when absent', () => {
  const p = normalizeLimitProvider({ provider: 'deepseek', source: 'api', status: 'notConfigured', windows: [] });
  assert.equal(p.balance, null);
});
