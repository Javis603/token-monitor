'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { sendWhenRendererReady } = require('../../src/electron/deferredWindowSend');

function fakeContents({ loading = false } = {}) {
  const listeners = new Map();
  return {
    sent: [],
    destroyed: false,
    isLoading: () => loading,
    isDestroyed() { return this.destroyed; },
    once(event, handler) {
      const forEvent = listeners.get(event) || [];
      forEvent.push(handler);
      listeners.set(event, forEvent);
    },
    listenerCount(event) { return (listeners.get(event) || []).length; },
    emit(event) {
      const forEvent = listeners.get(event) || [];
      listeners.set(event, []);
      for (const handler of forEvent) handler();
    },
    send(channel, payload) { this.sent.push({ channel, payload }); },
    finishLoading() { loading = false; this.emit('did-finish-load'); }
  };
}

test('a live renderer is sent to immediately', () => {
  const contents = fakeContents();
  sendWhenRendererReady(contents, 'stats:push', { n: 1 });
  assert.deepEqual(contents.sent, [{ channel: 'stats:push', payload: { n: 1 } }]);
  assert.equal(contents.listenerCount('did-finish-load'), 0);
});

test('a loading renderer is sent to once it finishes', () => {
  const contents = fakeContents({ loading: true });
  sendWhenRendererReady(contents, 'stats:push', { n: 1 });
  assert.deepEqual(contents.sent, [], 'nothing arrives while the listener is not registered yet');

  contents.finishLoading();
  assert.deepEqual(contents.sent, [{ channel: 'stats:push', payload: { n: 1 } }]);
});

test('a queued payload that is no longer current is dropped', () => {
  // A slow load can outlast the first real collection. Delivering the queued
  // snapshot then would walk the numbers backwards until the next push, which
  // in a connected session can be minutes away.
  const contents = fakeContents({ loading: true });
  const seed = { n: 1 };
  let published = seed;
  sendWhenRendererReady(contents, 'stats:push', seed, () => published === seed);

  published = { n: 2 }; // a real collection landed while the window was loading
  contents.finishLoading();
  assert.deepEqual(contents.sent, []);
});

test('a queued payload that is still current is delivered', () => {
  const contents = fakeContents({ loading: true });
  const current = { n: 1 };
  let published = current;
  sendWhenRendererReady(contents, 'stats:push', current, () => published === current);

  contents.finishLoading();
  assert.deepEqual(contents.sent, [{ channel: 'stats:push', payload: current }]);
});

test('a window that goes away before the load finishes is never sent to', () => {
  const contents = fakeContents({ loading: true });
  sendWhenRendererReady(contents, 'stats:push', { n: 1 });
  contents.destroyed = true;
  contents.finishLoading();
  assert.deepEqual(contents.sent, []);
});

test('an already destroyed target registers nothing', () => {
  const contents = fakeContents({ loading: true });
  contents.destroyed = true;
  sendWhenRendererReady(contents, 'stats:push', { n: 1 });
  assert.equal(contents.listenerCount('did-finish-load'), 0);
  sendWhenRendererReady(null, 'stats:push', { n: 1 });
});
