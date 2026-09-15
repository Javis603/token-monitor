'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DWMWA_TRANSITIONS_FORCEDISABLED,
  SWP_NOACTIVATE,
  SWP_NOSIZE,
  SWP_NOZORDER,
  dipToPhysicalPoint,
  nudgeWindowsWindowByY,
  physicalYDelta,
  setWindowsDwmTransitionsEnabled
} = require('../../src/electron/windowsWindowMove');

test('dipToPhysicalPoint prefers dipToScreenRect so HiDPI origins stay correct', () => {
  const win = { id: 1 };
  const calls = [];
  const screenApi = {
    dipToScreenRect(window, rect) {
      calls.push({ window, rect });
      return { x: 200, y: -100, width: 2, height: 2 };
    },
    dipToScreenPoint() {
      throw new Error('rect conversion should win');
    }
  };
  assert.deepEqual(dipToPhysicalPoint(win, 80, -50, screenApi), { x: 200, y: -100 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].window, win);
  assert.deepEqual(calls[0].rect, { x: 80, y: -50, width: 1, height: 1 });
});

test('dipToPhysicalPoint falls back to dipToScreenPoint then DIP', () => {
  assert.deepEqual(
    dipToPhysicalPoint({}, 12.4, 8.6, {
      dipToScreenPoint: ({ x, y }) => ({ x: x * 2, y: y * 2 })
    }),
    { x: 25, y: 17 }
  );
  assert.deepEqual(dipToPhysicalPoint({}, 12.4, 8.6, {}), { x: 12, y: 9 });
});

test('physicalYDelta ignores converted x so a y-only slide cannot drift sideways', () => {
  const screenApi = {
    dipToScreenRect(_win, rect) {
      return { x: 40 + rect.y, y: rect.y * 2, width: rect.width, height: rect.height };
    }
  };
  const from = { x: 80, y: -200, width: 340, height: 650 };
  const to = { x: 80, y: 0, width: 340, height: 650 };
  assert.equal(physicalYDelta(from, to, {}, screenApi), 400);
  assert.equal(physicalYDelta(from, from, {}, screenApi), 0);
});

test('native window moves are Windows-only no-ops without a real hwnd', () => {
  assert.equal(SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE, 0x0015);
  assert.equal(DWMWA_TRANSITIONS_FORCEDISABLED, 3);
  const broken = {
    getNativeWindowHandle() {
      throw new Error('no hwnd');
    }
  };
  const from = { x: 0, y: 0, width: 10, height: 10 };
  const to = { x: 0, y: 8, width: 10, height: 10 };
  assert.equal(nudgeWindowsWindowByY(broken, from, to, {}), false);
  assert.equal(setWindowsDwmTransitionsEnabled(broken, false), false);
  if (process.platform !== 'win32') {
    const fake = { getNativeWindowHandle: () => Buffer.alloc(8) };
    assert.equal(nudgeWindowsWindowByY(fake, from, to, {}), false);
    assert.equal(setWindowsDwmTransitionsEnabled(fake, false), false);
  }
});
