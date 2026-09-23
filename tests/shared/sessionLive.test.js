'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sessionLive = require('../../src/shared/sessionLive');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

test('the running window is a display window measured from the last transcript write', () => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  const at = (msAgo) => new Date(now - msAgo).toISOString();
  assert.equal(sessionLive.isRunningSession({ lastUsedAt: at(0) }, now), true);
  assert.equal(sessionLive.isRunningSession({ lastUsedAt: at(sessionLive.RUNNING_WINDOW_MS) }, now), true);
  assert.equal(sessionLive.isRunningSession({ lastUsedAt: at(sessionLive.RUNNING_WINDOW_MS + 1) }, now), false);
  // A transcript stamped ahead of this clock was just written, not written in
  // the future.
  assert.equal(sessionLive.isRunningSession({ lastUsedAt: at(-60_000) }, now), true);
  assert.equal(sessionLive.isRunningSession({ lastUsedAt: '' }, now), false);
  assert.equal(sessionLive.isRunningSession({}, now), false);
  // A Date is an accepted clock, which is what the Sessions list passes.
  assert.equal(sessionLive.isRunningSession({ lastUsedAt: at(1000) }, new Date(now)), true);
});

test('an archived session is never running, whatever its timestamp says', () => {
  const now = Date.now();
  const fresh = new Date(now - 1000).toISOString();
  assert.equal(sessionLive.isRunningSession({ lastUsedAt: fresh, archived: true }, now), false);
  assert.equal(sessionLive.isRunningSession({ lastUsedAt: fresh, deleted: true }, now), false);
  assert.equal(sessionLive.isRunningSession({ lastUsedAt: fresh, sourceDeleted: true }, now), false);
  assert.equal(sessionLive.isRunningSession({ lastUsedAt: fresh }, now), true);
});

test('a context reading needs both halves, and both are published', () => {
  assert.deepEqual(
    sessionLive.sessionContextWindow({ contextTokens: 190_000, contextWindow: 200_000 }),
    { contextTokens: 190_000, contextWindow: 200_000, percentLeft: 5, percentUsed: 95 }
  );
  // Both halves are required: a window with no occupancy cannot be drawn, and an
  // occupancy with no window is a bare token count the row already shows.
  assert.equal(sessionLive.sessionContextWindow({ contextTokens: 100 }), null);
  assert.equal(sessionLive.sessionContextWindow({ contextWindow: 200 }), null);
  assert.equal(sessionLive.sessionContextWindow({ contextTokens: 0, contextWindow: 200 }), null);
  assert.equal(sessionLive.sessionContextWindow({}), null);
  // A transcript reporting more than its window fits means the two disagree;
  // report no headroom rather than a negative one.
  assert.equal(sessionLive.sessionContextWindow({ contextTokens: 300, contextWindow: 200 }).percentLeft, 0);
});

test('context tone only colours headroom that is running out', () => {
  assert.equal(sessionLive.contextTone(80), '');
  assert.equal(sessionLive.contextTone(31), '');
  // The boundaries themselves belong to the more serious tone.
  assert.equal(sessionLive.contextTone(30), 'caution');
  assert.equal(sessionLive.contextTone(11), 'caution');
  assert.equal(sessionLive.contextTone(10), 'low');
  assert.equal(sessionLive.contextTone(0), 'low');
  assert.equal(sessionLive.sessionContextRow({ contextTokens: 190_000, contextWindow: 200_000 }).tone, 'low');
  assert.equal(sessionLive.sessionContextRow({ contextTokens: 100 }), undefined);
});

