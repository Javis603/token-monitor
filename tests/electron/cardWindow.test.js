'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCardWindowVisibility, parkedCardBounds } = require('../../src/electron/cardWindow');

test('card visibility fades without hiding, cancels a closing fade on reopen and never focuses', () => {
  const timers = new Map();
  let id = 0, reduced = false, closed = 0;
  const win = { visible: false, opacity: 1, shows: 0, isDestroyed: () => false,
    isVisible() { return this.visible; }, getOpacity() { return this.opacity; },
    setOpacity(value) { this.opacity = value; }, showInactive() { this.visible = true; this.shows++; } };
  const visibility = createCardWindowVisibility({ reducedMotion: () => reduced,
    setTimer: callback => { timers.set(++id, callback); return id; }, clearTimer: key => timers.delete(key) });
  const tick = () => [...timers.values()].forEach(callback => callback());
  visibility.setVisible(win, true);
  assert.equal(win.opacity, 0, 'the first native show is transparent');
  tick();
  assert.ok(win.opacity > 0 && win.opacity < 1);
  visibility.setVisible(win, false, undefined, { afterFade: () => closed++ });
  tick();
  const interruptedOpacity = win.opacity;
  visibility.setVisible(win, true);
  assert.equal(win.opacity, interruptedOpacity, 'rapid reopen starts from the current opacity');
  for (let i = 0; i < 10; i++) tick();
  assert.equal(win.opacity, 1);
  assert.equal(win.shows, 1, 'reopening retains the existing native window');
  assert.equal(closed, 0, 'the superseded close cannot park the reopened card');
  reduced = true;
  visibility.setVisible(win, false);
  assert.equal(win.visible, true);
  assert.equal(win.opacity, 0);
  assert.equal(timers.size, 0);
  reduced = false;
  visibility.setVisible(win, true);
  visibility.cancel(win);
  assert.equal(timers.size, 0, 'disposing the owner cancels pending native fades');
});

test('legacy macOS card parking clears every display including a display with a negative origin', () => {
  const displays = [{ bounds: { x: -1600, width: 1600 } }, { bounds: { x: 0, width: 1920 } }];
  assert.deepEqual(parkedCardBounds({ x: -300, y: 90, width: 310, height: 420 }, displays),
    { x: 2230, y: 90, width: 310, height: 420 });
});
