'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EDGE_DOCK_METRICS,
  edgeDockBubbleBounds,
  edgeDockCellAt,
  edgeDockHorizontalPad,
  edgeDockHorizontalShoulder,
  edgeDockPeekBounds,
  edgeDockPlacementForDrop,
  edgeDockRailBounds,
  edgeDockTriggerBounds
} = require('../../src/electron/edgeDock/geometry');
const { bubbleCommands, railCommands, toPolygons } = require('../../src/electron/renderer/edgeDock/shapes');

const workArea = { x: 0, y: 0, width: 1280, height: 693 };
const kinds = (count) => Array.from({ length: count }, (_, index) => (index < 2 ? 'stat' : 'provider'));

function boundsBox(commands) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const command of commands) {
    for (let index = 1; index < command.length; index += 2) {
      left = Math.min(left, command[index]);
      right = Math.max(right, command[index]);
      top = Math.min(top, command[index + 1]);
      bottom = Math.max(bottom, command[index + 1]);
    }
  }
  return { left, top, right, bottom };
}

test('a top or bottom bar hugs its edge and keeps every cell inside', () => {
  for (const side of ['top', 'bottom']) {
    const rail = edgeDockRailBounds({ workArea, side, offset: 0.5, cellKinds: kinds(6) });
    // A glued bar is flush with the screen edge, the way a side rail is flush
    // with the left or right edge; the shoulder is what curves it inwards.
    if (side === 'top') assert.equal(rail.y, workArea.y);
    else assert.equal(rail.y + rail.height, workArea.y + workArea.height);
    assert.equal(rail.height, EDGE_DOCK_METRICS.topThickness);
    assert.ok(rail.x >= workArea.x && rail.x + rail.width <= workArea.x + workArea.width);
    const { lefts, widths } = rail.cells;
    assert.equal(lefts.length, 6);
    for (let index = 0; index < lefts.length; index += 1) {
      assert.ok(lefts[index] >= 0 && lefts[index] + widths[index] <= rail.width + 0.5);
      if (index > 0) assert.ok(lefts[index] >= lefts[index - 1] + widths[index - 1] - 0.5);
    }
  }
});

test('a floating bar is narrower than a glued one and still holds its cells', () => {
  const glued = edgeDockRailBounds({ workArea, side: 'bottom', offset: 0.5, cellKinds: kinds(6) });
  const floating = edgeDockRailBounds({ workArea, side: 'bottom', offset: 0.5, floatingY: 0.4, cellKinds: kinds(6) });
  assert.equal(edgeDockHorizontalPad(null), edgeDockHorizontalShoulder(EDGE_DOCK_METRICS));
  assert.equal(edgeDockHorizontalPad(0.4), EDGE_DOCK_METRICS.shoulder);
  assert.equal(glued.width - floating.width, 2 * (edgeDockHorizontalShoulder(EDGE_DOCK_METRICS) - EDGE_DOCK_METRICS.shoulder));
  const last = floating.cells.lefts[5] + floating.cells.widths[5];
  assert.ok(last <= floating.width + 0.5);
});

test('bar cells answer hit tests across the row and nowhere else', () => {
  const rail = edgeDockRailBounds({ workArea, side: 'top', offset: 0.5, cellKinds: kinds(6) });
  for (let index = 0; index < 6; index += 1) {
    const point = {
      x: rail.x + rail.cells.lefts[index] + rail.cells.widths[index] / 2,
      y: rail.y + rail.height / 2
    };
    assert.equal(edgeDockCellAt(point, rail, 6), index);
  }
  assert.equal(edgeDockCellAt({ x: rail.x + rail.width + 40, y: rail.y + rail.height / 2 }, rail, 6), null);
  // A bar only answers inside its own row: the column below it stays the page's.
  assert.equal(edgeDockCellAt({ x: rail.x + rail.width / 2, y: rail.y + rail.height + 80 }, rail, 6), null);
});

test('a called-up card hangs off the bar with its tail pointing back', () => {
  for (const side of ['top', 'bottom']) {
    const rail = edgeDockRailBounds({ workArea, side, offset: 0.5, cellKinds: kinds(6) });
    const card = edgeDockBubbleBounds({ railBounds: rail, cellIndex: 3, height: 300, workArea, side });
    assert.equal(card.height, 300 + EDGE_DOCK_METRICS.bubbleTail);
    if (side === 'top') assert.equal(card.y, rail.y + rail.height + EDGE_DOCK_METRICS.bubbleGap);
    else assert.equal(card.y + card.height, rail.y - EDGE_DOCK_METRICS.bubbleGap);
    assert.ok(card.x >= 0 && card.x + card.width <= workArea.width);
    // The tail is drawn from the same page-side anchor the card uses.
    const centre = rail.x + rail.cells.lefts[3] + rail.cells.widths[3] / 2;
    assert.ok(Math.abs(card.x + card.tailX - centre) <= rail.cells.widths[3] / 2);
  }
});