test('both renderers read the shared predicate rather than keeping their own copy', () => {

  const rows = readRendererFile('sessionRows.js');
  const presentation = readRendererFile(path.join('edgeDock', 'presentation.js'));
  const dock = readRendererFile(path.join('edgeDock', 'dock.js'));
  // The Sessions list takes the predicate instead of reimplementing it...
  assert.match(rows, /TokenMonitorSessionLive/);
  // ...deriving the running boolean from the three-state value rather than
  // computing the same fact a second way.
  assert.match(rows, /sessionActivityState\(session, now\)/);
  assert.match(rows, /const running = activityState === 'running'/);
  // It must not call the boolean predicate at all - the comment above names it,
  // so match a call rather than the bare word.
  assert.doesNotMatch(rows, /isRunningSession\(/);
  assert.doesNotMatch(rows, /RUNNING_SESSION_WINDOW_MS = 10 \* 60 \* 1000/);
  // ...and the dock's cell projection does the same, because the count it
  // reports and the rows it renders have to come from one derivation.
  assert.match(presentation, /TokenMonitorSessionLive/);
  assert.match(presentation, /sessionLive\.sessionActivityState/);
  // The dock recomputes running at paint time from the same predicate, because
  // it repaints from its last payload on a timer and a session that stopped in
  // between must stop reading as running.
  assert.match(dock, /sessionLive\.sessionActivityState/);
  assert.match(dock, /edgeDock\.runningCount/);
  // Both surfaces must load the shared module before the file that uses it.
  for (const [htmlPath, moduleRef, consumerRef] of [
    ['index.html', 'shared/sessionLive.js', 'sessionRows.js'],
    [path.join('edgeDock', 'index.html'), 'shared/sessionLive.js', 'presentation.js']
  ]) {
    const html = readRendererFile(htmlPath);
    assert.ok(html.includes(moduleRef), htmlPath);
    assert.ok(html.indexOf(moduleRef) < html.indexOf(consumerRef), htmlPath);
  }
});


test('a finished turn stops reading as running before the window expires', () => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  const fresh = new Date(now - 30_000).toISOString();
  const old = new Date(now - sessionLive.RUNNING_WINDOW_MS - 1).toISOString();
  // Generating: recent and no turn-end reported.
  assert.equal(sessionLive.sessionActivityState({ lastUsedAt: fresh }, now), 'running');
  // The transcript said the turn finished, and it just did: over now, not in
  // ten minutes. This is the whole point of reading the boundary.
  assert.equal(sessionLive.sessionActivityState({ lastUsedAt: fresh, turnEnded: true }, now), 'ended');
  // Quiet long enough that nothing claims it is live, whether or not a boundary
  // was ever reported.
  assert.equal(sessionLive.sessionActivityState({ lastUsedAt: old }, now), 'idle');
  assert.equal(sessionLive.sessionActivityState({ lastUsedAt: old, turnEnded: true }, now), 'idle');
  // An archived session has no state at all.
  assert.equal(sessionLive.sessionActivityState({ lastUsedAt: fresh, archived: true }, now), 'idle');
  assert.equal(sessionLive.sessionActivityState({}, now), 'idle');
  // The boolean view stays consistent with the three-way one.
  for (const session of [
    { lastUsedAt: fresh },
    { lastUsedAt: fresh, turnEnded: true },
    { lastUsedAt: old },
    {}
  ]) {
    assert.equal(
      sessionLive.isRunningSession(session, now),
      sessionLive.sessionActivityState(session, now) === 'running',
      JSON.stringify(session)
    );
  }
});


test('a turn-end outlives ticks that carry no evidence, and a new turn clears it', () => {
  const usage = require('../../src/shared/usage');
  const period = (sessions) => usage.normalizePeriod(Object.assign(usage.emptyPeriod(), { sessions }));
  const base = { client: 'codex', sessionId: 's', totalTokens: 100, lastUsedAt: '2026-09-18T10:00:00.000Z' };
  const ended = { ...base, turnEnded: true };
  const merged = (a, b) => usage.mergePeriods(period({ 'codex:s': a }), period({ 'codex:s': b })).sessions['codex:s'];
  // A tick that says nothing about the boundary must not un-say it.
  assert.equal(merged(ended, base).turnEnded, true);
  // A newer reading that says nothing about the boundary is a client that does
  // not report one; it still must not clear the client that did.
  assert.equal(merged(ended, { ...base, lastUsedAt: '2026-09-18T10:05:00.000Z' }).turnEnded, true);
  // A stale copy cannot resurrect a cleared flag either.
  // The same reading in either order has to give the same answer, since both
  // describe the same bytes.
  assert.equal(merged(base, ended).turnEnded, true);
  // What must NOT happen is a genuinely older reading overwriting a newer one.
  const inProgress = { ...base, lastUsedAt: '2026-09-18T10:05:00.000Z', turnEnded: false };
  assert.equal(merged(inProgress, ended).turnEnded, false);
  // And a client that explicitly reports a fresh turn clears it.
  assert.equal(merged(ended, { ...base, lastUsedAt: '2026-09-18T10:05:00.000Z', turnEnded: false }).turnEnded, false);
});
