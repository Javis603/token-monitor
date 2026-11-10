'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCardFrameLoop } = require('../../src/electron/renderer/cardMotion');

test('a shared card frame loop keeps one pending callback through retargeting and cancels on disposal', () => {
  const callbacks = new Map(), sent = [];
  let id = 0;
  const loop = createCardFrameLoop({ sendFrame: motionId => sent.push(motionId),
    requestFrame: callback => { callbacks.set(++id, callback); return id; }, cancelFrame: key => callbacks.delete(key) });
  const paint = () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback()); };
  loop.update({ motionId: 1, active: true });
  loop.update({ motionId: 1, active: false });
  loop.update({ motionId: 2, active: true });
  assert.equal(callbacks.size, 1);
  paint();
  assert.deepEqual(sent, [2]);
  loop.update({ motionId: 1, active: false });
  paint();
  assert.deepEqual(sent, [2, 2], 'a stale completion cannot stop the current animation');
  loop.cancel();
  assert.equal(callbacks.size, 0);
  loop.update({ motionId: 3, active: true });
  paint();
  assert.deepEqual(sent, [2, 2, 3]);
  loop.update({ motionId: 3, active: false });
  paint();
  assert.equal(callbacks.size, 0);
});
