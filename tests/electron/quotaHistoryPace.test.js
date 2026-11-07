'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { combinedTrendBounds, windowPace } = require('../../src/electron/renderer/limits/historyModel');

const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const point = (time, value) => ({ at: time, value });

test('quota pace compares remaining against the even-use guide in the chart direction', () => {
  const now = at(3, 12);
  const reset = at(6, 12);
  const weeklyWindow = { kind: 'weekly', usedPercent: 68, remainingPercent: 32, resetsAt: new Date(reset).toISOString() };
  const sessionWindow = { kind: 'session', usedPercent: 10, remainingPercent: 90, windowMinutes: 300, resetsAt: new Date(at(3, 15)).toISOString() };
  const pace = windowPace(weeklyWindow, now, 'zai');
  assert.ok(pace);
  assert.equal(pace.delta, -11);
  assert.equal(windowPace(weeklyWindow, reset + 1, 'zai'), null);
  assert.equal(windowPace(weeklyWindow, reset - 7 * 86400_000 - 1, 'zai'), null);

  const entries = [
    { key: 'session', window: sessionWindow, unit: 'pp', points: [point(at(3, 11), 10)] },
    { key: 'weekly', window: weeklyWindow, unit: 'pp', points: [point(at(1, 12), 20), point(at(3, 11), 68)] }
  ];
  const cycleCombined = combinedTrendBounds(entries, now, 'zai', { rangeMode: 'cycle' });
  assert.equal(cycleCombined.cycle, true);
  assert.equal(cycleCombined.start, reset - 7 * 86400_000);
  assert.equal(cycleCombined.end, reset);
  assert.equal(cycleCombined.guideEntry, entries[1]);
});
