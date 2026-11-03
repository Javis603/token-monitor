'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const items = require(path.join(rendererDir, 'edgeDock', 'items'));
const presentation = require(path.join(rendererDir, 'edgeDock', 'presentation'));
const fixedPeriodRanges = require(path.join(rendererDir, 'fixedPeriodRanges'));
const { LANGUAGE_OPTIONS, MESSAGES } = require(path.join(rendererDir, 'i18n'));

function cacheCell(today, otherPeriods = {}) {
  return presentation.buildEdgeDockCells({ periods: { ...otherPeriods, today } }, {
    items: [{ type: 'stat', metric: 'cacheHit' }]
  })[0];
}

test('cacheHit uses the shared Tool detail input split for the whole day', () => {
  const today = {
    totalTokens: 4000, cacheReadTokens: 2100, cacheWriteTokens: 100,
    outputTokens: 800, unclassifiedTokens: 0, capabilities: { tokenComponents: true }
  };
  const cell = cacheCell(today, { month: { ...today, totalTokens: 8000 } });
  const split = fixedPeriodRanges.tokenComponentBreakdown(today);
  assert.deepEqual(cell, {
    id: 'stat:cacheHit', kind: 'stat', metric: 'cacheHit', period: 'today',
    available: true, hit: split.cacheRead, miss: split.cacheMiss, rate: 65.625
  });
});

test('cacheHit excludes unclassified tokens and output from the measured input', () => {
  const cell = cacheCell({
    totalTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 100,
    outputTokens: 100, unclassifiedTokens: 100, capabilities: { tokenComponents: true }
  });
  assert.equal(cell.hit, 600);
  assert.equal(cell.miss, 200);
  assert.equal(cell.rate, 75);
});

test('cacheHit remains unavailable for missing, total-only, empty and output-only readings', () => {
  for (const today of [undefined, { totalTokens: 300 },
    { totalTokens: 0, capabilities: { tokenComponents: true } },
    { totalTokens: 300, outputTokens: 300, capabilities: { tokenComponents: true } }]) {
    const cell = cacheCell(today);
    assert.equal(cell.available, false);
    assert.equal(cell.rate, null);
  }
});

test('cacheHit distinguishes measured zero hits from missing telemetry', () => {
  const cell = cacheCell({
    totalTokens: 300, outputTokens: 100, capabilities: { tokenComponents: true }
  });
  assert.equal(cell.available, true);
  assert.equal(cell.hit, 0);
  assert.equal(cell.miss, 200);
  assert.equal(cell.rate, 0);
});

test('cache writes remain misses even without an explicit component capability', () => {
  const cell = cacheCell({ totalTokens: 100, cacheWriteTokens: 100 });
  assert.equal(cell.available, true);
  assert.equal(cell.hit, 0);
  assert.equal(cell.miss, 100);
  assert.equal(cell.rate, 0);
});

test('cacheHit reads aggregate counters without accessing sessions or activity', () => {
  const today = {
    totalTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 100,
    outputTokens: 200, capabilities: { tokenComponents: true }
  };
  for (const key of ['sessions', 'sessionActivity']) Object.defineProperty(today, key, {
    get() { throw new Error(`Cache hit must not read ${key}`); }
  });
  const cell = cacheCell(today);
  assert.equal(cell.rate, 75);
  for (const key of ['sessions', 'runningCount', 'runningExpiresAt']) assert.equal(Object.hasOwn(cell, key), false);
});

test('the browser loads the canonical component split before dock presentation', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'edgeDock', 'index.html'), 'utf8');
  const split = html.indexOf('src="../fixedPeriodRanges.js"');
  assert.ok(split > 0);
  assert.ok(split < html.indexOf('src="presentation.js"'));
});

test('cacheHit remains selectable and localized at every dock surface', () => {
  assert.ok(items.STAT_METRICS.includes('cacheHit'));
  assert.deepEqual(items.normalizeEdgeDockItems([{ type: 'stat', metric: 'cacheHit' }]), [
    { type: 'stat', metric: 'cacheHit' }
  ]);
  for (const locale of LANGUAGE_OPTIONS.map(option => option.value).filter(value => value !== 'auto')) {
    for (const key of ['edgeDock.period.cacheHit', 'edgeDock.periodShort.cacheHit',
      'edgeDock.cacheHit.hit', 'edgeDock.cacheHit.miss', 'edgeDock.cacheHit.description',
      'edgeDock.cacheHit.unavailable']) assert.ok(MESSAGES[locale][key]?.trim(), `${locale}: ${key}`);
    assert.match(MESSAGES[locale]['edgeDock.cacheHit.detail'], /\{hit\}.*\{miss\}/u);
  }
});

test('cacheHit formatting preserves locale, small nonzero readings, zero and unavailable', () => {
  const dock = fs.readFileSync(path.join(rendererDir, 'edgeDock', 'dock.js'), 'utf8');
  const start = dock.indexOf('function formatCacheHitRate(');
  const end = dock.indexOf('function cacheHitDetail(', start);
  const format = Function('state', `return (${dock.slice(start, end).trim()})`)({ locale: 'pt-BR' });
  assert.equal(format(65.625), '65,6%');
  assert.equal(format(0.05), '<0,1%');
  assert.equal(format(0), '0,0%');
  assert.equal(format(null), '—');
});
