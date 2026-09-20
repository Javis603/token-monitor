'use strict';

// Wiring guard: the clock-crossing fix has a renderer half and a main-process half.
// This checks the main-process half the way a source-reading test can - that the
// expiry scheduler exists, is armed from the cells actually handed over, and is
// reached by both of the paths that replace what is on screen.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
const dock = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'edgeDock', 'dock.js'), 'utf8');

// The dock's rate tracker and the timer that wakes on its expiry have to share one
// clock. The tracker defaults to `performance.now()` (monotonic, near zero), while the
// timer subtracts `Date.now()` (epoch); mixed, the difference is a large negative
// number that clamps to the 20ms floor and re-projects the dock about fifty times a
// second for as long as a sample is retained. Reproduced directly against the real
// module before the fix: a default tracker reported `nextExpiryAt` 8015 and the delay
// computed as 20ms, an epoch one reported 1789898282825 and 8020ms.
test('the dock rate tracker is read on the same clock its timer is scheduled with', () => {
  const tracker = main.slice(main.indexOf('function edgeDockLiveRateSample('), main.indexOf('// Week / last-7 / last-30 are not collector periods'));
  assert.match(tracker, /createLiveTokenRateGroupTracker\(\{/);
  assert.match(tracker, /now: Date\.now,/);
  assert.match(tracker, /Math\.max\(0, expiresAt - Date\.now\(\)\)/);
  // Every other group tracker in the tree takes an explicit epoch clock for the same
  // reason - each of them is scheduled against `Date.now()` by the code that reads
  // its expiry. Read from those call sites rather than from dock.js, which builds no
  // group tracker of its own: a slice of that file matched nothing and asserted
  // nothing, so it could not have caught the clock drifting back.
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
  const callSites = app.match(/createLiveTokenRateGroupTracker\(\{[^}]*\}/g) || [];
  assert.ok(callSites.length >= 2, 'the renderer builds its group trackers through the shared factory');
  for (const site of callSites) assert.match(site, /now: \(\) => Date\.now\(\)/);
  // And the shared default stays monotonic, which is what makes the explicit clock a
  // real choice at each call site rather than a no-op.
  const shared = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'tokenRatePresentation.js'), 'utf8');
  assert.match(shared, /function defaultNow\(\) \{/);
  assert.match(shared, /performance\.now\(\)/);
});

test('a stale session expiry never shortens either self-repair wait to its floor', () => {
  // Both schedulers used to pick an already-passed expiry as the soonest one, which
  // pinned the delay to the floor and re-armed on the same payload after every pass.
  const mainScheduler = main.slice(main.indexOf('function edgeDockNextSessionExpiry('), main.indexOf('function scheduleEdgeDockSessionExpiry('));
  assert.match(mainScheduler, /const now = Date\.now\(\);/);
  assert.match(mainScheduler, /if \(expiresAt > now &&/);
  // The renderer's sessions-expiry read, which is what both surfaces' waits are built
  // from now that the card's period and the rail's expiry are separate concerns.
  const rendererScheduler = dock.slice(dock.indexOf('function sessionsExpiryDelayMs('), dock.indexOf('function repaintSelf('));
  assert.match(rendererScheduler, /const now = Date\.now\(\);/);
  assert.match(rendererScheduler, /if \(expiresAt > now &&/);
  // The floor is a lower bound on a real wait, not a period to poll at.
  assert.match(rendererScheduler, /Math\.max\(SELF_REPAINT_FLOOR_MS, soonest - Date\.now\(\) \+ 50\)/);
});

test('the edge dock arms a re-projection for the moment its running reading expires', () => {
  // The scheduler reads the expiry the cell carries, not a frozen count: the cell no
  // longer has one, so a guard keyed on a count would never fire.
  assert.match(main, /function edgeDockNextSessionExpiry\(cells\) \{/);
  assert.match(main, /cell\.runningExpiresAt/);
  assert.match(main, /function scheduleEdgeDockSessionExpiry\(\) \{/);
  assert.match(main, /if \(!expiresAt\) return;/);
  assert.match(main, /EDGE_DOCK_EXPIRY_FLOOR_MS/);
  // Armed from the cells that were actually handed over, so the timer and what is on
  // screen cannot describe different payloads.
  assert.match(main, /function pushEdgeDockCells\(cells\) \{/);
  assert.match(main, /edgeDockLastCells = cells;/);
  assert.match(main, /const expiresAt = edgeDockNextSessionExpiry\(edgeDockLastCells\);/);
  // Both replacement paths go through it: a stats push, and a settings sync, which
  // had its own direct setCells call and would otherwise leave the rail unscheduled.
  // Asserted per path rather than by counting matches: the declaration itself contains
  // the call shape, so a count would still pass with only one of the two call sites -
  // which is the regression this guard exists for.
  const statsPath = main.slice(main.indexOf('function updateEdgeDockCells('), main.indexOf('function pushEdgeDockCells('));
  assert.match(statsPath, /pushEdgeDockCells\(cells\);/);
  const syncPath = main.slice(main.indexOf('function syncEdgeDock('));
  assert.match(syncPath, /if \(latestStats\) pushEdgeDockCells\(edgeDockCellsFor\(electronPresentationStats\(latestStats\)\)\);/);
  assert.doesNotMatch(main, /controller\.setCells\(edgeDockCellsFor/);
  // The tick re-projects through the same projection the pushes use, so the renderer
  // keeps re-deriving from cells that were built the same way.
  assert.match(main, /if \(latestStats\) updateEdgeDockCells\(electronPresentationStats\(latestStats\)\);/);
});
