'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createClientRescanState } = require('../../src/electron/renderer/clientRescanState');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('pending and failed rescan state survives replacement renders', async () => {
  const renders = [];
  const timers = [];
  const rescans = createClientRescanState({
    onChange: (clientId) => renders.push({ clientId, ...rescans.snapshot(clientId) }),
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {}
  });
  const scan = deferred();
  const requestId = rescans.begin('cursor');

  // A stats update replaces the row, so the new DOM reads this snapshot rather
  // than relying on the button and feedback nodes that started the request.
  assert.deepEqual(rescans.snapshot('cursor'), { pending: true, failed: false });
  const replacementRender = rescans.snapshot('cursor');
  assert.equal(replacementRender.pending, true);

  scan.promise.then((succeeded) => rescans.finish('cursor', requestId, succeeded));
  scan.resolve(false);
  await scan.promise;
  await Promise.resolve();

  assert.deepEqual(rescans.snapshot('cursor'), { pending: false, failed: true });
  assert.deepEqual(renders.at(-1), { clientId: 'cursor', pending: false, failed: true });
  assert.equal(timers[0].delay, 3000);

  timers[0].callback();
  assert.deepEqual(rescans.snapshot('cursor'), { pending: false, failed: false });
});

test('rescan state is independent per client and ignores stale completions', () => {
  const rescans = createClientRescanState();
  const firstCursor = rescans.begin('cursor');
  const antigravity = rescans.begin('antigravity');
  const secondCursor = rescans.begin('cursor');

  assert.equal(rescans.finish('cursor', firstCursor, false), false);
  assert.deepEqual(rescans.snapshot('cursor'), { pending: true, failed: false });
  assert.deepEqual(rescans.snapshot('antigravity'), { pending: true, failed: false });

  assert.equal(rescans.finish('cursor', secondCursor, true), true);
  assert.equal(rescans.finish('antigravity', antigravity, true), true);
  assert.deepEqual(rescans.snapshot('cursor'), { pending: false, failed: false });
  assert.deepEqual(rescans.snapshot('antigravity'), { pending: false, failed: false });
});
