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
  const pushes = main.match(/pushEdgeDockCells\(/g) || [];
  assert.ok(pushes.length >= 2, 'both the push and the settings path hand cells over through one function');
  assert.doesNotMatch(main, /controller\.setCells\(edgeDockCellsFor/);
  // The tick re-projects through the same projection the pushes use, so the renderer
  // keeps re-deriving from cells that were built the same way.
  assert.match(main, /if \(latestStats\) updateEdgeDockCells\(electronPresentationStats\(latestStats\)\);/);
});

