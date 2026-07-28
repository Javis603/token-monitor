'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createVerticalDragSnapshot,
  resolveVerticalDrag,
  edgeScrollDelta
} = require('../../src/electron/renderer/verticalDragSort');

// 24px rows with the 6px gap `.limit-provider-list` uses.
const rows = [
  { id: 'claude', top: 0, height: 24 },
  { id: 'codex', top: 30, height: 24 },
  { id: 'cursor', top: 60, height: 24 },
  { id: 'zai', top: 90, height: 24 },
  { id: 'kimi', top: 120, height: 24 }
];

test('createVerticalDragSnapshot derives the slot height from the next row', () => {
  const snapshot = createVerticalDragSnapshot(rows, 'claude');
  assert.equal(snapshot.sourceIndex, 0);
  assert.equal(snapshot.slotHeight, 30);
});

test('createVerticalDragSnapshot derives the last row slot height from the previous row', () => {
  const snapshot = createVerticalDragSnapshot(rows, 'kimi');
  assert.equal(snapshot.sourceIndex, 4);
  assert.equal(snapshot.slotHeight, 30);
});

test('createVerticalDragSnapshot reports an unknown id as no source', () => {
  const snapshot = createVerticalDragSnapshot(rows, 'nope');
  assert.equal(snapshot.sourceIndex, -1);
  assert.equal(snapshot.slotHeight, 0);
});

// Collapsing an expanded row above the dragged one lifts every row below it
// between the press and the measurement. Anchoring to the press position would
// leave the row that far off the cursor for the whole drag.
test('createVerticalDragSnapshot anchors the origin to the measured row, not the press', () => {
  const grabOffset = 12;
  const pointerY = 60 + grabOffset;

  const atPress = createVerticalDragSnapshot(rows, 'cursor', grabOffset);
  assert.equal(atPress.originY, pointerY);
  assert.equal(pointerY - atPress.originY, 0, 'nothing moved, so no compensation');

  // An expanded row above collapses by 70px before the rows are measured.
  const lifted = rows.map((row, index) => (index === 0 ? row : { ...row, top: row.top - 70 }));
  const afterCollapse = createVerticalDragSnapshot(lifted, 'cursor', grabOffset);

  assert.equal(afterCollapse.originY, pointerY - 70);
  // The pointer has not moved, so the transform must absorb the whole lift and
  // put the row back under the cursor.
  assert.equal(pointerY - afterCollapse.originY, 70);
});

test('createVerticalDragSnapshot reports no origin for an unknown id', () => {
  assert.equal(createVerticalDragSnapshot(rows, 'nope', 12).originY, 0);
});

test('resolveVerticalDrag leaves everything alone at zero offset', () => {
  const snapshot = createVerticalDragSnapshot(rows, 'cursor');
  const resolved = resolveVerticalDrag(snapshot, 0);
  assert.equal(resolved.targetIndex, 2);
  assert.deepEqual(resolved.shifts, [0, 0, 0, 0, 0]);
  assert.deepEqual(resolved.order, ['claude', 'codex', 'cursor', 'zai', 'kimi']);
});

test('resolveVerticalDrag shifts the rows a downward drag passes', () => {
  const snapshot = createVerticalDragSnapshot(rows, 'claude');
  const resolved = resolveVerticalDrag(snapshot, 65);
  assert.equal(resolved.targetIndex, 2);
  assert.deepEqual(resolved.shifts, [0, -30, -30, 0, 0]);
  assert.deepEqual(resolved.order, ['codex', 'cursor', 'claude', 'zai', 'kimi']);
});

test('resolveVerticalDrag shifts the rows an upward drag passes', () => {
  const snapshot = createVerticalDragSnapshot(rows, 'kimi');
  const resolved = resolveVerticalDrag(snapshot, -95);
  assert.equal(resolved.targetIndex, 1);
  assert.deepEqual(resolved.shifts, [0, 30, 30, 30, 0]);
  assert.deepEqual(resolved.order, ['claude', 'kimi', 'codex', 'cursor', 'zai']);
});

test('resolveVerticalDrag clamps the target index to the list', () => {
  const snapshot = createVerticalDragSnapshot(rows, 'claude');
  assert.equal(resolveVerticalDrag(snapshot, 10000).targetIndex, 4);
  assert.equal(resolveVerticalDrag(snapshot, -10000).targetIndex, 0);
});

test('resolveVerticalDrag returns an empty result for an unknown id', () => {
  const snapshot = createVerticalDragSnapshot(rows, 'nope');
  const resolved = resolveVerticalDrag(snapshot, 40);
  assert.equal(resolved.targetIndex, -1);
  assert.deepEqual(resolved.shifts, []);
  assert.deepEqual(resolved.order, []);
});

// Wrapped provider tags make a row taller. The shift is the space the *dragged*
// row frees, so it stays one slot regardless of the passed row's own height.
test('resolveVerticalDrag shifts by one slot even when rows have uneven heights', () => {
  const uneven = [
    { id: 'claude', top: 0, height: 24 },
    { id: 'codex', top: 30, height: 60 },
    { id: 'cursor', top: 96, height: 24 }
  ];
  const snapshot = createVerticalDragSnapshot(uneven, 'claude');
  assert.equal(snapshot.slotHeight, 30);
  const resolved = resolveVerticalDrag(snapshot, 70);
  assert.equal(resolved.targetIndex, 1);
  assert.deepEqual(resolved.shifts, [0, -30, 0]);
  assert.deepEqual(resolved.order, ['codex', 'claude', 'cursor']);
});

test('edgeScrollDelta stays still in the middle of the panel', () => {
  assert.equal(edgeScrollDelta({ pointerY: 350, top: 100, bottom: 600 }), 0);
});

test('edgeScrollDelta accelerates towards the edge it is nearest', () => {
  assert.equal(edgeScrollDelta({ pointerY: 120, top: 100, bottom: 600 }), -4.5);
  assert.equal(edgeScrollDelta({ pointerY: 590, top: 100, bottom: 600 }), 8.25);
});

test('edgeScrollDelta clamps to maxSpeed past the panel edges', () => {
  assert.equal(edgeScrollDelta({ pointerY: 50, top: 100, bottom: 600 }), -12);
  assert.equal(edgeScrollDelta({ pointerY: 700, top: 100, bottom: 600 }), 12);
});
