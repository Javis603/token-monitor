'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  creditsAmount,
  creditsCurrency,
  creditsMeterPercent,
  formatCompactMoney,
  formatMoney,
  isCreditsWindow,
  spendWindow
} = require('../../src/shared/limitBalanceDisplay');

test('isCreditsWindow keys off the metric tag only', () => {
  assert.equal(isCreditsWindow({ metric: 'credits' }), true);
  assert.equal(isCreditsWindow({ kind: 'billing', label: 'Balance' }), false);
  assert.equal(isCreditsWindow(null), false);
});

test('creditsAmount prefers the window remaining, then the provider balance', () => {
  assert.equal(creditsAmount({ balance: { amount: 9 } }, { remaining: 12.5 }), 12.5);
  assert.equal(creditsAmount({ balance: { amount: 4 } }, { remaining: null }), 4);
  assert.equal(creditsAmount({}, {}), null);
  assert.equal(creditsAmount({ balance: { amount: 0 } }, {}), 0);
});

test('creditsCurrency falls back through window, balance, then USD', () => {
  assert.equal(creditsCurrency({ balance: { currency: 'USD' } }, { currency: 'CNY' }), 'CNY');
  assert.equal(creditsCurrency({ balance: { currency: 'cny' } }, {}), 'CNY');
  assert.equal(creditsCurrency({}, {}), 'USD');
  assert.equal(creditsCurrency({}, { currency: '!!' }), 'USD');
});

test('creditsMeterPercent uses the window percent when the provider reports one', () => {
  assert.equal(creditsMeterPercent({}, { usedPercent: 77 }), 23);
  assert.equal(creditsMeterPercent({}, { remainingPercent: 99 }), 99);
});

test('creditsMeterPercent derives the percent from month spend when no percent exists', () => {
  // 4 / (4 + 6) = 40%
  assert.equal(creditsMeterPercent({ balance: { amount: 4, monthSpend: 6 } }, {}), 40);
});

test('creditsMeterPercent treats an untouched balance as full', () => {
  assert.equal(creditsMeterPercent({ balance: { amount: 4, monthSpend: 0 } }, {}), 100);
  assert.equal(creditsMeterPercent({ balance: { amount: 4 } }, {}), 100);
});

test('creditsMeterPercent reports an exhausted balance as empty, and nothing without an amount', () => {
  assert.equal(creditsMeterPercent({ balance: { amount: 0, monthSpend: 12 } }, {}), 0);
  // A freshly tracked account can be exhausted before any spend is observed.
  // Reading that as "full" would paint it healthy on Home and in the tray.
  assert.equal(creditsMeterPercent({ balance: { amount: 0, monthSpend: 0 } }, {}), 0);
  assert.equal(creditsMeterPercent({ balance: { amount: 0 } }, {}), 0);
  // An overdrawn balance is still nothing left, not a negative meter.
  assert.equal(creditsMeterPercent({ balance: { amount: -5, monthSpend: 0 } }, {}), 0);
  assert.equal(creditsMeterPercent({ balance: {} }, {}), null);
  assert.equal(creditsMeterPercent({}, {}), null);
});

test('creditsMeterPercent reads the balance when handed a null window', () => {
  // The limits page meters DeepSeek straight off the provider record.
  assert.equal(creditsMeterPercent({ balance: { amount: 4, monthSpend: 6 } }, null), 40);
});

test('formatMoney uses a symbol for known currencies and a prefix otherwise', () => {
  assert.equal(formatMoney(7.006, 'USD'), '$7.01');
  assert.equal(formatMoney(4, 'CNY'), '¥4.00');
  assert.equal(formatMoney(12.5, 'EUR'), 'EUR 12.50');
  assert.equal(formatMoney(0, 'USD'), '$0.00');
  assert.equal(formatMoney(null, 'USD'), '');
});

test('formatCompactMoney only abbreviates at or above 100k', () => {
  assert.equal(formatCompactMoney(12.5, 'USD'), '$12.50');
  assert.equal(formatCompactMoney(99_999.99, 'USD'), '$99999.99');
  assert.equal(formatCompactMoney(1_250_000, 'USD'), '$1.25M');
  assert.equal(formatCompactMoney(null, 'USD'), '');
});

test('spendWindow finds the usage-credit meter by its metric', () => {
  const provider = {
    windows: [
      { kind: 'session', usedPercent: 8 },
      { kind: 'billing', metric: 'spend', label: 'Usage credits', used: 2.35, limit: 20, currency: 'USD' },
      { kind: 'billing', metric: 'credits', label: 'Balance', remaining: 113.44, currency: 'USD' }
    ]
  };
  const window = spendWindow(provider);
  assert.equal(window.used, 2.35);
  assert.equal(window.metric, 'spend');
});

// A hub older than the `spend` metric drops it while keeping the window, so the
// row would silently disappear on new widget -> old hub -> new renderer.
test('spendWindow still finds the meter after an older hub strips the metric', () => {
  const asOlderHubWouldStore = {
    windows: [
      { kind: 'session', usedPercent: 8 },
      { kind: 'billing', label: 'Usage credits', used: 2.35, limit: 20, usedPercent: 11.75, currency: 'USD' }
    ]
  };
  const window = spendWindow(asOlderHubWouldStore);
  assert.equal(window.used, 2.35, 'the legacy label fallback must keep the row visible');
  assert.equal(window.limit, 20);
});

test('spendWindow does not mistake a balance row for the spend meter', () => {
  const provider = {
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 113.44, currency: 'USD' }]
  };
  assert.equal(spendWindow(provider), null);
  assert.equal(spendWindow({ windows: [] }), null);
  assert.equal(spendWindow(null), null);
});
