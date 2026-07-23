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

function fakeRpcChild(onRequest) {
  const child = fakeChild();
  child.stdin.write = (line) => {
    const request = JSON.parse(String(line));
    const respond = (result) => {
      queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: request.id, result })}\n`));
    };
    onRequest(request, respond);
  };
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

test('Codex RPC preserves cancellation from the optional account read', async () => {
  const controller = new AbortController();
  const child = fakeRpcChild((request, respond) => {
    if (request.method === 'initialize') respond({});
    if (request.method === 'account/rateLimits/read') {
      respond({
        rateLimits: {
          primary: { usedPercent: 10, resetsAt: '2026-07-22T12:00:00Z', windowDurationMins: 300 }
        }
      });
    }
    if (request.method === 'account/read') controller.abort(new Error('account read cancelled'));
  });

  await assert.rejects(readCodexRpcWithCommand('codex', {
    signal: controller.signal,
    spawn: () => child,
    platform: 'linux',
    codexRpcTimeoutMs: 1_000
  }), /account read cancelled/);
});

test('Codex RPC preserves cancellation from the empty-quota retry read', async () => {
  const controller = new AbortController();
  let rateLimitReads = 0;
  const child = fakeRpcChild((request, respond) => {
    if (request.method === 'initialize') respond({});
    if (request.method === 'account/read') {
      respond({ account: { email: 'user@example.com', planType: 'plus' } });
    }
    if (request.method === 'account/rateLimits/read') {
      rateLimitReads += 1;
      if (rateLimitReads === 1) respond({ rateLimits: {} });
      else controller.abort(new Error('quota retry cancelled'));
    }
  });

  await assert.rejects(readCodexRpcWithCommand('codex', {
    signal: controller.signal,
    spawn: () => child,
    platform: 'linux',
    codexRpcTimeoutMs: 1_000,
    codexEmptyQuotaRetryDelayMs: 0
  }), /quota retry cancelled/);
});