test('the bar shape fills its window and the card shape stops at the tail', () => {
  for (const side of ['top', 'bottom']) {
    const rail = edgeDockRailBounds({ workArea, side, offset: 0.5, cellKinds: kinds(6) });
    for (const progress of [0, 0.5, 1]) {
      const commands = railCommands({
        width: rail.width, height: rail.height, side, shoulder: EDGE_DOCK_METRICS.shoulder,
        radius: EDGE_DOCK_METRICS.railRadius, floatingProgress: progress
      });
      const box = boundsBox(commands);
      assert.ok(box.left >= -0.5 && box.top >= -0.5);
      assert.ok(box.right <= rail.width + 0.5 && box.bottom <= rail.height + 0.5);
      assert.ok(toPolygons(commands).length >= 1);
    }
    const card = edgeDockBubbleBounds({ railBounds: rail, cellIndex: 3, height: 300, workArea, side });
    const shape = boundsBox(bubbleCommands({
      width: card.width, height: card.height, side, tail: EDGE_DOCK_METRICS.bubbleTail,
      tailX: card.tailX, neck: EDGE_DOCK_METRICS.bubbleNeck, radius: EDGE_DOCK_METRICS.bubbleRadius
    }));
    // The window already carries the tail; drawing the card plus the tail again
    // would clip twelve pixels off the far edge.
    assert.ok(shape.bottom <= card.height + 0.5, 'card shape stays inside its window');
    assert.ok(shape.right <= card.width + 0.5);
  }
});

test('dropping a glued bar keeps it glued while it slides along the edge', () => {
  const slide = (pointer, final) => edgeDockPlacementForDrop({
    workArea, pointer, metrics: EDGE_DOCK_METRICS, grabOffsetX: 200, grabOffsetY: 40,
    cellKinds: kinds(6), currentSide: 'top', final
  });
  // Mid-drag the bar follows the pointer: it only snaps once released.
  assert.equal(slide({ x: 700, y: 8 }, false).floatingY, null);
  assert.notEqual(slide({ x: 700, y: 60 }, false).floatingY, null);
  // Released close to the edge it snaps back onto it.
  assert.equal(slide({ x: 700, y: 60 }, true).floatingY, null);
  assert.equal(slide({ x: 700, y: 60 }, true).side, 'top');
  // Released halfway down the screen it stays where it was let go.
  const parked = slide({ x: 700, y: 320 }, true);
  assert.equal(parked.side, 'top');
  assert.ok(parked.floatingY > 0 && parked.floatingY < 1);
  // Reaching the other edge swaps ends.
  assert.equal(slide({ x: 700, y: 690 }, true).side, 'bottom');
});

test('a dragged side rail turns into a bar when it reaches the top or bottom edge', () => {
  const drop = (pointer) => edgeDockPlacementForDrop({
    workArea, pointer, metrics: EDGE_DOCK_METRICS, grabOffsetX: 30, grabOffsetY: 30,
    cellKinds: kinds(6), currentSide: 'right', final: true
  });
  assert.equal(drop({ x: 640, y: 6 }).side, 'top');
  assert.equal(drop({ x: 640, y: 686 }).side, 'bottom');
  // Reaching a side edge keeps it a rail.
  assert.equal(drop({ x: 8, y: 300 }).side, 'left');
  // Neither peek handle nor wake corridor exist for a bar: it is always on screen.
  for (const side of ['top', 'bottom']) {
    const rail = edgeDockRailBounds({ workArea, side, offset: 0.5, cellKinds: kinds(6) });
    assert.equal(edgeDockPeekBounds({ workArea, side, railBounds: rail }), null);
    assert.equal(edgeDockTriggerBounds({ workArea, side, railBounds: rail, displayBounds: workArea }), null);
  }
});

test('every cell count keeps the bar on screen', () => {
  for (const count of [1, 2, 3, 6, 8, 12, 14]) {
    const rail = edgeDockRailBounds({ workArea, side: 'bottom', offset: 0.5, cellKinds: kinds(count) });
    assert.ok(rail.width <= workArea.width);
    const last = rail.cells.lefts[count - 1] + rail.cells.widths[count - 1];
    assert.ok(last <= rail.width + 0.5, count + ' cells overflow the bar');
  }
});
