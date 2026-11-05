'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const spend = require('../../src/shared/providers/trae/spendHistory');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-trae-spend-'));
  return { dir, options: { spendHistoryPath: path.join(dir, 'trae-credit-spend.json') } };
}

const at = (iso) => new Date(iso).getTime();

test('the first observation only seeds the day, it is not a spend', () => {
  const history = spend.recordObservation(spend.emptyHistory(), { used: 1528.06, at: at('2026-11-05T09:00:00') });
  const summary = spend.summarizeSpend(history, { now: at('2026-11-05T09:00:00') });
  assert.equal(summary.todaySpend, 0);
  assert.equal(summary.weekSpend, 0);
  assert.equal(history.days['2026-11-05'].first, 1528.06);
});

test('later observations in the same day become that day\'s spend', () => {
  let history = spend.recordObservation(spend.emptyHistory(), { used: 1528, at: at('2026-11-05T09:00:00') });
  history = spend.recordObservation(history, { used: 1540.5, at: at('2026-11-05T12:00:00') });
  history = spend.recordObservation(history, { used: 1552.25, at: at('2026-11-05T18:00:00') });
  const summary = spend.summarizeSpend(history, { now: at('2026-11-05T18:00:00') });
  assert.equal(summary.todaySpend, 24.25);
  assert.equal(summary.weekSpend, 24.25);
  assert.equal(summary.monthSpend, 24.25);
});

test('separate days accumulate into the week and month windows, not into today', () => {
  let history = spend.emptyHistory();
  history = spend.recordObservation(history, { used: 100, at: at('2026-11-01T10:00:00') });
  history = spend.recordObservation(history, { used: 110, at: at('2026-11-01T20:00:00') });
  history = spend.recordObservation(history, { used: 110, at: at('2026-11-04T10:00:00') });
  history = spend.recordObservation(history, { used: 125, at: at('2026-11-04T20:00:00') });
  history = spend.recordObservation(history, { used: 125, at: at('2026-11-05T10:00:00') });
  history = spend.recordObservation(history, { used: 130, at: at('2026-11-05T11:00:00') });
  const summary = spend.summarizeSpend(history, { now: at('2026-11-05T12:00:00') });
  assert.equal(summary.todaySpend, 5);
  assert.equal(summary.weekSpend, 30);
  assert.equal(summary.monthSpend, 30);
});

test('a counter that goes backwards is a top-up, never a negative spend', () => {
  let history = spend.recordObservation(spend.emptyHistory(), { used: 500, at: at('2026-11-05T09:00:00') });
  history = spend.recordObservation(history, { used: 520, at: at('2026-11-05T10:00:00') });
  history = spend.recordObservation(history, { used: 50, at: at('2026-11-05T11:00:00') }); // plan reset
  history = spend.recordObservation(history, { used: 70, at: at('2026-11-05T12:00:00') });
  const summary = spend.summarizeSpend(history, { now: at('2026-11-05T12:00:00') });
  assert.equal(summary.todaySpend, 20);
  assert.ok(summary.todaySpend >= 0);
});

test('the store keeps only the newest bounded window of days', () => {
  let history = spend.emptyHistory();
  for (let i = 0; i < spend.MAX_DAYS + 10; i += 1) {
    const day = new Date(2026, 0, 1 + i, 10, 0, 0);
    history = spend.recordObservation(history, { used: i, at: day.getTime() });
  }
  assert.equal(Object.keys(history.days).length, spend.MAX_DAYS);
});

test('readHistory tolerates a missing or corrupt file', () => {
  const { dir, options } = tempStore();
  try {
    assert.deepEqual(spend.readHistory(options), spend.emptyHistory());
    fs.writeFileSync(options.spendHistoryPath, '{not json');
    assert.deepEqual(spend.readHistory(options), spend.emptyHistory());
    fs.writeFileSync(options.spendHistoryPath, JSON.stringify({ version: 99, days: {} }));
    assert.deepEqual(spend.readHistory(options), spend.emptyHistory());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trackSpend persists between calls and reports the delta', () => {
  const { dir, options } = tempStore();
  try {
    const first = spend.trackSpend({ used: 1000, at: at('2026-11-05T09:00:00'), options });
    assert.equal(first.todaySpend, 0);
    const second = spend.trackSpend({ used: 1012.5, at: at('2026-11-05T10:00:00'), options });
    assert.equal(second.todaySpend, 12.5);
    // Third call re-reads what the second one wrote.
    const third = spend.trackSpend({ used: 1020, at: at('2026-11-05T11:00:00'), options });
    assert.equal(third.todaySpend, 20);
    assert.equal(spend.readHistory(options).days['2026-11-05'].last, 1020);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unusable path degrades to a summary instead of throwing', () => {
  const options = { spendHistoryPath: path.join(os.tmpdir(), 'tl-trae-spend-missing-dir', 'x', 'y.json') };
  const summary = spend.trackSpend({ used: 10, at: Date.now(), options });
  assert.equal(summary.todaySpend, 0);
  assert.deepEqual(Object.keys(summary).sort(), ['monthSpend', 'todaySpend', 'trackedDays', 'weekSpend']);
});
