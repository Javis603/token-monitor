'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { LANGUAGE_OPTIONS, MESSAGES } = require('../../src/electron/renderer/i18n');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(ROOT, 'src/electron/renderer/styles.css'), 'utf8');

test('all widget collector modes capture local Codex quota evidence before publishing', () => {
  assert.match(main, /require\('\.\.\/shared\/codexWeeklyCapacity'\)/);
  assert.match(main, /app\.getPath\('userData'\), 'codex-weekly-capacity\.json'/);
  assert.equal((main.match(/captureCodexWeeklyCapacity\(lastCollectedDevice\);/g) || []).length, 3);
  assert.match(main, /attachCodexWeeklyCapacityEstimates\(projected, ensureCodexWeeklyCapacityArchive\(\)/);
});

test('the estimate is rendered only inside the Codex weekly window', () => {
  assert.match(renderer, /function codexWeeklyCapacityNode\(estimate\)/);
  assert.match(
    renderer,
    /if \(weekly\) \{[\s\S]*?codexWeeklyCapacityNode\(provider\.weeklyCapacityEstimate\)[\s\S]*?weeklyNode\.append\(capacity\)/
  );
  assert.match(styles, /\.codex-weekly-capacity \{/);
  assert.match(styles, /\.codex-weekly-capacity-status\.stable/);
});

test('weekly capacity copy exists in every bundled locale', () => {
  const keys = [
    'limits.codex.weeklyCapacity',
    'limits.codex.weeklyCapacityTokens',
    'limits.codex.weeklyCapacityLocalOnly',
    'limits.codex.weeklyCapacity.collecting',
    'limits.codex.weeklyCapacity.stable',
    'limits.codex.weeklyCapacity.preliminary',
    'limits.codex.weeklyCapacity.unstable',
    'limits.codex.weeklyCapacity.unavailable',
    'limits.codex.weeklyCapacity.change'
  ];
  for (const locale of LANGUAGE_OPTIONS.map((option) => option.value).filter((value) => value !== 'auto')) {
    for (const key of keys) assert.ok(MESSAGES[locale][key], `${locale}: ${key}`);
  }
});
