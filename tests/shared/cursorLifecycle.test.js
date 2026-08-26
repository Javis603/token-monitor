'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { cursorLifecycleLockPath, withCursorLifecycle } = require('../../src/shared/cursorLifecycle');

function waitForOutput(child, expected, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${expected}`)), timeoutMs);
    function finish(error) {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve(output);
    }
    function onData(chunk) {
      output += chunk.toString();
      if (output.includes(expected)) finish();
    }
    function onExit(code) {
      finish(new Error(`Cursor lifecycle holder exited ${code}: ${output}`));
    }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

test('Cursor lifecycle lock serializes independent Token Monitor processes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-lifecycle-'));
  const fixture = path.join(__dirname, '..', 'fixtures', 'cursorLifecycleHolder.js');
  const child = spawn(process.execPath, [fixture, home], { stdio: ['pipe', 'pipe', 'pipe'] });
  let parentEntered = false;

  try {
    await waitForOutput(child, 'locked\n');
    const parent = withCursorLifecycle(async () => { parentEntered = true; }, { home });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(parentEntered, false, 'the second process waits for the shared lock');

    child.stdin.end('release\n');
    await parent;
    assert.equal(parentEntered, true);
    if (child.exitCode === null) await once(child, 'exit');
    assert.equal(child.exitCode, 0);
    assert.equal(fs.existsSync(cursorLifecycleLockPath(home)), false);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Cursor lifecycle lock recovers after its owner process crashes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-lifecycle-crash-'));
  const fixture = path.join(__dirname, '..', 'fixtures', 'cursorLifecycleHolder.js');
  const child = spawn(process.execPath, [fixture, home], { stdio: ['pipe', 'pipe', 'pipe'] });
  let parentEntered = false;

  try {
    await waitForOutput(child, 'locked\n');
    child.kill('SIGKILL');
    await once(child, 'exit');

    await withCursorLifecycle(async () => { parentEntered = true; }, { home });
    assert.equal(parentEntered, true);
    assert.equal(fs.existsSync(cursorLifecycleLockPath(home)), false);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Cursor lifecycle lock wait stops when its caller is aborted', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-lifecycle-abort-'));
  const fixture = path.join(__dirname, '..', 'fixtures', 'cursorLifecycleHolder.js');
  const child = spawn(process.execPath, [fixture, home], { stdio: ['pipe', 'pipe', 'pipe'] });
  const controller = new AbortController();
  const reason = new Error('collector stopped');

  try {
    await waitForOutput(child, 'locked\n');
    const waiting = withCursorLifecycle(async () => {}, { home, signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(waiting, (error) => error === reason);

    child.stdin.end('release\n');
    if (child.exitCode === null) await once(child, 'exit');
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
