'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  cloneJson,
  hasSummaryPeriod,
  localDay,
  localMonth,
  numberValue,
  targetPeriod,
  toDate
} = require('../../src/shared/archiveHelpers');

test('hasSummaryPeriod reads both supported summary shapes without materializing periods', () => {
  const flat = { today: {} };
  const nested = { periods: { month: {} } };

  assert.equal(hasSummaryPeriod(flat, 'today'), true);
  assert.equal(hasSummaryPeriod(flat, 'month'), false);
  assert.equal(hasSummaryPeriod(nested, 'month'), true);
  assert.equal(hasSummaryPeriod(nested, 'allTime'), false);
  assert.deepEqual(flat, { today: {} });
  assert.deepEqual(nested, { periods: { month: {} } });
});

// These strings are the archive's bucket keys, and a restore compares a stored
// one against the same function applied to `now`. Computing them from UTC would
// file a late-evening capture under tomorrow's key west of UTC, and a small-hours
// one under yesterday's east of it, after which the day silently stops matching
// instead of failing. Each pair below brackets local midnight, so a toISOString()
// implementation is wrong about at least one probe at every offset the timezones
// CI job runs — a single probe is only wrong on one side of UTC.
test('localDay names the local calendar day at every UTC offset', () => {
  assert.equal(localDay(new Date(2026, 0, 2, 0, 30, 0)), '2026-01-02');
  assert.equal(localDay(new Date(2026, 0, 2, 23, 30, 0)), '2026-01-02');
});

test('localMonth names the local calendar month at every UTC offset', () => {
  assert.equal(localMonth(new Date(2026, 1, 1, 0, 30, 0)), '2026-02');
  assert.equal(localMonth(new Date(2026, 0, 31, 23, 30, 0)), '2026-01');
});

test('localDay pads single-digit months and days', () => {
  assert.equal(localDay(new Date(2026, 8, 6, 12, 0, 0)), '2026-09-06');
  assert.equal(localMonth(new Date(2026, 8, 6, 12, 0, 0)), '2026-09');
});

test('toDate resolves unusable input to now rather than an invalid date', () => {
  const supplied = new Date(2026, 4, 5, 6, 7, 8);
  assert.equal(toDate(supplied).getTime(), supplied.getTime());
  assert.equal(toDate('2026-05-05T06:07:08.000Z').toISOString(), '2026-05-05T06:07:08.000Z');

  for (const value of ['not a date', new Date('nope'), {}, null, undefined]) {
    const resolved = toDate(value);
    assert.ok(!Number.isNaN(resolved.getTime()), `toDate(${String(value)}) must be usable`);
  }
});

test('numberValue coerces unusable input to zero', () => {
  assert.equal(numberValue(12.5), 12.5);
  assert.equal(numberValue('7'), 7);
  assert.equal(numberValue(null), 0);
  assert.equal(numberValue(undefined), 0);
  assert.equal(numberValue('nope'), 0);
  assert.equal(numberValue(Infinity), 0);
  assert.equal(numberValue(NaN), 0);
});

test('cloneJson detaches nested values from the source', () => {
  const source = { periods: { today: { clients: { codex: 1 } } } };
  const copy = cloneJson(source);

  copy.periods.today.clients.codex = 99;
  assert.equal(source.periods.today.clients.codex, 1);
  assert.deepEqual(cloneJson(null), {});
});

test('targetPeriod normalizes in place for both summary shapes', () => {
  const flat = { today: { totalTokens: 5 } };
  const flatPeriod = targetPeriod(flat, 'today');
  assert.equal(flatPeriod.totalTokens, 5);
  assert.equal(flat.today, flatPeriod);
  assert.deepEqual(flatPeriod.clients, {});

  const nested = { periods: { month: { totalTokens: 3 } } };
  const nestedPeriod = targetPeriod(nested, 'month');
  assert.equal(nestedPeriod.totalTokens, 3);
  assert.equal(nested.periods.month, nestedPeriod);
});

// The point of this module is that there is one copy of each of these. Both
// archives carried identical private copies until they were lifted here, and a
// re-declared local one would shadow the import silently — the divergence only
// shows up as archived usage that stops restoring.
test('neither usage archive re-declares a helper this module owns', () => {
  const owned = ['cloneJson', 'hasSummaryPeriod', 'localDay', 'localMonth', 'numberValue', 'periodFor', 'targetPeriod', 'toDate', 'pad2'];
  const shared = path.join(__dirname, '..', '..', 'src', 'shared');

  for (const file of ['clientUsageArchive.js', 'sessionUsageArchive.js']) {
    const source = fs.readFileSync(path.join(shared, file), 'utf8');
    assert.match(source, /require\('\.\/archiveHelpers'\)/, `${file} must take the helpers from archiveHelpers.js`);
    const redeclared = owned.filter((name) => new RegExp(`function\\s+${name}\\s*\\(`).test(source));
    assert.deepEqual(redeclared, [], `${file} re-declares ${redeclared.join(', ')} instead of importing it`);
  }
});
