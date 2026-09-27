'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-usage-host-'));
process.env.TOKEN_MONITOR_SHARED_DIR = sharedDir;
process.on('exit', () => { try { fs.rmSync(sharedDir, { recursive: true, force: true }); } catch (_) {} });

const {
  createUsageHost,
  createUsageHostCoordinator,
  usageWorkerRequested
} = require('../../src/shared/usageHost');
const { readSessionUsageArchiveSnapshot } = require('../../src/shared/sessionUsageArchiveStore');

const SCRIPTED_WORKER = path.join(__dirname, '..', 'fixtures', 'usageWorkerScriptedCollector.js');

// The host unrefs its worker and its stop timer so neither holds a process open.
// Nothing else here keeps the event loop alive while a test waits on them, and
// the Node 22 runner then cancels that test as unfinished.
let keepAlive = null;
test.before(() => { keepAlive = setInterval(() => {}, 1000); });
test.after(() => clearInterval(keepAlive));
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Records what the host does to a worker without spawning a thread, so the
// protocol and lifecycle ordering can be asserted exactly.
class FakeWorker extends EventEmitter {
  constructor(workerPath, options) {
    super();
    FakeWorker.instances.push(this);
    this.workerPath = workerPath;
    this.workerData = options.workerData;
    this.posted = [];
    this.terminated = 0;
  }
  postMessage(message) { this.posted.push(message); }
  terminate() {
    this.terminated += 1;
    setImmediate(() => this.emit('exit', 1));
    return Promise.resolve(1);
  }
  unref() {}
  reply(message) { this.emit('message', message); }
  calls() { return this.posted.filter((message) => message.type === 'call'); }
  static reset() { FakeWorker.instances = []; }
  static last() { return FakeWorker.instances.at(-1); }
}
FakeWorker.instances = [];

function fakeInProcessCollector() {
  const started = [];
  return {
    started,
    startCollector(options) {
      const handle = {
        options,
        calls: [],
        tick: (...args) => { handle.calls.push(['tick', ...args]); return Promise.resolve('in-process tick'); },
        refreshClient: (...args) => { handle.calls.push(['refreshClient', ...args]); return Promise.resolve(true); },
        stop: (...args) => handle.calls.push(['stop', ...args]),
        whenIdle: () => Promise.resolve(),
        getDiagnostics: () => ({ state: 'idle', host: 'in-process' })
      };
      started.push(handle);
      return handle;
    }
  };
}

function recorder() {
  const events = [];
  return {
    events,
    options: {
      clients: 'codex',
      onUpdate: (summary, reason, meta) => events.push(['update', summary, reason, meta]),
      onPreview: (summary, reason, meta) => events.push(['preview', summary, reason, meta]),
      onError: (error, reason) => events.push(['error', error, reason]),
      onDiagnosticEvent: (event) => events.push(['diagnostic', event]),
      logger: (message) => events.push(['log', message])
    }
  };
}

test('the worker is opt-in through TOKEN_MONITOR_USAGE_WORKER', () => {
  assert.equal(usageWorkerRequested({}), false);
  assert.equal(usageWorkerRequested({ TOKEN_MONITOR_USAGE_WORKER: '' }), false);
  assert.equal(usageWorkerRequested({ TOKEN_MONITOR_USAGE_WORKER: '0' }), false);
  assert.equal(usageWorkerRequested({ TOKEN_MONITOR_USAGE_WORKER: 'off' }), false);
  assert.equal(usageWorkerRequested({ TOKEN_MONITOR_USAGE_WORKER: '1' }), true);
  assert.equal(usageWorkerRequested({ TOKEN_MONITOR_USAGE_WORKER: 'true' }), true);
});

test('without the worker the collector starts on this thread with the options untouched', () => {
  const inProcess = fakeInProcessCollector();
  const options = { clients: 'codex', onUpdate() {} };

  const runtime = createUsageHost(options, {}, { env: {}, startCollector: inProcess.startCollector });

  assert.equal(runtime, inProcess.started[0]);
  assert.equal(inProcess.started[0].options, options);
});

