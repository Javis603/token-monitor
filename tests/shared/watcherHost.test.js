'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { performance } = require('node:perf_hooks');

const {
  createInProcessWatcherHost,
  createWatcherCoordinator,
  createWatcherHost,
  inProcessRequested
} = require('../../src/shared/watcherHost');

const WATCH_HOST_ENV = 'TOKEN_MONITOR_WATCH_IN_PROCESS';

function tmpTree(extra = 'nested') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-watch-host-'));
  fs.mkdirSync(path.join(root, extra), { recursive: true });
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

// Records what the coordinator does to a worker without spawning a thread, so
// lifecycle ordering can be asserted exactly.
class FakeWorker extends EventEmitter {
  constructor() {
    super();
    FakeWorker.instances.push(this);
    this.posted = [];
    this.terminated = 0;
    this.unrefMessageListeners = null;
  }
  postMessage(message) { this.posted.push(message); }
  terminate() {
    this.terminated += 1;
    if (!this.deferTerminate) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.finishTerminate = resolve;
      this.failTerminate = reject;
    });
  }
  configures() { return this.posted.filter((m) => m.type === 'configure'); }
  unref() { this.unrefMessageListeners = this.listenerCount('message'); }
  static reset() { FakeWorker.instances = []; }
  static last() { return FakeWorker.instances.at(-1); }
}
FakeWorker.instances = [];

function stubChokidar() {
  const chokidar = require('chokidar');
  const original = chokidar.watch;
  const built = [];
  chokidar.watch = (dirs, options) => {
    const instance = { dirs, options, closed: 0, on() { return instance; }, close() { instance.closed += 1; } };
    built.push(instance);
    return instance;
  };
  return { built, restore: () => { chokidar.watch = original; } };
}

test('the watcher runs in a worker by default', () => {
  withoutEnv(() => {
    FakeWorker.reset();
    const coordinator = createWatcherCoordinator({ Worker: FakeWorker });
    const host = createWatcherHost({ dirs: ['/tmp/x'], clients: 'claude' }, {}, { coordinator });
    // A default flipped back to in-process would silently undo the whole point.
    assert.equal(host.kind, 'worker');
  });
});

