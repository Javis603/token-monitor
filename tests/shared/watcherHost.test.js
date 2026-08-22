'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { performance } = require('node:perf_hooks');

const {
  createInProcessWatcherHost,
  createWatcherHost,
  inProcessRequested
} = require('../../src/shared/watcherHost');

const WATCH_HOST_ENV = 'TOKEN_MONITOR_WATCH_IN_PROCESS';

function tmpTree() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-watch-host-'));
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
  return root;
}

function withoutEnv(fn) {
  const saved = process.env[WATCH_HOST_ENV];
  delete process.env[WATCH_HOST_ENV];
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[WATCH_HOST_ENV];
    else process.env[WATCH_HOST_ENV] = saved;
  }
}

test('the watcher runs in a worker by default', () => {
  withoutEnv(() => {
    const root = tmpTree();
    const host = createWatcherHost({ dirs: [root], clients: 'claude', usePolling: false }, {});
    try {
      // The whole point of the host: chokidar's teardown must not land on the
      // thread driving the UI. A default flipped back to in-process would undo
      // that silently, so it is asserted rather than assumed.
      assert.equal(host.kind, 'worker');
    } finally {
      host.close({ skipClose: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('the env override pins the host in-process', () => {
  const saved = process.env[WATCH_HOST_ENV];
  process.env[WATCH_HOST_ENV] = '1';
  const root = tmpTree();
  try {
    assert.equal(inProcessRequested(), true);
    const host = createWatcherHost({ dirs: [root], clients: 'claude', usePolling: false }, {});
    assert.equal(host.kind, 'in-process');
    host.close();
  } finally {
    if (saved === undefined) delete process.env[WATCH_HOST_ENV];
    else process.env[WATCH_HOST_ENV] = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('off/0/false are honoured as an explicit "use the worker"', () => {
  for (const value of ['0', 'false', 'no', 'off', '']) {
    assert.equal(inProcessRequested({ [WATCH_HOST_ENV]: value }), false, `value: ${JSON.stringify(value)}`);
  }
  for (const value of ['1', 'true', 'yes']) {
    assert.equal(inProcessRequested({ [WATCH_HOST_ENV]: value }), true, `value: ${JSON.stringify(value)}`);
  }
});

test('a worker-hosted watcher delivers events across the thread boundary', async () => {
  const root = tmpTree();
  const events = [];
  let ready = null;
  const readyPromise = new Promise((res) => { ready = res; });
  const host = withoutEnv(() => createWatcherHost(
    { dirs: [root], clients: 'claude', usePolling: false },
    { onEvent: (event, filePath) => events.push([event, filePath]), onReady: () => ready() }
  ));
  assert.equal(host.kind, 'worker');
  try {
    await readyPromise;
    fs.writeFileSync(path.join(root, 'nested', 'a.jsonl'), 'x');
    // awaitWriteFinish holds events for its stability threshold before emitting.
    const deadline = Date.now() + 15000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(events.length > 0, 'expected at least one event from the worker');
    assert.ok(
      events.some(([, filePath]) => String(filePath).endsWith('a.jsonl')),
      `expected the written file in ${JSON.stringify(events)}`
    );
  } finally {
    host.close({ skipClose: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('close() returns to the caller instead of waiting for chokidar teardown', async () => {
  const root = tmpTree();
  let ready = null;
  const readyPromise = new Promise((res) => { ready = res; });
  const host = withoutEnv(() => createWatcherHost(
    { dirs: [root], clients: 'claude', usePolling: false },
    { onReady: () => ready() }
  ));
  try {
    await readyPromise;
    // This is the regression the worker exists to prevent: on the main thread
    // the same call blocked for ~1s on a real tree. The assertion is about the
    // call being non-blocking, not about this fixture being large.
    const started = performance.now();
    host.close();
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 100, `close() blocked the caller for ${elapsed.toFixed(0)}ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a worker error reaches the owner with its code intact', async () => {
  // The descriptor-exhaustion fallback keys off error.code, which does not
  // survive a naive postMessage of an Error, so the host rebuilds it.
  const root = tmpTree();
  const seen = [];
  const host = createWatcherHost(
    { dirs: [root], clients: 'claude', usePolling: false },
    { onError: (error) => seen.push(error) },
    {
      inProcess: false,
      workerPath: path.join(__dirname, 'fixtures', 'watcherErrorWorker.js')
    }
  );
  try {
    const deadline = Date.now() + 10000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].code, 'ENOSPC');
    assert.match(seen[0].message, /no space/i);
  } finally {
    host.close({ skipClose: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unusable worker falls back to watching on this thread', () => {
  const root = tmpTree();
  const fallbacks = [];
  const host = createWatcherHost(
    { dirs: [root], clients: 'claude', usePolling: false },
    { onHostFallback: (error) => fallbacks.push(error) },
    {
      inProcess: false,
      workerThreads: {
        Worker: class {
          constructor() { throw new Error('worker_threads unavailable'); }
        }
      }
    }
  );
  try {
    assert.equal(host.kind, 'in-process');
    assert.equal(fallbacks.length, 1);
    assert.match(fallbacks[0].message, /unavailable/);
  } finally {
    host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the in-process host still honours skipClose', () => {
  const root = tmpTree();
  const closed = [];
  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  chokidar.watch = () => ({
    on() { return this; },
    close() { closed.push('closed'); }
  });
  try {
    const host = createInProcessWatcherHost({ dirs: [root], clients: 'claude' }, {});
    host.close({ skipClose: true });
    assert.deepEqual(closed, [], 'quit path must not walk the tree');
    host.close();
    assert.deepEqual(closed, ['closed']);
  } finally {
    chokidar.watch = originalWatch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
