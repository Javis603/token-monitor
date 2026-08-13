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

test('compact currency preserves fractional precision after crossing a unit threshold', () => {
  assert.equal(formatCompactCurrencyFromUsd(1_249.5, 'USD', 'western', 'en'), '$1.2K');
  assert.equal(formatCompactCurrencyFromUsd(1_250, 'USD', 'western', 'en'), '$1.3K');
  assert.equal(formatCompactCurrencyFromUsd(999_949.5, 'USD', 'western', 'en'), '$999.9K');
  assert.equal(formatCompactCurrencyFromUsd(999_950, 'USD', 'western', 'en'), '$1M');
  assert.equal(formatCompactCurrencyFromUsd(12_449.5, 'USD', 'localized', 'zh-TW'), '$1.24萬');
  assert.equal(formatCompactCurrencyFromUsd(99_999_499.5, 'USD', 'localized', 'zh-TW'), '$9999.9萬');
  assert.equal(formatCompactCurrencyFromUsd(99_999_500, 'USD', 'localized', 'zh-TW'), '$1億');
});

test('compact currency supports explicit display precision without changing auto precision', () => {
  assert.equal(
    formatCompactCurrencyFromUsd(14_789.16, 'USD', 'localized', 'zh-TW', { fractionDigits: 2 }),
    '$1.48萬'
  );
  assert.equal(
    formatCompactCurrencyFromUsd(20_000, 'USD', 'localized', 'zh-TW', { fractionDigits: 2 }),
    '$2.00萬'
  );
  assert.equal(
    formatCompactCurrencyFromUsd(0.0049, 'USD', 'western', 'en', { fractionDigits: 'auto' }),
    '$0.0049'
  );
  assert.equal(
    formatCompactCurrencyFromUsd(0.0049, 'USD', 'western', 'en', {
      compact: false,
      fractionDigits: 2
    }),
    '$0.00'
  );
});
