'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CURRENCY_CODES,
  convertUsd,
  formatCurrencyFromUsd,
  currencyFractionDigits,
  normalizeCurrency,
  configureRates,
  resolveEffectiveRates
} = require('../../src/shared/currency');

test('currency options keep USD as the default first option', () => {
  assert.deepEqual(CURRENCY_CODES, ['USD', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'HKD', 'INR', 'JPY', 'KRW', 'SGD', 'TWD']);
  assert.equal(normalizeCurrency(), 'USD');
  assert.equal(normalizeCurrency(''), 'USD');
  assert.equal(normalizeCurrency('twd'), 'TWD');
  assert.equal(normalizeCurrency('krw'), 'KRW');
  assert.equal(normalizeCurrency('jpy'), 'JPY');
  assert.equal(normalizeCurrency('zar'), 'USD');
});

test('converts USD costs into supported display currencies (built-in defaults)', () => {
  configureRates(null);
  assert.equal(convertUsd(1, 'USD'), 1);
  assert.equal(convertUsd(1, 'TWD'), 31.5);
  assert.equal(convertUsd(1, 'HKD'), 7.8);
  assert.equal(convertUsd(1, 'CNY'), 6.8);
  assert.equal(convertUsd(1, 'KRW'), 1380);
});

test('formats converted costs with unambiguous symbols (built-in defaults)', () => {
  configureRates(null);
  assert.equal(formatCurrencyFromUsd(1, 'USD'), '$1.0000');
  assert.equal(formatCurrencyFromUsd(1, 'TWD'), 'NT$31.50');
  assert.equal(formatCurrencyFromUsd(1, 'HKD'), 'HK$7.80');
  assert.equal(formatCurrencyFromUsd(1, 'CNY'), '¥6.80');
  // The won has no sub-unit, so a converted cost carries no decimals.
  assert.equal(formatCurrencyFromUsd(1, 'KRW'), '₩1380');
});

test('recorded amounts use whole yen and won and two decimals for other currencies', () => {
  assert.equal(currencyFractionDigits('krw'), 0);
  assert.equal(currencyFractionDigits('jpy'), 0);
  for (const code of CURRENCY_CODES.filter(code => !['JPY', 'KRW'].includes(code))) {
    assert.equal(currencyFractionDigits(code), 2);
  }
});

test('configureRates overlays active rates and null resets to defaults', () => {
  configureRates({ CNY: 7.25, TWD: 0, HKD: -1, JPY: 150 });
  assert.equal(convertUsd(1, 'CNY'), 7.25);   // valid override applied
  assert.equal(convertUsd(1, 'TWD'), 31.5);   // zero ignored -> default floor
  assert.equal(convertUsd(1, 'HKD'), 7.8);    // negative ignored -> default floor
  configureRates(null);
  assert.equal(convertUsd(1, 'CNY'), 6.8);    // reset to default
});

test('resolveEffectiveRates applies override > fetched > builtIn', () => {
  const eff = resolveEffectiveRates({ CNY: 6.9, TWD: 31.2 }, { CNY: 7.25 });
  assert.equal(eff.CNY, 7.25);  // override wins
  assert.equal(eff.TWD, 31.2);  // fetched used
  assert.equal(eff.HKD, 7.8);   // neither -> builtIn floor
  assert.equal(eff.USD, 1);
});

test('resolveEffectiveRates ignores non-positive / non-finite inputs', () => {
  const eff = resolveEffectiveRates({ CNY: 0 }, { CNY: NaN, TWD: -3 });
  assert.equal(eff.CNY, 6.8);   // 0 fetched + NaN override -> floor
  assert.equal(eff.TWD, 31.5);  // negative override -> floor
});

test('new currencies convert and format with distinct symbols and currency precision', () => {
  configureRates(null);
  for (const [code, rate, text] of [
    ['AUD', 1.44, 'A$14.40'], ['BRL', 5.51, 'R$55.10'],
    ['CAD', 1.41, 'CA$14.10'], ['CHF', 0.82, 'CHF 8.20'],
    ['EUR', 0.89, '€8.90'], ['GBP', 0.74, '£7.40'],
    ['INR', 93.62, '₹936.20'], ['JPY', 158, 'JP¥1580'], ['SGD', 1.28, 'S$12.80']
  ]) {
    assert.equal(convertUsd(1, code), rate);
    assert.equal(formatCurrencyFromUsd(10, code), text);
  }
  configureRates({ JPY: 160 });
  assert.equal(formatCurrencyFromUsd(1, 'JPY'), 'JP¥160');
  configureRates(null);
});

test('Main currency selector matches the shared USD-first alphabetical order', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../src/electron/renderer/index.html'), 'utf8');
  const select = html.match(/<select id="currencyInput">([\s\S]*?)<\/select>/)[1];
  const codes = Array.from(select.matchAll(/<option value="([A-Z]+)"/g), match => match[1]);
  assert.deepEqual(codes, CURRENCY_CODES);
});
