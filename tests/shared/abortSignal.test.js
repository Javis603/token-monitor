'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { abortReason, throwIfAborted } = require('../../src/shared/abortSignal');

test('abort helpers preserve an Error reason exactly', () => {
  const controller = new AbortController();
  const reason = new Error('collector stopped');
  controller.abort(reason);

  assert.equal(abortReason(controller.signal), reason);
  assert.throws(() => throwIfAborted(controller.signal), (error) => error === reason);
});

test('abort helpers normalize missing and non-Error reasons', () => {
  const missingError = abortReason({ aborted: true }, 'fallback');
  assert.equal(missingError.name, 'AbortError');
  assert.equal(missingError.message, 'fallback');

  const text = new AbortController();
  text.abort('superseded');
  assert.throws(
    () => throwIfAborted(text.signal, 'fallback'),
    (error) => error.name === 'AbortError' && error.message === 'superseded'
  );
});

test('throwIfAborted is a no-op for a live signal', () => {
  assert.doesNotThrow(() => throwIfAborted(new AbortController().signal));
  assert.doesNotThrow(() => throwIfAborted());
});
