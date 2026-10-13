const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { project } = require('../../src/electron/renderer/homeActivityModes');
const options = { startDate: '2026-09-27', endDate: '2026-10-10' };
const rows = Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 27 + i)).toISOString().slice(0, 10), tokens: i + 1, cost: (i + 1) / 2 }));

test('activity modes calculate daily, Sunday-based weekly, and displayed-range cumulative values', () => {
  const before = JSON.stringify(rows);
  const daily = project(rows, options), weekly = project(rows, { ...options, mode: 'weekly' });
  const cumulative = project(rows, { ...options, mode: 'cumulative' });
  assert.deepEqual(daily.points.map(p => p.displayValue), rows.map(p => p.tokens));
  assert.deepEqual(weekly.points.map(p => p.displayValue), [...Array(7).fill(28), ...Array(7).fill(77)]);
  assert.equal(weekly.points[0].rangeEnd, '2026-10-03');
  assert.equal(weekly.points[7].rangeStart, '2026-10-04');
  assert.equal(cumulative.points.at(-1).displayValue, 105);
  assert.equal(cumulative.points[3].displayValue, 10);
  assert.equal(cumulative.points[3].rangeStart, '2026-09-27');
  assert.deepEqual(weekly.points.map(p => p.tokens), rows.map(p => p.tokens));
  assert.equal(JSON.stringify(rows), before);
});
test('quiet days carry a cumulative sum without inventing original daily usage', () => {
  const data = [rows[0], rows[3]];
  const p = project(data, { ...options, mode: 'cumulative' }).points;
  assert.equal(p[1].tokens, 0); assert.equal(p[1].displayValue, 1);
  assert.equal(p[3].displayValue, 5); assert.equal(p.at(-1).displayValue, 5);
  assert.equal(project(data, options).points[1].displayValue, 0);
});
test('weekly and cumulative windows exclude older and future records; cost remains independent', () => {
  const data = [{ date: '2026-09-26', tokens: 9000 }, ...rows, { date: '2026-10-11', tokens: 8000 }];
  const partial = { startDate: '2026-09-29', endDate: '2026-10-07', mode: 'weekly' };
  const p = project(data, partial).points;
  assert.equal(p.length, 9); assert.equal(p[0].displayValue, 25);
  assert.equal(p[0].rangeStart, partial.startDate); assert.equal(p.at(-1).rangeEnd, partial.endDate);
  assert.equal(p.at(-1).displayValue, 38);
  assert.equal(project(data, { ...options, mode: 'cumulative', metric: 'cost' }).points.at(-1).displayValue, 52.5);
});
test('calendar iteration is stable across leap days, year boundaries and DST', () => {
  for (const [startDate, endDate, length] of [['2024-02-28','2024-03-01',3], ['2026-03-07','2026-03-10',4], ['2025-12-31','2026-01-02',3]]) {
    const p = project([], { startDate, endDate }).points;
    assert.equal(p.length, length); assert.equal(new Set(p.map(p => p.date)).size, length);
    assert.equal(p[0].date, startDate); assert.equal(p.at(-1).date, endDate);
  }
  assert.equal(project([], { endDate: '2026-10-08' }).startDate, '2025-11-01');
});
test('duplicate snapshots replace, bad dates and values are ignored, and invalid modes use daily', () => {
  const data = [rows[0], { ...rows[0], tokens: 20 }, { date: '2026-09-28', tokens: NaN, cost: -1 }, { date: '2026-09-29', tokens: Infinity }, { date: '2026-02-30', tokens: 500 }];
  const p = project(data, { ...options, mode: 'bad' });
  assert.equal(p.mode, 'daily'); assert.equal(p.points[0].displayValue, 20);
  assert.equal(p.points[1].tokens, 0); assert.equal(p.points[1].cost, 0);
  assert.equal(p.points[2].displayValue, 0);
  assert.deepEqual(project([], { endDate: '2026-02-30' }).points, []);
  assert.deepEqual(project([], { ...options, startDate: '2027-01-01' }).points, []);
});
test('activity mode preference is normalized at default, reload and patch boundaries', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const normalize = main.match(/function normalizeHomeActivityMode\(value\) \{[\s\S]*?\n\}/)[0];
  const fn = vm.runInNewContext(`(${normalize})`);
  for (const mode of ['daily','weekly','cumulative']) assert.equal(fn(mode), mode);
  assert.equal(fn('invalid'), 'daily');
  assert.match(main, /homeActivityMode: 'daily'/);
  assert.match(main, /merged\.homeActivityMode = normalizeHomeActivityMode\(merged\.homeActivityMode\)/);
  assert.match(main, /normalizedPatch\.homeActivityMode = normalizeHomeActivityMode\(patch\.homeActivityMode\)/);
  const { MESSAGES } = require('../../src/electron/renderer/i18n');
  for (const messages of Object.values(MESSAGES)) for (const mode of ['daily','weekly','cumulative']) {
    assert.ok(messages[`home.activityMode.${mode}`]); assert.ok(messages[`home.activityMode.${mode}Hint`]);
  }
});
