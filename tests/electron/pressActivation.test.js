'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { activateOnPress } = require('../../src/electron/renderer/pressActivation');

function fakeNode() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    // Returns whether any listener cancelled the default, mirroring the browser's
    // cancelable-event contract the helper relies on.
    dispatch(type, event = {}) {
      let prevented = false;
      const payload = {
        button: 0,
        detail: 0,
        defaultPrevented: false,
        preventDefault() {
          prevented = true;
          payload.defaultPrevented = true;
        },
        ...event
      };
      for (const listener of listeners.get(type) || []) listener(payload);
      return prevented;
    }
  };
}

test('the primary pointer press activates, and cancels the default press', () => {
  const node = fakeNode();
  let calls = 0;
  activateOnPress(node, () => { calls += 1; });
  const prevented = node.dispatch('pointerdown', { button: 0 });
  assert.equal(calls, 1);
  assert.equal(prevented, true, 'the press must stop a native drag/selection default');
});

test('secondary and middle presses leave the control alone', () => {
  const node = fakeNode();
  let calls = 0;
  activateOnPress(node, () => { calls += 1; });
  assert.equal(node.dispatch('pointerdown', { button: 2 }), false);
  assert.equal(node.dispatch('pointerdown', { button: 1 }), false);
  assert.equal(calls, 0);
});

test('one pointer press fires the action exactly once, not again on the trailing click', () => {
  const node = fakeNode();
  let calls = 0;
  activateOnPress(node, () => { calls += 1; });
  node.dispatch('pointerdown', { button: 0 });
  // The browser's own click that follows a mouse press carries a real detail count.
  node.dispatch('click', { detail: 1 });
  assert.equal(calls, 1);
});

test('the keyboard click (detail 0) still activates without a pointer press', () => {
  const node = fakeNode();
  let calls = 0;
  activateOnPress(node, () => { calls += 1; });
  node.dispatch('click', { detail: 0 });
  assert.equal(calls, 1);
});

test('the action is committed on the press, before any click can arrive', () => {
  // This is the whole point: a repaint that replaces the node between press and
  // release drops the trailing click, so the activation has to have happened on
  // the press. Ordering the assertion that way is what fails if the helper ever
  // regresses to click-only.
  const node = fakeNode();
  const order = [];
  activateOnPress(node, () => { order.push('activate'); });
  node.dispatch('pointerdown', { button: 0 });
  order.push('rebuild-dropped-the-click');
  assert.deepEqual(order, ['activate', 'rebuild-dropped-the-click']);
});

test('a missing node or action is a no-op rather than a crash', () => {
  assert.doesNotThrow(() => activateOnPress(null, () => {}));
  assert.doesNotThrow(() => activateOnPress(fakeNode(), null));
});
