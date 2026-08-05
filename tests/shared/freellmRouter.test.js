'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  proxyChatCompletion,
  selectKey,
  worstQuotaWindow
} = require('../../src/shared/freellmRouter');

function quota(accountId, usedPercent, status = 'ok') {
  return {
    accountId,
    status,
    windows: [{ kind: 'weekly', usedPercent, resetsAt: '2030-01-01T00:00:00.000Z' }]
  };
}

test('selectKey uses the first enabled key whose monitored account has quota', () => {
  const keys = [
    { id: 'first', apiKey: 'one', ollamaAccountId: 'account-1', enabled: true },
    { id: 'second', apiKey: 'two', ollamaAccountId: 'account-2', enabled: true }
  ];
  const selection = selectKey(keys, [quota('account-1', 98), quota('account-2', 24)], 97);
  assert.equal(selection.key.id, 'second');
});

test('selectKey refuses keys without a current successful monitored quota', () => {
  const key = { id: 'only', apiKey: 'one', ollamaAccountId: 'account-1', enabled: true };
  assert.equal(selectKey([key], [], 97), null);
  assert.equal(selectKey([key], [quota('account-1', 2, 'unavailable')], 97), null);
});

test('worstQuotaWindow selects the most-consumed monitored window', () => {
  assert.deepEqual(worstQuotaWindow({ windows: [
    { kind: 'session', usedPercent: 12 },
    { kind: 'weekly', usedPercent: 82, resetsAt: '2030-01-01T00:00:00.000Z' }
  ] }), { usedPercent: 82, resetsAt: '2030-01-01T00:00:00.000Z' });
});

test('router retries the next routing key after an upstream 429', async () => {
  const calls = [];
  const result = await proxyChatCompletion({
    config: { thresholdPercent: 97, upstreamBaseUrl: 'https://upstream.example/v1' },
    keys: [
      { id: 'first', apiKey: 'one', ollamaAccountId: 'account-1', enabled: true },
      { id: 'second', apiKey: 'two', ollamaAccountId: 'account-2', enabled: true }
    ],
    quotas: [quota('account-1', 5), quota('account-2', 5)],
    fetchFn: async (_url, options) => {
      calls.push(options.headers.authorization);
      if (calls.length === 1) return new Response(JSON.stringify({ error: 'limited' }), { status: 429 });
      return new Response(JSON.stringify({ id: 'chatcmpl_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    body: JSON.stringify({ model: 'test', messages: [] })
  });
  assert.deepEqual(calls, ['Bearer one', 'Bearer two']);
  assert.equal(result.selection.key.id, 'second');
  assert.equal(result.response.status, 200);
});