test('the worker receives data only; callbacks stay with the owner', async () => {
  FakeWorker.reset();
  const coordinator = createUsageHostCoordinator({ Worker: FakeWorker });
  const { options } = recorder();

  const first = coordinator.create({
    ...options,
    intervalMs: 60000,
    startBarrier: Promise.resolve(),
    dailyHistoryArchiveWriteEnabled: () => true
  }, { transformSettings: { projectsEnabled: false }, agentPidPath: '/tmp/agent.pid' });
  await flush();

  const { workerData } = FakeWorker.last();
  assert.deepEqual(workerData.options, { clients: 'codex', intervalMs: 60000 });
  assert.deepEqual(workerData.transformSettings, { projectsEnabled: false });
  assert.equal(workerData.agentPidPath, '/tmp/agent.pid');
  assert.equal(workerData.archiveWritesYieldToAgent, true);
  assert.deepEqual(workerData.callbacks, { preview: true, error: true, logger: true });

  coordinator.create({ clients: 'codex', dailyHistoryArchiveWriteEnabled: false });
  first.stop();
  FakeWorker.instances[0].reply({ type: 'stopped' });
  await first.whenIdle();
  await flush();
  assert.equal(FakeWorker.instances.length, 2);
  const second = FakeWorker.last().workerData;
  assert.equal(second.options.dailyHistoryArchiveWriteEnabled, false);
  assert.equal(second.archiveWritesYieldToAgent, false);
  assert.deepEqual(second.callbacks, { preview: false, error: false, logger: false });
});

test('worker reports reach the owner, and summaries are marked as already transformed', async () => {
  FakeWorker.reset();
  const coordinator = createUsageHostCoordinator({ Worker: FakeWorker });
  const { events, options } = recorder();
  const runtime = coordinator.create(options);
  await flush();
  const worker = FakeWorker.last();

  worker.reply({ type: 'preview', summary: { n: 1 }, reason: 'progress', archive: { loaded: true, sessionCount: 1 } });
  worker.reply({ type: 'update', summary: { n: 2 }, reason: 'watch', archive: { loaded: true, sessionCount: 2 }, diagnostics: { state: 'idle', lastTickScope: 'today' } });
  worker.reply({ type: 'diagnostic', event: { subsystem: 'collector', code: 'collector-recovered' } });
  worker.reply({ type: 'error', name: 'Error', message: 'scan failed', reason: 'watch' });
  worker.reply({ type: 'log', message: 'hello' });

  assert.deepEqual(events.map(([kind]) => kind), ['preview', 'update', 'diagnostic', 'error', 'log']);
  assert.deepEqual(events[0].slice(1), [{ n: 1 }, 'progress', { transformed: true }]);
  assert.deepEqual(events[1].slice(1), [{ n: 2 }, 'watch', { transformed: true }]);
  assert.ok(events[3][1] instanceof Error);
  assert.equal(events[3][1].message, 'scan failed');
  assert.equal(events[3][2], 'watch');
  assert.deepEqual(runtime.getDiagnostics(), { state: 'idle', lastTickScope: 'today' });
  assert.deepEqual(runtime.getArchiveState(), { loaded: true, sessionCount: 2 });
});

test('calls made before the worker starts are delivered once it does', async () => {
  FakeWorker.reset();
  const coordinator = createUsageHostCoordinator({ Worker: FakeWorker });
  const runtime = coordinator.create(recorder().options);

  const tick = runtime.tick('manual', { todayOnly: true });
  const refresh = runtime.refreshClient('nope');
  assert.equal(FakeWorker.instances.length, 0);
  await flush();

  const worker = FakeWorker.last();
  const [tickCall, refreshCall] = worker.calls();
  assert.deepEqual([tickCall.method, tickCall.args], ['tick', ['manual', { todayOnly: true }]]);
  assert.deepEqual([refreshCall.method, refreshCall.args], ['refreshClient', ['nope', {}]]);
  worker.reply({ type: 'result', id: tickCall.id, value: true });
  worker.reply({ type: 'result', id: refreshCall.id, error: { name: 'TypeError', message: 'Unsupported targeted usage client: nope' } });

  assert.equal(await tick, true);
  await assert.rejects(refresh, (error) => error instanceof TypeError && /nope/.test(error.message));
});

