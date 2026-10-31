'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runCapturedCliProcess } = require('../../src/shared/limits/cliProcess');

test('captured CLI execution preserves output and exit failure for its caller', async () => {
  const result = await runCapturedCliProcess(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3"], { timeoutMs: 5000 });
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.error.code, 3);
});

test('captured CLI timeout terminates POSIX launcher descendants before returning', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const result = await runCapturedCliProcess(process.execPath, ['-e', `
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdout.write(String(child.pid)); setInterval(() => {}, 1000);
`], { timeoutMs: 1500 });
  const pid = Number(result.stdout);
  assert.ok(pid > 0);
  let stopped = false;
  try {
    for (let attempt = 0; attempt < 25; attempt++) {
      try { process.kill(pid, 0); }
      catch (error) { assert.equal(error.code, 'ESRCH'); stopped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(result.error.status, 'unavailable');
    assert.equal(stopped, true);
  } finally {
    if (!stopped) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
  }
});
