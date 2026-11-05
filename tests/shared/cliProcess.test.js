'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runCapturedCliProcess } = require('../../src/shared/providers/minimax/cliProcess');

function fakeChild() {
  const listeners = {};
  return {
    pid: 1234,
    stdin: { end() {} },
    kill() { return true; },
    on(name, fn) { (listeners[name] ||= []).push(fn); },
    once(name, fn) { (listeners[name] ||= []).push(fn); },
    emit(name, ...args) { for (const fn of listeners[name] || []) fn(...args); }
  };
}

test('taskkill not-found is treated as successful cleanup', async () => {
  const child = fakeChild();
  const taskkill = fakeChild();
  const calls = [];
  const execFile = (command, args, options, done) => {
    calls.push({ command, args });
    if (command.endsWith('taskkill.exe')) {
      setImmediate(() => {
        taskkill.emit('close', 128);
        done(Object.assign(new Error('not found'), { code: 128 }));
      });
      return taskkill;
    }
    setImmediate(() => { child.emit('close', 0); done(null); });
    return child;
  };
  const promise = runCapturedCliProcess('cmd.exe', ['/c', 'x'], {
    platform: 'win32', windowsVerbatimArguments: true, execFile
  });
  // Trigger the tree kill before the launcher closes.
  child.kill('SIGKILL');
  await promise;
  assert.equal(calls.length, 2);
  assert.ok(calls[1].command.endsWith('taskkill.exe'));
});

test('taskkill real failure still rejects', async () => {
  const child = fakeChild();
  const taskkill = fakeChild();
  const execFile = (command, args, options, done) => {
    if (command.endsWith('taskkill.exe')) {
      setImmediate(() => {
        taskkill.emit('close', 1);
        done(Object.assign(new Error('access denied'), { code: 1 }));
      });
      return taskkill;
    }
    setImmediate(() => { child.emit('close', 0); done(null); });
    return child;
  };
  const promise = runCapturedCliProcess('cmd.exe', ['/c', 'x'], {
    platform: 'win32', windowsVerbatimArguments: true, execFile
  });
  child.kill('SIGKILL');
  await assert.rejects(promise, error => error.code === 'CLI_PROCESS_CLEANUP_FAILED');
});