test('transform settings reach the worker once per change, as its initial settings if it has not started', async () => {
  FakeWorker.reset();
  const coordinator = createUsageHostCoordinator({ Worker: FakeWorker });
  const runtime = coordinator.create(recorder().options, { transformSettings: { sessionUsageArchiveEnabled: true } });

  runtime.updateTransformSettings({ sessionUsageArchiveEnabled: true });
  runtime.updateTransformSettings({ sessionUsageArchiveEnabled: false });
  await flush();

  // Not started yet: the worker starts with the new settings, so not even its
  // startup tick can see the old ones.
  const worker = FakeWorker.last();
  assert.deepEqual(worker.workerData.transformSettings, { sessionUsageArchiveEnabled: false });
  assert.deepEqual(worker.posted, []);

  runtime.updateTransformSettings({ sessionUsageArchiveEnabled: false });
  runtime.updateTransformSettings({ sessionUsageArchiveEnabled: true });
  assert.deepEqual(worker.posted, [{ type: 'transformSettings', settings: { sessionUsageArchiveEnabled: true } }]);

  runtime.stop();
  runtime.updateTransformSettings({ sessionUsageArchiveEnabled: false });
  assert.equal(worker.posted.filter((message) => message.type === 'transformSettings').length, 1);
});

test('stop asks the worker to stop its collector, then terminates it once it has', async () => {
  FakeWorker.reset();
  const coordinator = createUsageHostCoordinator({ Worker: FakeWorker });
  const runtime = coordinator.create(recorder().options);
  await flush();
  const worker = FakeWorker.last();
  const tick = runtime.tick('manual');

  runtime.stop();
  runtime.stop();

  assert.deepEqual(worker.posted.filter((message) => message.type === 'stop'), [{ type: 'stop', options: {} }]);
  assert.equal(worker.terminated, 0);
  assert.equal(runtime.getDiagnostics().state, 'stopped');
  worker.reply({ type: 'stopped' });
  assert.equal(worker.terminated, 1);
  await runtime.whenIdle();
  assert.equal(await tick, undefined);
  assert.equal(await runtime.tick('late'), undefined);
});

test('a worker that does not confirm its stop is terminated after the grace period', async () => {
  FakeWorker.reset();
  const coordinator = createUsageHostCoordinator({ Worker: FakeWorker, stopGraceMs: 5 });
  const runtime = coordinator.create(recorder().options);
  await flush();

  runtime.stop();
  await runtime.whenIdle();

  assert.equal(FakeWorker.last().terminated, 1);
});

test('the quit path lets the worker stop its collector rather than terminating it first', async () => {
  FakeWorker.reset();
  const coordinator = createUsageHostCoordinator({ Worker: FakeWorker });
  const runtime = coordinator.create(recorder().options);
  await flush();

  runtime.stop({ skipCloseWatchers: true });

  // Stopping the collector is what terminates its tokscale subprocesses; the
  // process exit then takes the thread with it.
  assert.deepEqual(FakeWorker.last().posted.at(-1), { type: 'stop', options: { skipCloseWatchers: true } });
  assert.equal(FakeWorker.last().terminated, 0);
  FakeWorker.last().reply({ type: 'stopped' });
  await runtime.whenIdle();
});

test('a replacement worker starts only after the previous one has exited', async () => {
  FakeWorker.reset();
  const coordinator = createUsageHostCoordinator({ Worker: FakeWorker });
  const first = coordinator.create(recorder().options);
  await flush();
  first.stop();

  const second = coordinator.create(recorder().options);
  const queuedTick = second.tick('manual');
  await flush();
  assert.equal(FakeWorker.instances.length, 1);

  FakeWorker.instances[0].reply({ type: 'stopped' });
  await first.whenIdle();
  await flush();
  assert.equal(FakeWorker.instances.length, 2);
  const [call] = FakeWorker.last().calls();
  FakeWorker.last().reply({ type: 'result', id: call.id, value: true });
  assert.equal(await queuedTick, true);
});

test('a runtime stopped while waiting its turn never starts a worker', async () => {
  FakeWorker.reset();
  const coordinator = createUsageHostCoordinator({ Worker: FakeWorker });
  const first = coordinator.create(recorder().options);
  await flush();
  first.stop();
  const second = coordinator.create(recorder().options);
  const tick = second.tick('manual');

  second.stop();
  FakeWorker.instances[0].reply({ type: 'stopped' });
  await second.whenIdle();

  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(await tick, undefined);
});

