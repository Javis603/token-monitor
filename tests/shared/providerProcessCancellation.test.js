'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  readCodexRpcWithCommand,
  runProcessText
} = require('../../src/shared/limitCollector');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {} };
  child.kills = 0;
  child.kill = () => { child.kills += 1; };
  return child;
}

test('runProcessText terminates a CLI child when its parent signal aborts', async () => {
  const controller = new AbortController();
  const child = fakeChild();
  const pending = runProcessText('fake-cli', [], {
    signal: controller.signal,
    spawn: () => child,
    timeoutMs: 60_000
  });

  controller.abort(new Error('runtime stopped'));
  await assert.rejects(pending, /runtime stopped/);
  assert.equal(child.kills, 1);
});

test('Codex RPC terminates its app-server child when its parent signal aborts', async () => {
  const controller = new AbortController();
  const child = fakeChild();
  const pending = readCodexRpcWithCommand('codex', {
    signal: controller.signal,
    spawn: () => child,
    platform: 'linux',
    codexRpcTimeoutMs: 60_000
  });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('runtime stopped'));
  await assert.rejects(pending, /runtime stopped/);
  assert.equal(child.kills, 1);
});
