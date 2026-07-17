'use strict';

// Pin the zone before anything reads the clock: these cases are about the
// local-vs-UTC day boundary, so they must not inherit the CI machine's zone.
// node --test runs every test file in its own process, so this cannot leak.
process.env.TZ = 'Asia/Shanghai'; // UTC+8, no DST

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const charts = require('../../src/electron/renderer/usageCharts');

// 02:00 local on 2026-07-17 at UTC+8 is still 2026-07-16 in UTC — the exact window
// (00:00–07:59 local) that made the activity heatmap paint the live "today" total
// onto yesterday's cell, blanking a day that had real usage (#177).
const EARLY_MORNING_UTC8 = new Date('2026-07-16T18:00:00Z');

test('localDayKey returns the local day inside the UTC+8 early-morning window (#177)', () => {
  assert.equal(charts.localDayKey(EARLY_MORNING_UTC8), '2026-07-17');
  // The regression this replaces: a UTC-derived key names the previous day, so the
  // local today's period total was patched onto yesterday's cell.
  assert.equal(EARLY_MORNING_UTC8.toISOString().slice(0, 10), '2026-07-16');
});

test('localDayKey rolls the year/month with the local day, not the UTC one (#177)', () => {
  // 02:00 local on 2027-01-01 at UTC+8 is still 2026-12-31 in UTC, so every component
  // differs at once — this is what pins all three getters to their local variants.
  const newYear = new Date('2026-12-31T18:00:00Z');
  assert.equal(charts.localDayKey(newYear), '2027-01-01');
  assert.equal(newYear.toISOString().slice(0, 10), '2026-12-31');
});

test('localDayKey agrees with UTC once the local and UTC day line up again', () => {
  // 12:00 local = 04:00Z the same day; outside the window both agree.
  const midday = new Date('2026-07-17T04:00:00Z');
  assert.equal(charts.localDayKey(midday), '2026-07-17');
  assert.equal(charts.localDayKey(midday), midday.toISOString().slice(0, 10));
});

test('localDayKey zero-pads and never depends on locale formatting', () => {
  // 09:00 local on 2026-01-05 → single-digit month and day.
  assert.equal(charts.localDayKey(new Date('2026-01-05T01:00:00Z')), '2026-01-05');
  assert.match(charts.localDayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

test('the rolling-year heatmap ends on the local day by default', () => {
  const heat = charts.rollingYearHeatmap([], {});
  assert.equal(heat.cells[heat.cells.length - 1].date, charts.localDayKey());
});

test('activity views derive today from the local day key, not toISOString (#177)', () => {
  const rendererDir = path.join(__dirname, '../../src/electron/renderer');
  for (const file of ['app.js', 'dashboard.js', 'usageCharts.js']) {
    const source = fs.readFileSync(path.join(rendererDir, file), 'utf8');
    // Key arithmetic on an already-correct key stays UTC-anchored (addDaysUTC,
    // month-start math); what must never come back is reading the wall clock in UTC.
    assert.ok(
      !/new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/.test(source),
      `${file} must derive today from localDayKey(), not new Date().toISOString()`
    );
  }
});
