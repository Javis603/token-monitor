'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const compactTokens = require('../../src/shared/compactTokens');

test('compact token units normalize unknown values to western', () => {
  assert.equal(compactTokens.normalizeCompactTokenUnits('localized'), 'localized');
  assert.equal(compactTokens.normalizeCompactTokenUnits('anything-else'), 'western');
  assert.equal(compactTokens.normalizeCompactTokenUnits(undefined), 'western');
});

test('localized token units are only effective for supported UI locales', () => {
  assert.equal(compactTokens.effectiveCompactTokenUnits('localized', 'en-US'), 'western');
  assert.equal(compactTokens.effectiveCompactTokenUnits('localized', 'zh-TW'), 'localized');
  assert.equal(compactTokens.effectiveCompactTokenUnits('localized', 'zh-CN'), 'localized');
  assert.equal(compactTokens.effectiveCompactTokenUnits('localized', 'ja'), 'localized');
  assert.equal(compactTokens.effectiveCompactTokenUnits('localized', 'ko'), 'localized');
});

test('compact token thresholds follow the active unit system', () => {
  assert.equal(compactTokens.compactTokenUnitThreshold('western', 'zh-TW'), 1_000);
  assert.equal(compactTokens.compactTokenUnitThreshold('localized', 'en'), 1_000);
  assert.equal(compactTokens.compactTokenUnitThreshold('localized', 'zh-TW'), 10_000);
});

test('compact token formatter uses western units and promotes rounded values', () => {
  assert.equal(compactTokens.formatCompactTokens(999), '999');
  assert.equal(compactTokens.formatCompactTokens(1_500), '1.5K');
  assert.equal(compactTokens.formatCompactTokens(2_000_000), '2M');
  assert.equal(compactTokens.formatCompactTokens(999_950), '1M');
  assert.equal(compactTokens.formatCompactTokens(999_950_000), '1B');
});

test('compact token formatter uses locale-specific East Asian units', () => {
  assert.equal(compactTokens.formatCompactTokens(9_999, 'localized', 'zh-TW'), '9999');
  assert.equal(compactTokens.formatCompactTokens(15_000, 'localized', 'zh-TW'), '1.5萬');
  assert.equal(compactTokens.formatCompactTokens(295_116_445, 'localized', 'zh-CN'), '2.95亿');
  assert.equal(compactTokens.formatCompactTokens(295_116_445, 'localized', 'ja'), '2.95億');
  assert.equal(compactTokens.formatCompactTokens(295_116_445, 'localized', 'ko'), '2.95억');
  assert.equal(compactTokens.formatCompactTokens(99_999_500, 'localized', 'zh-TW'), '1億');
});

test('tray formatting keeps its existing western precision while sharing localized units', () => {
  assert.equal(compactTokens.formatCompactTokens(12_000, 'western', 'en', { style: 'tray' }), '12.0K');
  assert.equal(compactTokens.formatCompactTokens(1_234_567_890, 'western', 'en', { style: 'tray' }), '1.23B');
  assert.equal(compactTokens.formatCompactTokens(12_000, 'localized', 'zh-TW', { style: 'tray' }), '1.2萬');
});
