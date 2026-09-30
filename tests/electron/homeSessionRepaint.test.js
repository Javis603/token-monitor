'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const presentation = require('../../src/electron/renderer/edgeDock/presentation');
const sessionLive = require('../../src/shared/sessionLive');

test('Home sessions repaint at successive running expiries without a stats push', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const source = app.slice(app.indexOf('function stopHomeSessionRepaint()'), app.indexOf('function renderHomeSessionModule()'));
  assert.match(app, /if \(moduleIds\.includes\('session'\)\) scheduleHomeSessionRepaint\(\);/);
  assert.match(app, /allTimeSessions\.ensure\(\);\s*stopHomeSessionRepaint\(\);/);

  let now = 1_000_000;
  let nextTimerId = 0;
  const timers = new Map();
  const rows = [
    { lastUsedAt: new Date(now - sessionLive.RUNNING_WINDOW_MS + 2_000).toISOString() },
    { lastUsedAt: new Date(now - sessionLive.RUNNING_WINDOW_MS + 6_000).toISOString() }
  ];
  const counts = [2];
  const document = { activeElement: null };
  let current;
  function node(runningCount) {
    return {
      runningCount,
      replaceWith(next) { current = next; counts.push(next.runningCount); },
      focus() { document.activeElement = this; }
    };
  }
  current = node(2);
  current.focus();
  const state = { stats: {}, breakdown: 'home', homeSessionRepaintTimer: null };
  const { scheduleHomeSessionRepaint, stopHomeSessionRepaint } = Function(
    'state', 'window', 'Date', 'setTimeout', 'clearTimeout', 'visibleStatsSurface', 'els', 'document', 'renderHomeSessionModule',
    `${source}\nreturn { scheduleHomeSessionRepaint, stopHomeSessionRepaint };`
  )(
    state,
    { TokenMonitorEdgeDockPresentation: {
      recentSessionRows: () => rows,
      nextRunningExpiryAt: presentation.nextRunningExpiryAt
    } },
    { now: () => now },
    (callback, delay) => { const id = ++nextTimerId; timers.set(id, { callback, at: now + delay }); return id; },
    (id) => timers.delete(id),
    () => 'main',
    { homePanel: { querySelector: () => current } },
    document,
    () => node(rows.filter((row) => sessionLive.sessionActivityState(row, now) === 'running').length)
  );

  function fireNext() {
    const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    timers.delete(id);
    now = timer.at;
    timer.callback();
  }

  scheduleHomeSessionRepaint();
  assert.equal(timers.size, 1);
  assert.ok([...timers.values()][0].at < now + 3_000);
  fireNext();
  assert.deepEqual(counts, [2, 1]);
  assert.equal(document.activeElement, current);
  assert.ok([...timers.values()][0].at < now + 5_000);
  fireNext();
  assert.deepEqual(counts, [2, 1, 0]);
  assert.equal(timers.size, 1, 'relative ages keep updating after running has stopped');
  stopHomeSessionRepaint();
  assert.equal(timers.size, 0);
});
