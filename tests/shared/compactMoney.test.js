'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const currency = require('../../src/shared/currency');
const { formatCompactCurrencyFromUsd } = require('../../src/shared/compactMoney');
const compactMoneyPath = require.resolve('../../src/shared/compactMoney');

test('compact currency follows localized compact units', () => {
  currency.configureRates({ CNY: 7.25 });
  try {
    assert.equal(formatCompactCurrencyFromUsd(10_000, 'CNY', 'localized', 'zh-TW'), '¥7.25萬');
    assert.equal(formatCompactCurrencyFromUsd(61_900, 'USD', 'localized', 'zh-CN'), '$6.19万');
  } finally {
    currency.configureRates(null);
  }
});

test('compact currency keeps western units when the locale does not support localized units', () => {
  assert.equal(formatCompactCurrencyFromUsd(61_900, 'USD', 'localized', 'en'), '$61.9K');
});

test('compact money module does not pollute the Node global scope', () => {
  delete globalThis.TokenMonitorCompactMoney;
  delete require.cache[compactMoneyPath];
  require(compactMoneyPath);
  assert.equal(Object.hasOwn(globalThis, 'TokenMonitorCompactMoney'), false);
});

test('compact currency preserves exact currency precision below the unit threshold', () => {
  assert.equal(formatCompactCurrencyFromUsd(0.125, 'USD', 'localized', 'zh-TW'), '$0.1250');
  assert.equal(formatCompactCurrencyFromUsd(999, 'USD', 'localized', 'zh-TW'), '$999.00');
  assert.equal(formatCompactCurrencyFromUsd(999.5, 'USD', 'western', 'en'), '$999.50');
  assert.equal(formatCompactCurrencyFromUsd(9_999.5, 'USD', 'localized', 'zh-TW'), '$9999.50');
});
