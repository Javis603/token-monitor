'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { emptyPeriod } = require('../../src/shared/usage');
const { nextPageToken, rowsFromBillingPayload, supplementCursorBilling } = require('../../src/shared/providers/cursor/billingItems');

const NOW = new Date(2026, 9, 20, 15, 0, 0);
// Period windows cut at local midnight. Pin fixtures to that calendar, not a
// UTC instant that CI's timezone matrix can shift onto yesterday.
function localEventTime(year, month, day, hour = 4, minute = 56, second = 13) {
  return new Date(year, month, day, hour, minute, second, 809).toISOString();
}

function item(overrides = {}) {
  return {
    id: 'item-1',
    eventTime: localEventTime(2026, 9, 20),
    product: 'cursor',
    usageType: 'included',
    model: 'grok-4.7-high',
    usage: {
      'prompt-text-tokens': '10',
      'cached-prompt-text-tokens': '20',
      'cache-write-text-tokens': '0',
      'completion-text-tokens': '5'
    },
    ...overrides
  };
}

test('billing items keep cursor token rows and drop other products', () => {
  const rows = rowsFromBillingPayload({
    items: [
      item(),
      item({ id: 'bot', product: 'grok-bot', model: '' }),
      item({ id: 'chat', product: 'grok-chat', model: 'grok-4.7', usage: { 'prompt-text-tokens': '9' } }),
      item({ id: 'empty', usage: { 'prompt-text-tokens': '0' } })
    ]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'grok-4.7-high');
  assert.equal(rows[0].inputTokens, 10);
  assert.equal(rows[0].cacheReadTokens, 20);
  assert.equal(rows[0].outputTokens, 5);
  assert.equal(rows[0].totalTokens, 35);
});

test('auto billing items use the cursor auto model name', () => {
  const rows = rowsFromBillingPayload({ items: [item({ model: 'auto', id: 'auto' })] });
  assert.equal(rows[0].model, 'cursor-auto');
});

test('Grok dashboard response reads displayExtras.model and nested cursor pagination', () => {
  const payload = {
    data: [{
      ...item({ id: undefined, model: undefined }),
      billingItemId: 'billing-1', displayExtras: { model: 'grok-4.7-high', userEmail: 'not-stored@example.test' }
    }],
    pagination: { hasMore: true, nextCursor: 'next-page' }
  };
  assert.equal(rowsFromBillingPayload(payload).length, 1);
  assert.equal(rowsFromBillingPayload(payload)[0].model, 'grok-4.7-high');
  assert.equal(nextPageToken(payload), 'next-page');
  assert.equal(nextPageToken({ pagination: { hasMore: false, nextCursor: 'unused' } }), '');
  assert.doesNotMatch(JSON.stringify(rowsFromBillingPayload(payload)), /not-stored/);
});

test('anchor mode adds only today onto the fresh cursor partition', () => {
  const older = item({ id: 'older', eventTime: localEventTime(2026, 9, 15, 2, 0, 0) });
  const next = supplementCursorBilling({
    mode: 'anchor',
    today: emptyPeriod(),
    month: emptyPeriod(),
    allTime: emptyPeriod(),
    todayPartitions: {}
  }, rowsFromBillingPayload({ items: [item(), older] }), NOW);
  assert.equal(next.todayPartitions.cursor.clients.cursor, 35);
  assert.equal(next.todayPartitions.cursor.models['grok-4.7-high'], 35);
  assert.equal(next.month.totalTokens, 0);
});

test('a full scan adds today, the month, and the whole billing gap', () => {
  const older = item({ id: 'older', eventTime: localEventTime(2026, 9, 15, 2, 0, 0), usage: { 'prompt-text-tokens': '4' } });
  const next = supplementCursorBilling({
    mode: 'full',
    today: emptyPeriod(),
    month: emptyPeriod(),
    allTime: emptyPeriod(),
    todayPartitions: {}
  }, rowsFromBillingPayload({ items: [item(), older] }), NOW);
  assert.equal(next.today.clients.cursor, 35);
  assert.equal(next.month.clients.cursor, 39);
  assert.equal(next.allTime.models['grok-4.7-high'], 39);
  assert.equal(next.today.costUsd, 0);
  assert.equal(next.today.unpricedTokens, 35);
});

test('catalog rates estimate included billing instead of billed zero', () => {
  const pricingByModel = {
    'grok-4.7-high': {
      inputCostPerToken: 0.000002,
      outputCostPerToken: 0.000006,
      cacheReadInputTokenCost: 0.0000005
    }
  };
  const next = supplementCursorBilling({
    mode: 'full',
    today: emptyPeriod(),
    month: emptyPeriod(),
    allTime: emptyPeriod(),
    todayPartitions: {}
  }, rowsFromBillingPayload({ items: [item()] }), NOW, pricingByModel);
  assert.equal(next.today.costUsd, 10 * 0.000002 + 20 * 0.0000005 + 5 * 0.000006);
  assert.equal(next.today.unpricedTokens || 0, 0);
  assert.equal(next.today.modelCosts['grok-4.7-high'], next.today.costUsd);
});

test('paid Cursor calls use the same token accounting and catalog pricing as included calls', () => {
  const rows = rowsFromBillingPayload({ data: [item({ usageType: 'on_demand', chargedCents: 15 })] });
  const next = supplementCursorBilling({ mode: 'full', today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() },
    rows, NOW, { 'grok-4.7-high': { inputCostPerToken: 2e-6, outputCostPerToken: 6e-6, cacheReadInputTokenCost: 5e-7 } });
  assert.equal(next.today.totalTokens, 35);
  assert.equal(next.today.costUsd, 10 * 2e-6 + 5 * 6e-6 + 20 * 5e-7);
});

test('invalid or unsafe token counters cannot become fabricated zero usage', () => {
  for (const value of [-1, 1.5, 'unknown', '9007199254740992']) {
    assert.throws(() => rowsFromBillingPayload({ items: [item({ usage: { 'prompt-text-tokens': value } })] }), /Invalid Cursor billing token/);
  }
});
