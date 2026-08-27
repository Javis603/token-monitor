'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { accountRowKey, accountRowsForPeriod } = require('../../src/electron/renderer/accountRows');

const colors = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'];
const stableColor = (value, palette) => palette[Math.abs(String(value).length) % palette.length];

test('accountRowKey requires both client and account key', () => {
  assert.equal(accountRowKey('workbuddy', 'user-a'), 'workbuddy:user-a');
  assert.equal(accountRowKey('workbuddy', ''), '');
  assert.equal(accountRowKey('', 'user-a'), '');
  assert.equal(accountRowKey(' workbuddy ', ' user-a '), 'workbuddy:user-a');
});

test('accountRowsForPeriod builds one row per account from the rollup', () => {
  const rows = accountRowsForPeriod({
    accounts: {
      'workbuddy:user-a': { client: 'workbuddy', accountKey: 'user-a', tokens: 100, costUsd: 0.5 },
      'workbuddy:user-b': { client: 'workbuddy', accountKey: 'user-b', tokens: 40, costUsd: 0.2 },
      'trae:user-c': { client: 'trae', accountKey: 'user-c', accountLabel: 'Trae account', tokens: 10, costUsd: 0 }
    }
  }, { clientLabels: { workbuddy: 'WorkBuddy' }, stableColor, fallbackColors: colors });

  assert.equal(rows.length, 3);
  assert.equal(rows[0].key, 'workbuddy:user-a');
  assert.equal(rows[0].name, 'user-a');
  assert.equal(rows[0].subtitle, 'WorkBuddy');
  assert.equal(rows[0].value, 100);
  assert.equal(rows[0].cost, 0.5);
  assert.equal(rows[0].stale, false);
  // Sorted by cost desc.
  assert.equal(rows[0].cost >= rows[1].cost, true);
  // Client without a known label falls back to the raw client id.
  const traeRow = rows.find((row) => row.client === 'trae');
  assert.equal(traeRow.subtitle, 'trae');
  assert.equal(traeRow.name, 'Trae account');
});

test('accountRowsForPeriod shortens an unlabeled hashed account key', () => {
  const accountKey = `sha256:${'a'.repeat(64)}`;
  const rows = accountRowsForPeriod({
    accounts: {
      [`trae-cn:${accountKey}`]: { client: 'trae-cn', accountKey, tokens: 12, costUsd: 0 }
    }
  }, { stableColor, fallbackColors: colors });
  assert.equal(rows[0].name, `…${'a'.repeat(12)}`);
});

test('accountRowsForPeriod falls back to sessions when the rollup is absent', () => {
  const rows = accountRowsForPeriod({
    sessions: {
      'workbuddy:s1': { client: 'workbuddy', sessionId: 's1', accountKey: 'user-a', totalTokens: 30, costUsd: 0.3 },
      'workbuddy:s2': { client: 'workbuddy', sessionId: 's2', accountKey: 'user-a', totalTokens: 20, costUsd: 0.2 },
      'workbuddy:s3': { client: 'workbuddy', sessionId: 's3', totalTokens: 50, costUsd: 0.5 }
    }
  }, { stableColor, fallbackColors: colors });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'workbuddy:user-a');
  assert.equal(rows[0].value, 50);
  assert.equal(rows[0].cost, 0.5);
});

test('accountRowsForPeriod ignores empty accounts and unusable shapes', () => {
  assert.deepEqual(accountRowsForPeriod({ accounts: {} }, { stableColor, fallbackColors: colors }), []);
  assert.deepEqual(accountRowsForPeriod({ accounts: { bad: null, worse: 'string' } }, { stableColor, fallbackColors: colors }), []);
  assert.deepEqual(accountRowsForPeriod(null, { stableColor, fallbackColors: colors }), []);
  assert.deepEqual(accountRowsForPeriod({}, { stableColor, fallbackColors: colors }), []);
  // Zero-usage accounts render nothing rather than an empty 0-token row.
  assert.deepEqual(accountRowsForPeriod({
    accounts: { 'workbuddy:zero': { client: 'workbuddy', accountKey: 'zero', tokens: 0, costUsd: 0 } }
  }, { stableColor, fallbackColors: colors }), []);
});

test('accountRowsForPeriod assigns a stable color per account key', () => {
  const period = { accounts: { 'workbuddy:user-a': { client: 'workbuddy', accountKey: 'user-a', tokens: 1, costUsd: 0 } } };
  const first = accountRowsForPeriod(period, { stableColor, fallbackColors: colors });
  const second = accountRowsForPeriod(period, { stableColor, fallbackColors: colors });
  assert.equal(first[0].color, second[0].color);
  assert.ok(colors.includes(first[0].color));
  assert.equal(first[0].barBackground, first[0].color);
});
