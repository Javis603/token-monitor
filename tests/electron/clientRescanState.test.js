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
  assert.deepEqual(rescans.snapshot('cursor'), { pending: true, failed: false, feedbackCode: '' });
  const replacementRender = rescans.snapshot('cursor');
  assert.equal(replacementRender.pending, true);

  scan.promise.then((succeeded) => rescans.finish('cursor', requestId, succeeded, 'rescan-failed'));
  scan.resolve(false);
  await scan.promise;
  await Promise.resolve();

  assert.deepEqual(rescans.snapshot('cursor'), { pending: false, failed: true, feedbackCode: 'rescan-failed' });
  assert.deepEqual(renders.at(-1), {
    clientId: 'cursor',
    pending: false,
    failed: true,
    feedbackCode: 'rescan-failed'
  });
  assert.equal(timers[0].delay, 3000);

  timers[0].callback();
  assert.deepEqual(rescans.snapshot('cursor'), { pending: false, failed: false, feedbackCode: '' });
});

test('rescan state is independent per client and ignores stale completions', () => {
  const rescans = createClientRescanState();
  const firstCursor = rescans.begin('cursor');
  const antigravity = rescans.begin('antigravity');
  const secondCursor = rescans.begin('cursor');

  assert.equal(rescans.finish('cursor', firstCursor, false), false);
  assert.deepEqual(rescans.snapshot('cursor'), { pending: true, failed: false, feedbackCode: '' });
  assert.deepEqual(rescans.snapshot('antigravity'), { pending: true, failed: false, feedbackCode: '' });

  assert.equal(rescans.finish('cursor', secondCursor, true), true);
  assert.equal(rescans.finish('antigravity', antigravity, true), true);
  assert.deepEqual(rescans.snapshot('cursor'), { pending: false, failed: false, feedbackCode: '' });
  assert.deepEqual(rescans.snapshot('antigravity'), { pending: false, failed: false, feedbackCode: '' });
});

test('successful repair feedback survives replacement renders briefly', () => {
  const timers = [];
  const repairs = createClientRescanState({
    setTimer: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: () => {}
  });
  const requestId = repairs.begin('antigravity');
  repairs.finish('antigravity', requestId, true, 'repaired');

  assert.deepEqual(repairs.snapshot('antigravity'), {
    pending: false,
    failed: false,
    feedbackCode: 'repaired'
  });
  timers[0]();
  assert.deepEqual(repairs.snapshot('antigravity'), {
    pending: false,
    failed: false,
    feedbackCode: ''
  });
});

test('finish inside the minimum window holds pending until the window elapses', () => {
  const renders = [];
  const timers = [];
  let clock = 0;
  const rescans = createClientRescanState({
    minimumPendingMs: (clientId) => (clientId === 'trae' ? 1000 : 0),
    now: () => clock,
    onChange: (clientId) => renders.push({ clientId, ...rescans.snapshot(clientId) }),
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {}
  });

  const requestId = rescans.begin('trae');
  clock = 250;
  // The collect already ended, but the button must stay disabled for the rest
  // of the minimum window so the disabled state is actually visible.
  assert.equal(rescans.finish('trae', requestId, true), true);
  assert.deepEqual(rescans.snapshot('trae'), { pending: true, failed: false, feedbackCode: '' });

  timers[0].callback();
  assert.deepEqual(rescans.snapshot('trae'), { pending: false, failed: false, feedbackCode: '' });
  assert.deepEqual(renders.at(-1), { clientId: 'trae', pending: false, failed: false, feedbackCode: '' });
  assert.equal(timers.length, 1);

  // A client without a minimum keeps finishing immediately.
  const cursorId = rescans.begin('cursor');
  assert.equal(rescans.finish('cursor', cursorId, true), true);
  assert.deepEqual(rescans.snapshot('cursor'), { pending: false, failed: false, feedbackCode: '' });
});

test('a begin during the held window discards the stale held finish', () => {
  const timers = [];
  let clock = 0;
  const rescans = createClientRescanState({
    minimumPendingMs: (clientId) => (clientId === 'trae' ? 1000 : 0),
    now: () => clock,
    onChange: () => {},
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {}
  });

  const firstId = rescans.begin('trae');
  clock = 100;
  assert.equal(rescans.finish('trae', firstId, false), true);
  assert.deepEqual(rescans.snapshot('trae'), { pending: true, failed: false, feedbackCode: '' });

  // Re-click replaces the entry; the held failure must not land afterwards.
  const secondId = rescans.begin('trae');
  timers[0].callback();
  assert.deepEqual(rescans.snapshot('trae'), { pending: true, failed: false, feedbackCode: '' });
  assert.equal(rescans.finish('trae', secondId, true), true);
  timers[1].callback();
  assert.deepEqual(rescans.snapshot('trae'), { pending: false, failed: false, feedbackCode: '' });
});

test('a failed finish inside the minimum window applies its failure badge after the hold', () => {
  const timers = [];
  let clock = 0;
  const rescans = createClientRescanState({
    minimumPendingMs: (clientId) => (clientId === 'trae' ? 1000 : 0),
    now: () => clock,
    onChange: () => {},
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {}
  });

  const requestId = rescans.begin('trae');
  clock = 200;
  assert.equal(rescans.finish('trae', requestId, false), true);
  assert.deepEqual(rescans.snapshot('trae'), { pending: true, failed: false, feedbackCode: '' });

  // The hold fires first, and only then does the failure badge get its own
  // 3000ms clear timer.
  timers[0].callback();
  assert.deepEqual(rescans.snapshot('trae'), { pending: false, failed: true, feedbackCode: 'rescan-failed' });
  assert.equal(timers[1].delay, 3000);
  timers[1].callback();
  assert.deepEqual(rescans.snapshot('trae'), { pending: false, failed: false, feedbackCode: '' });
});
