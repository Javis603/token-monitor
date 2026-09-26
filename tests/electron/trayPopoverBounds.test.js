'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  pointInside,
  pointerPoint,
  popoverAnchor,
  popoverBounds
} = require('../../src/electron/tray');

// The arrangement this was reported with: a Retina laptop panel at the origin and
// a 1080p display placed above and to its left, so the second display's origin is
// negative on both axes. The coordinates are Chromium's, i.e. the same space
// CGDisplayBounds reports and Electron's screen module works in.
const MAIN = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1470, height: 956 },
  workArea: { x: 0, y: 25, width: 1470, height: 906 }
};
const EXTERNAL = {
  id: 2,
  bounds: { x: -220, y: -1080, width: 1920, height: 1080 },
  workArea: { x: -220, y: -1055, width: 1920, height: 1030 }
};

function screenFor(cursor, displays = [MAIN, EXTERNAL]) {
  return {
    getCursorScreenPoint: () => cursor,
    getDisplayNearestPoint: (point) =>
      displays.find((display) => pointInside(point, display.bounds)) || displays[0]
  };
}

// The menu bar copies of a status item share one backing window on macOS, so a
// click on the external display still reports the primary display's icon
// rectangle. That is the input this fix has to survive.
const mirroredTray = { getBounds: () => ({ x: 900, y: 0, width: 24, height: 24 }) };

test('pointInside treats bounds as half-open along both axes', () => {
  const area = { x: -220, y: -1080, width: 1920, height: 1080 };
  assert.equal(pointInside({ x: -220, y: -1080 }, area), true);
  assert.equal(pointInside({ x: 1699, y: -1 }, area), true);
  assert.equal(pointInside({ x: 1700, y: -1 }, area), false);
  assert.equal(pointInside({ x: -221, y: -1079 }, area), false);
  assert.equal(pointInside(null, area), false);
});

test('popover opens on the display under the pointer, not on the tray rectangle', () => {
  const clickPoint = pointerPoint(
    { x: 12, y: 900 },
    { screen: screenFor({ x: 1200, y: -1060 }) },
    'darwin'
  );
  const bounds = popoverBounds(mirroredTray, 340, 650, {
    screen: screenFor(clickPoint),
    clickPoint,
    platform: 'darwin'
  });

  // Landing "above the primary display" is the assertion that matters: y < 0 is
  // only reachable on the external display.
  assert.equal(bounds.y, -1051);
  assert.ok(bounds.y < 0, 'popover is not on the primary display');
  assert.ok(bounds.y >= EXTERNAL.workArea.y + 4, 'and clears that menu bar');
  assert.equal(bounds.x, 1030);
  assert.ok(bounds.x >= EXTERNAL.workArea.x + 4);
  assert.ok(bounds.x + bounds.width <= EXTERNAL.workArea.x + EXTERNAL.workArea.width - 4);
});

test('the tray rectangle still centres the popover when it is on the clicked display', () => {
  const clickPoint = { x: 912, y: 10 };
  const bounds = popoverBounds(mirroredTray, 340, 650, {
    screen: screenFor(clickPoint),
    clickPoint,
    platform: 'darwin'
  });

  // Centred on the 24px icon (900 + 12) rather than on the cursor, and hung from
  // the icon's lower edge (24), clamped below the menu bar (25 + 4).
  assert.equal(bounds.x, 912 - 170);
  assert.equal(bounds.y, 29);
});

test('a single display keeps the geometry it had before the fix', () => {
  const clickPoint = { x: 912, y: 10 };
  const bounds = popoverBounds(mirroredTray, 340, 650, {
    screen: screenFor(clickPoint, [MAIN]),
    clickPoint,
    platform: 'darwin'
  });
  assert.deepEqual(bounds, { x: 742, y: 29, width: 340, height: 650 });
});

test('without a click the popover keeps its display from the tray rectangle', () => {
  // Keyboard shortcut / VoiceOver path: the cursor sits on the external display
  // but the tray rectangle is on the primary one, so the popover stays on the
  // primary display exactly as it did before this fix.
  const bounds = popoverBounds(mirroredTray, 340, 650, {
    screen: screenFor({ x: 500, y: -1060 }),
    clickPoint: null,
    platform: 'darwin'
  });
  assert.deepEqual(bounds, { x: 742, y: 29, width: 340, height: 650 });
});

test('a zero-width tray rectangle falls back to the pointer for horizontal placement', () => {
  const clickPoint = { x: 500, y: 10 };
  const flatTray = { getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }) };
  const bounds = popoverBounds(flatTray, 340, 650, {
    screen: screenFor(clickPoint),
    clickPoint,
    platform: 'darwin'
  });
  assert.deepEqual(bounds, { x: 330, y: 29, width: 340, height: 650 });
});

test('windows and linux keep opening above the tray icon', () => {
  const clickPoint = { x: 912, y: 10 };
  const bounds = popoverBounds(mirroredTray, 340, 650, {
    screen: screenFor(clickPoint),
    clickPoint,
    platform: 'win32'
  });
  // 24 - 650 - 8 is off the top, so the fallback hangs it below the icon instead.
  assert.equal(bounds.x, 742);
  assert.equal(bounds.y, 32);
});

test('popoverAnchor reports whether it could use the tray rectangle', () => {
  const onMain = popoverAnchor({
    trayBounds: { x: 900, y: 0, width: 24, height: 24 },
    cursor: { x: 912, y: 10 },
    display: MAIN
  });
  assert.deepEqual(onMain, { x: 912, top: 24, onTray: true });

  const offDisplay = popoverAnchor({
    trayBounds: { x: 900, y: 0, width: 24, height: 24 },
    cursor: { x: 1200, y: -1060 },
    display: EXTERNAL
  });
  assert.deepEqual(offDisplay, { x: 1200, top: -1060, onTray: false });
});

test('pointerPoint uses the screen cursor on macOS, where the event position is window-relative', () => {
  const withScreen = { screen: { getCursorScreenPoint: () => ({ x: 5, y: 6 }) } };
  assert.deepEqual(pointerPoint({ x: 1, y: 2 }, withScreen, 'darwin'), { x: 5, y: 6 });
  assert.deepEqual(pointerPoint(null, withScreen, 'darwin'), { x: 5, y: 6 });

  const noScreen = { screen: {} };
  assert.equal(pointerPoint({ x: 1, y: 2 }, noScreen, 'darwin'), null);
  assert.deepEqual(pointerPoint({ x: 1, y: 2 }, noScreen, 'win32'), { x: 1, y: 2 });

  assert.equal(pointerPoint(null, noScreen, 'darwin'), null);
  assert.equal(pointerPoint({ x: Number.NaN, y: 2 }, noScreen, 'win32'), null);

  const throwing = {
    screen: {
      getCursorScreenPoint: () => { throw new Error('no display server'); }
    }
  };
  assert.equal(pointerPoint({ x: 1, y: 2 }, throwing, 'darwin'), null);
});
