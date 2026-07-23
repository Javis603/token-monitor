'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ProbeTimeoutError,
  runWithProbeDeadline
} = require('../../src/shared/probeDeadline');

test('runWithProbeDeadline passes a child signal and returns the task result', async () => {
  let observed;
  const result = await runWithProbeDeadline(({ signal, deadlineMs }) => {
    observed = { signal, deadlineMs };
    return 'ok';
  }, { deadlineMs: 50 });

  assert.equal(result, 'ok');
  assert.equal(observed.deadlineMs, 50);
  assert.equal(observed.signal.aborted, false);
});

test('runWithProbeDeadline rejects with a typed timeout and aborts the task signal', async () => {
  let taskSignal;
  await assert.rejects(
    runWithProbeDeadline(({ signal }) => {
      taskSignal = signal;
      return new Promise(() => {});
    }, { deadlineMs: 5 }),
    (error) => error instanceof ProbeTimeoutError
      && error.code === 'PROBE_TIMEOUT'
      && error.status === 'timeout'
  );

  assert.equal(taskSignal.aborted, true);
  assert.ok(taskSignal.reason instanceof ProbeTimeoutError);
});

test('runWithProbeDeadline propagates parent cancellation even when the task ignores it', async () => {
  const parent = new AbortController();
  const reason = new Error('runtime stopped');
  let taskSignal;
  const pending = runWithProbeDeadline(({ signal }) => {
    taskSignal = signal;
    return new Promise(() => {});
  }, { signal: parent.signal, deadlineMs: 1000 });

  parent.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(taskSignal.aborted, true);
  assert.equal(taskSignal.reason, reason);
});

test('runWithProbeDeadline does not dispatch when the parent is already aborted', async () => {
  const parent = new AbortController();
  const reason = new Error('already stopped');
  let called = false;
  parent.abort(reason);

  await assert.rejects(
    runWithProbeDeadline(() => {
      called = true;
    }, { signal: parent.signal, deadlineMs: 100 }),
    (error) => error === reason
  );
  assert.equal(called, false);
});

test('runWithProbeDeadline rejects invalid non-finite bounds before dispatch', async () => {
  let called = false;
  await assert.rejects(
    runWithProbeDeadline(() => {
      called = true;
    }, { deadlineMs: Infinity }),
    /finite positive deadlineMs/
  );
  assert.equal(called, false);
});
