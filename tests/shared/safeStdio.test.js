'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { installSafeStdout } = require('../../src/shared/safeStdio');

test('installSafeStdout registers a no-op EPIPE handler on stdout and stderr', () => {
  installSafeStdout();
  assert.ok(process.stdout.listeners('error').length >= 1, 'stdout should have an error listener');
  assert.ok(process.stderr.listeners('error').length >= 1, 'stderr should have an error listener');
});

test('the installed handler swallows EPIPE', () => {
  installSafeStdout();
  const handlers = process.stdout.listeners('error');
  const handler = handlers[handlers.length - 1];
  const err = new Error('EPIPE');
  err.code = 'EPIPE';
  assert.doesNotThrow(() => handler(err));
});

test('the installed handler re-throws non-EPIPE errors so genuine bugs surface', () => {
  installSafeStdout();
  const handlers = process.stdout.listeners('error');
  const handler = handlers[handlers.length - 1];
  const err = new Error('disk full');
  err.code = 'ENOSPC';
  assert.throws(() => handler(err), /disk full/);
});

test('installSafeStdout is idempotent', () => {
  installSafeStdout();
  const stdoutCount = process.stdout.listeners('error').length;
  const stderrCount = process.stderr.listeners('error').length;
  installSafeStdout();
  assert.equal(process.stdout.listeners('error').length, stdoutCount);
  assert.equal(process.stderr.listeners('error').length, stderrCount);
});