test('the env override pins the host in-process', () => {
  const saved = process.env[WATCH_HOST_ENV];
  process.env[WATCH_HOST_ENV] = '1';
  const stub = stubChokidar();
  try {
    assert.equal(inProcessRequested(), true);
    const host = createWatcherHost({ dirs: ['/tmp/x'], clients: 'claude' }, {});
    assert.equal(host.kind, 'in-process');
    host.close();
  } finally {
    stub.restore();
    if (saved === undefined) delete process.env[WATCH_HOST_ENV];
    else process.env[WATCH_HOST_ENV] = saved;
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

test('unref runs after the message listener is attached', () => {
  FakeWorker.reset();
  const coordinator = createWatcherCoordinator({ Worker: FakeWorker });
  coordinator.acquire({ dirs: ['/tmp/x'], clients: 'claude' }, {});
  // Attaching a 'message' listener refs the MessagePort, so unref'ing first is
  // silently undone and the watcher keeps the process alive.
  assert.ok(FakeWorker.last().unrefMessageListeners >= 1, 'unref must run after listeners are attached');
});

test('a crashing worker falls back only once it has actually exited', async () => {
  FakeWorker.reset();
  const stub = stubChokidar();
  const fallbacks = [];
  try {
    const coordinator = createWatcherCoordinator({ Worker: FakeWorker });
    coordinator.acquire({ dirs: ['/tmp/x'], clients: 'claude' }, { onHostFallback: (e) => fallbacks.push(e) });
    assert.equal(coordinator.inspect().hasWorker, true);

    // 'error' means the thread threw and is being torn down; it does not mean
    // its descriptors are released. Starting a watcher here would hold two sets
    // at once, on a path that is most likely reached under resource pressure.
    FakeWorker.last().emit('error', new Error("Cannot find module 'watcherWorker'"));
    await wait(30);
    assert.equal(coordinator.inspect().inProcess, false, 'must not watch before the thread exits');
    assert.equal(stub.built.length, 0);

    // 'exit' is the Worker's final event, and a Worker constructor does not
    // throw on a missing or broken module, so this is where a load failure
    // surfaces too. Without it the watcher would die silently.
    FakeWorker.last().emit('exit', 1);
    await until(() => coordinator.inspect().inProcess);
    assert.equal(coordinator.inspect().workerDisabled, true);
    assert.equal(fallbacks.length, 1);
    assert.equal(stub.built.length, 1, 'the fallback host must actually start watching');
    // The reported cause is the thread's own error, not the bare exit code.
    assert.match(fallbacks[0].message, /Cannot find module/);
  } finally {
    stub.restore();
  }
});

test('an unexpected worker exit falls back too', async () => {
  FakeWorker.reset();
  const stub = stubChokidar();
  try {
    const coordinator = createWatcherCoordinator({ Worker: FakeWorker });
    coordinator.acquire({ dirs: ['/tmp/x'], clients: 'claude' }, {});
    FakeWorker.last().emit('exit', 1);
    await until(() => coordinator.inspect().inProcess);
    assert.equal(coordinator.inspect().inProcess, true);
    assert.equal(stub.built.length, 1);
  } finally {
    stub.restore();
  }
});

test('one failure produces one fallback, not one per event', async () => {
  FakeWorker.reset();
  const stub = stubChokidar();
  const fallbacks = [];
  try {
    const coordinator = createWatcherCoordinator({ Worker: FakeWorker });
    coordinator.acquire({ dirs: ['/tmp/x'], clients: 'claude' }, { onHostFallback: (e) => fallbacks.push(e) });
    // This is the real Node sequence for a worker that cannot load its module:
    // the constructor succeeds, then 'error' fires, then 'exit'. Handling them
    // independently builds a second in-process watcher and abandons the first.
    const worker = FakeWorker.last();
    worker.emit('error', new Error("Cannot find module 'watcherWorker'"));
    worker.emit('exit', 1);
    await until(() => coordinator.inspect().inProcess);
    await wait(30);
    assert.equal(stub.built.length, 1, 'a single failure must not start two watchers');
    assert.equal(fallbacks.length, 1, 'the owner must be told once');
  } finally {
    stub.restore();
  }
});

test('an expected exit after terminate is not mistaken for a failure', async () => {
  FakeWorker.reset();
  const stub = stubChokidar();
  const fallbacks = [];
  try {
    const coordinator = createWatcherCoordinator({ Worker: FakeWorker });
    const host = coordinator.acquire({ dirs: ['/tmp/x'], clients: 'claude' }, { onHostFallback: (e) => fallbacks.push(e) });
    const worker = FakeWorker.last();
    host.close({ skipClose: true });
    worker.emit('exit', 0);
    await wait(50);
    assert.equal(fallbacks.length, 0, 'a terminate we asked for is not a failure');
    assert.equal(stub.built.length, 0);
  } finally {
    stub.restore();
  }
});

test('messages from a superseded watcher are dropped', () => {
  FakeWorker.reset();
  const first = [];
  const second = [];
  const coordinator = createWatcherCoordinator({ Worker: FakeWorker });
  const handleA = coordinator.acquire({ dirs: ['/a'], clients: 'claude' }, { onEvent: (_e, p) => first.push(p) });
  const revisionA = FakeWorker.last().posted.at(-1).revision;
  handleA.close();
  coordinator.acquire({ dirs: ['/b'], clients: 'claude' }, { onEvent: (_e, p) => second.push(p) });
  // The old watcher can still emit while its teardown runs; those events belong
  // to roots the new collector never asked for.
  FakeWorker.last().emit('message', { type: 'event', revision: revisionA, event: 'add', filePath: '/a/stale.jsonl' });
  assert.deepEqual(second, [], 'a superseded watcher must not feed the new owner');
  assert.deepEqual(first, []);
});

test('no replacement worker starts while the old thread is still exiting', async () => {
  FakeWorker.reset();
  const coordinator = createWatcherCoordinator({ Worker: FakeWorker });
  const first = coordinator.acquire({ dirs: ['/a'], clients: 'claude' }, {});
  const wedged = FakeWorker.last();
  wedged.deferTerminate = true;
  first.close();
  coordinator.acquire({ dirs: ['/b'], clients: 'claude' }, {});
  assert.equal(wedged.terminated, 1);
  assert.equal(coordinator.inspect().terminating, true);

  // terminate() resolves only once the thread has actually exited, so a
  // settings change landing inside that window must not spawn a second worker
  // while the first may still hold its descriptors.
  coordinator.acquire({ dirs: ['/c'], clients: 'claude' }, {});
  await wait(30);
  assert.equal(FakeWorker.instances.length, 1, 'a replacement must wait for the exit');

  wedged.finishTerminate();
  await until(() => FakeWorker.instances.length === 2);
  const replacement = FakeWorker.last();
  await until(() => replacement.configures().length === 1);
  // Latest-wins: the owner at the time the gate clears, not the one that was
  // current when the watchdog fired.
  assert.deepEqual(replacement.configures()[0].config.dirs, ['/c']);
  assert.equal(coordinator.inspect().terminating, false);
});

test('a terminate that never confirms falls back instead of assuming release', async () => {
  FakeWorker.reset();
  const stub = stubChokidar();
  const fallbacks = [];
  try {
    const coordinator = createWatcherCoordinator({ Worker: FakeWorker });
    const first = coordinator.acquire({ dirs: ['/a'], clients: 'claude', usePolling: false }, { onHostFallback: (e) => fallbacks.push(e) });
    const wedged = FakeWorker.last();
    wedged.deferTerminate = true;
    first.close();
    coordinator.acquire({ dirs: ['/b'], clients: 'claude', usePolling: false }, { onHostFallback: (e) => fallbacks.push(e) });

    wedged.failTerminate(new Error('terminate failed'));
    await until(() => coordinator.inspect().inProcess);
    // A rejected terminate is not evidence the descriptors went away, so a
    // second worker must not be started on the strength of it.
    assert.equal(FakeWorker.instances.length, 1);
    assert.equal(stub.built.length, 1, 'the owner must still end up watching');
    assert.equal(stub.built[0].options.usePolling, true, 'unconfirmed release must not overlap native descriptors');
    assert.equal(coordinator.inspect().forcePollingFallback, true);
    assert.equal(fallbacks.length, 1);

    // The unconfirmed native worker may still be alive. Closing this fallback
    // and acquiring another owner must not silently re-enable native watching.
    const fallback = coordinator.acquire(
      { dirs: ['/c'], clients: 'claude', usePolling: false },
      { onHostFallback: (e) => fallbacks.push(e) }
    );
    assert.equal(fallback.kind, 'in-process');
    assert.equal(stub.built.length, 2);
    assert.equal(stub.built[0].closed, 1, 'the previous fallback host must close');
    assert.equal(stub.built[1].options.usePolling, true, 'polling must stay sticky for every later owner');
    fallback.close();
  } finally {
    stub.restore();
  }
});

test('the quit path terminates instead of waiting for the slow teardown', () => {
  FakeWorker.reset();
  const coordinator = createWatcherCoordinator({ Worker: FakeWorker });
  const host = coordinator.acquire({ dirs: ['/tmp/x'], clients: 'claude' }, {});
  host.close({ skipClose: true });
  const worker = FakeWorker.last();
  assert.equal(worker.terminated, 1);
  assert.equal(worker.posted.filter((m) => m.type !== 'configure').length, 0);
});

test('successive collectors recycle the worker without overlapping', async () => {
  FakeWorker.reset();
  const coordinator = createWatcherCoordinator({ Worker: FakeWorker });
  const first = coordinator.acquire({ dirs: ['/a'], clients: 'claude' }, {});
  const retiring = FakeWorker.last();
  first.close();
  coordinator.acquire({ dirs: ['/b'], clients: 'claude' }, {});
  assert.equal(retiring.terminated, 1, 'the old allocation boundary must be recycled');
  assert.equal(FakeWorker.instances.length, 1, 'replacement must wait for confirmed exit');
  await until(() => FakeWorker.instances.length === 2);
  const replacement = FakeWorker.last();
  assert.notEqual(replacement, retiring);
  await until(() => replacement.configures().length === 1);
  assert.deepEqual(replacement.configures()[0].config.dirs, ['/b']);
});

test('a worker error reaches the owner with its code intact', async () => {
  FakeWorker.reset();
  const seen = [];
  const coordinator = createWatcherCoordinator({ Worker: FakeWorker });
  coordinator.acquire({ dirs: ['/tmp/x'], clients: 'claude' }, { onError: (e) => seen.push(e) });
  // The descriptor-exhaustion fallback keys off error.code, which does not
  // survive a naive postMessage of an Error.
  FakeWorker.last().emit('message', { type: 'error', message: 'ENOSPC: no space left', code: 'ENOSPC' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, 'ENOSPC');
});

test('a real worker delivers events and stops watching the old roots after a reconfigure', async () => {
  const rootA = tmpTree();
  const rootB = tmpTree();
  const seen = [];
  const coordinator = withoutEnv(() => createWatcherCoordinator());
  let readyCount = 0;
  const handlers = {
    onEvent: (event, filePath) => seen.push(filePath),
    onReady: () => { readyCount += 1; }
  };
  try {
    const first = coordinator.acquire({ dirs: [rootA], clients: 'claude', usePolling: false }, handlers);
    assert.ok(await until(() => readyCount >= 1), 'worker never reported ready');
    fs.writeFileSync(path.join(rootA, 'nested', 'a.jsonl'), 'x');
    assert.ok(await until(() => seen.some((p) => p.endsWith('a.jsonl'))), 'no event from the worker');

    first.close();
    seen.length = 0;
    readyCount = 0;
    const second = coordinator.acquire({ dirs: [rootB], clients: 'claude', usePolling: false }, handlers);
    assert.ok(await until(() => readyCount >= 1), 'worker never reported ready after reconfigure');

    // The old roots must be genuinely released, not merely filtered.
    fs.writeFileSync(path.join(rootA, 'nested', 'stale.jsonl'), 'x');
    fs.writeFileSync(path.join(rootB, 'nested', 'fresh.jsonl'), 'x');
    assert.ok(await until(() => seen.some((p) => p.endsWith('fresh.jsonl'))), 'new roots not watched');
    await wait(800);
    assert.ok(!seen.some((p) => p.endsWith('stale.jsonl')), 'old roots still delivering events');
    second.close({ skipClose: true });
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test('a reconfigure issued before the first watcher is ready still lands', async () => {
  const rootA = tmpTree();
  const rootB = tmpTree();
  const seen = [];
  let ready = 0;
  const coordinator = withoutEnv(() => createWatcherCoordinator());
  const handlers = { onEvent: (_e, p) => seen.push(p), onReady: () => { ready += 1; } };
  try {
    // Deliberately does not wait for the first watcher: awaiting `ready` inside
    // the pump used to hold the whole lifecycle for an initial scan, leaving
    // the roots the owner actually wants unwatched until it finished.
    const first = coordinator.acquire({ dirs: [rootA], clients: 'claude', usePolling: false }, handlers);
    first.close();
    const second = coordinator.acquire({ dirs: [rootB], clients: 'claude', usePolling: false }, handlers);
    assert.ok(await until(() => ready >= 1), 'the latest config never became ready');

    fs.writeFileSync(path.join(rootB, 'nested', 'fresh.jsonl'), 'x');
    assert.ok(await until(() => seen.some((p) => p.endsWith('fresh.jsonl'))), 'latest roots not watched');
    fs.writeFileSync(path.join(rootA, 'nested', 'stale.jsonl'), 'x');
    await wait(800);
    assert.ok(!seen.some((p) => p.endsWith('stale.jsonl')), 'superseded roots still delivering');
    second.close({ skipClose: true });
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test('rapid restarts leave the latest worker active after every exit barrier', async () => {
  const roots = [tmpTree(), tmpTree(), tmpTree()];
  let ready = 0;
  const coordinator = withoutEnv(() => createWatcherCoordinator());
  const handlers = { onReady: () => { ready += 1; } };
  try {
    const a = coordinator.acquire({ dirs: [roots[0]], clients: 'claude', usePolling: false }, handlers);
    a.close();
    const b = coordinator.acquire({ dirs: [roots[1]], clients: 'claude', usePolling: false }, handlers);
    b.close();
    const c = coordinator.acquire({ dirs: [roots[2]], clients: 'claude', usePolling: false }, handlers);
    assert.ok(await until(() => ready >= 1), 'the latest config never became ready');
    assert.equal(coordinator.inspect().terminating, false);
    assert.equal(coordinator.inspect().hasWorker, true);
    c.close({ skipClose: true });
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('close() returns to the caller instead of waiting for chokidar teardown', async () => {
  const root = tmpTree();
  let ready = 0;
  const coordinator = withoutEnv(() => createWatcherCoordinator());
  try {
    const host = coordinator.acquire({ dirs: [root], clients: 'claude' }, { onReady: () => { ready += 1; } });
    assert.ok(await until(() => ready >= 1), 'worker never reported ready');
    // On the main thread this same call blocked for ~1s on a real tree.
    const started = performance.now();
    host.close();
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 100, `close() blocked the caller for ${elapsed.toFixed(0)}ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the in-process host still honours skipClose', () => {
  const stub = stubChokidar();
  try {
    const host = createInProcessWatcherHost({ dirs: ['/tmp/x'], clients: 'claude' }, {});
    host.close({ skipClose: true });
    assert.equal(stub.built[0].closed, 0, 'quit path must not walk the tree');
    host.close();
    assert.equal(stub.built[0].closed, 1);
  } finally {
    stub.restore();
  }
});