test('a worker that exits unexpectedly falls back to this thread and replays its calls', async () => {
  FakeWorker.reset();
  const inProcess = fakeInProcessCollector();
  const coordinator = createUsageHostCoordinator({ Worker: FakeWorker, startCollector: inProcess.startCollector });
  const { events, options } = recorder();
  const runtime = coordinator.create(options);
  await flush();
  const tick = runtime.tick('manual');

  FakeWorker.last().emit('error', new Error('worker crashed'));
  FakeWorker.last().emit('exit', 1);

  assert.equal(await tick, 'in-process tick');
  const collector = inProcess.started[0];
  // The original options, callbacks included: the owner's own transform runs again.
  assert.equal(collector.options, options);
  assert.deepEqual(collector.calls, [['tick', 'manual', {}]]);
  assert.deepEqual(events.filter(([kind]) => kind === 'diagnostic').map(([, event]) => event.code), ['usage-worker-failed']);
  assert.match(events.find(([kind]) => kind === 'log')[1], /worker crashed/);
  assert.equal(runtime.getArchiveState(), null);
  assert.deepEqual(runtime.getDiagnostics(), { state: 'idle', host: 'in-process' });

  // Later runtimes stay on this thread for the rest of the process.
  assert.equal(coordinator.inspect().workerDisabled, true);
  const next = coordinator.create(options);
  assert.equal(next, inProcess.started[1]);
  assert.equal(FakeWorker.instances.length, 1);
});

test('a worker that cannot be constructed falls back to this thread', async () => {
  const inProcess = fakeInProcessCollector();
  const coordinator = createUsageHostCoordinator({
    Worker: class { constructor() { throw new Error('DataCloneError'); } },
    startCollector: inProcess.startCollector
  });
  const runtime = coordinator.create(recorder().options);

  assert.equal(await runtime.tick('manual'), 'in-process tick');
  assert.equal(inProcess.started.length, 1);
});

test('round trip through a real worker thread: transform, archive capture and stop', async () => {
  const inProcess = fakeInProcessCollector();
  const coordinator = createUsageHostCoordinator({ workerPath: SCRIPTED_WORKER, startCollector: inProcess.startCollector });
  const { events, options } = recorder();
  const runtime = coordinator.create({
    ...options,
    dailyHistoryArchiveWriteEnabled: () => false
  }, {
    transformSettings: { projectsEnabled: false },
    agentPidPath: path.join(sharedDir, 'no-agent.pid')
  });

  assert.equal(await runtime.tick('preview'), true);
  assert.equal(await runtime.tick('watch'), true);

  const updates = events.filter(([kind]) => kind === 'update');
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1][3], { transformed: true });
  assert.equal(updates[1][1].allTime.sessions['codex:c1'].totalTokens, 120);
  assert.equal(events.filter(([kind]) => kind === 'preview').length, 1);
  assert.deepEqual(events.find(([kind]) => kind === 'log'), ['log', 'tick preview']);
  assert.ok(events.some(([kind, event]) => kind === 'diagnostic' && event.code === 'scripted-tick'));
  assert.equal(runtime.getArchiveState().sessionCount, 1);
  // Rebuilt in the worker from the PID file: no agent is running, so it writes.
  assert.equal(runtime.getDiagnostics().archiveWriteEnabled, true);
  assert.equal(runtime.getDiagnostics().clients, 'codex');

  assert.equal(await runtime.tick('fail'), false);
  const failure = events.find(([kind]) => kind === 'error');
  assert.equal(failure[1].message, 'scripted failure');
  await assert.rejects(runtime.refreshClient('nope'), TypeError);

  runtime.stop();
  await runtime.whenIdle();
  assert.equal(inProcess.started.length, 0);
  const archive = readSessionUsageArchiveSnapshot();
  // Written by the worker's store, read back from disk here.
  assert.equal(archive.sessions['codex:c1'].periods.allTime.totalTokens, 120);
});

test('a real worker transforms with the settings it was handed, not its own defaults', async () => {
  const coordinator = createUsageHostCoordinator({ workerPath: SCRIPTED_WORKER });
  const { events, options } = recorder();
  const runtime = coordinator.create(options, {
    transformSettings: { sessionUsageArchiveEnabled: false },
    agentPidPath: path.join(sharedDir, 'no-agent.pid')
  });

  assert.equal(await runtime.tick('watch'), true);

  // With the archive off the transform neither loads nor captures it.
  assert.deepEqual(runtime.getArchiveState(), {
    loaded: false,
    sessionCount: null,
    lastUpdate: { at: null, durationMs: null, failureCode: null }
  });
  assert.equal(events.filter(([kind]) => kind === 'update').length, 1);
  runtime.stop();
  await runtime.whenIdle();
});

test('pausing the session archive stops a running worker capturing from the next summary on', async () => {
  const coordinator = createUsageHostCoordinator({ workerPath: SCRIPTED_WORKER });
  const { options } = recorder();
  const runtime = coordinator.create({ ...options, scriptedSessionId: 'paused' }, {
    transformSettings: { sessionUsageArchiveEnabled: true },
    agentPidPath: path.join(sharedDir, 'no-agent.pid')
  });

  assert.equal(await runtime.tick('watch'), true);
  const captured = runtime.getArchiveState().lastUpdate;
  runtime.updateTransformSettings({ sessionUsageArchiveEnabled: false });
  assert.equal(await runtime.tick('watch'), true);

  assert.deepEqual(runtime.getArchiveState().lastUpdate, captured);
  runtime.stop();
  await runtime.whenIdle();
  // The first tick captured 110 tokens; the one after the pause (120) was not.
  assert.equal(readSessionUsageArchiveSnapshot().sessions['codex:paused'].periods.allTime.totalTokens, 110);
});

test('a settings change is confirmed only after the capture the worker was already producing', async () => {
  const coordinator = createUsageHostCoordinator({ workerPath: SCRIPTED_WORKER });
  const { events, options } = recorder();
  const runtime = coordinator.create({ ...options, scriptedSessionId: 'in-flight' }, {
    transformSettings: { sessionUsageArchiveEnabled: true },
    agentPidPath: path.join(sharedDir, 'no-agent.pid')
  });
  await runtime.tick('watch');
  const updatesBefore = events.filter(([kind]) => kind === 'update').length;

  // The worker is inside a tick's synchronous post-scan work when the archive
  // is paused, so the pause reaches it only after that tick has captured.
  const busy = runtime.tick('busy');
  runtime.updateTransformSettings({ sessionUsageArchiveEnabled: false });
  await runtime.transformSettingsApplied();

  assert.equal(events.filter(([kind]) => kind === 'update').length, updatesBefore + 1);
  assert.equal(await busy, true);
  await runtime.tick('watch');
  runtime.stop();
  await runtime.whenIdle();
  // 110, then 120 by the in-flight tick before the pause was confirmed; the
  // tick after it (130) was not captured.
  assert.equal(readSessionUsageArchiveSnapshot().sessions['codex:in-flight'].periods.allTime.totalTokens, 120);
});

test('a settings change during a replacement is confirmed only once the previous worker has exited', async () => {
  const coordinator = createUsageHostCoordinator({ workerPath: SCRIPTED_WORKER });
  const host = { transformSettings: { sessionUsageArchiveEnabled: true }, agentPidPath: path.join(sharedDir, 'no-agent.pid') };
  const previous = coordinator.create({ ...recorder().options, scriptedSessionId: 'handover-a' }, host);
  await previous.tick('watch');

  // The previous worker is inside a tick's synchronous work when it is replaced
  // and the archive is paused; its replacement has not started yet.
  const busy = previous.tick('busy');
  previous.stop();
  const next = coordinator.create({ ...recorder().options, scriptedSessionId: 'handover-b' }, host);
  next.updateTransformSettings({ sessionUsageArchiveEnabled: false });
  let confirmed = false;
  const applied = next.transformSettingsApplied().then(() => { confirmed = true; });
  await flush();
  assert.equal(confirmed, false);

  await applied;
  assert.equal(await busy, true);
  assert.equal(await next.tick('watch'), true);
  next.stop();
  await next.whenIdle();
  const archive = readSessionUsageArchiveSnapshot();
  // The previous worker's in-flight capture landed before the confirmation;
  // the replacement started paused.
  assert.equal(archive.sessions['codex:handover-a'].periods.allTime.totalTokens, 120);
  assert.equal(archive.sessions['codex:handover-b'], undefined);
});

test('a real worker that crashes hands its pending call to this thread', async () => {
  const inProcess = fakeInProcessCollector();
  const coordinator = createUsageHostCoordinator({ workerPath: SCRIPTED_WORKER, startCollector: inProcess.startCollector });
  const { events, options } = recorder();
  const runtime = coordinator.create(options, { agentPidPath: path.join(sharedDir, 'no-agent.pid') });

  assert.equal(await runtime.tick('crash'), 'in-process tick');

  assert.equal(inProcess.started.length, 1);
  assert.ok(events.some(([kind, event]) => kind === 'diagnostic' && event.code === 'usage-worker-failed'));
  assert.match(events.find(([kind]) => kind === 'log')[1], /scripted crash/);
  runtime.stop();
  await runtime.whenIdle();
});
