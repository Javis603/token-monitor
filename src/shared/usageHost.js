'use strict';

// Where usage collection physically runs.
//
// A watch tick does tens of milliseconds of synchronous work after its scan
// (the exact delta, merging periods, session metadata, archive capture and
// projection), and a full scan reads transcript heads and tails synchronously
// for hundreds of milliseconds more. On the thread that owns the widget's input
// and windows that is a visible stall every few seconds while an AI client is
// writing. A usage host runs the same collector and transform on a worker
// thread instead and implements the usage runtime contract for the owner:
// tick, refreshClient, stop, whenIdle and getDiagnostics, with onUpdate,
// onPreview, onError, logger and onDiagnosticEvent called from what the worker
// reports.
//
// Summaries arrive already transformed. The worker owns the session archive as
// its writer, so the owner's own transform must not capture them again; the
// third onUpdate/onPreview argument says so.
//
// One worker at a time per coordinator. A replacement starts only after the
// previous worker has exited, so two collectors never overlap: not their scans,
// not their watcher descriptor sets (the watcher is a worker nested in this
// one), and not their archive writes.
//
// The in-process collector is a real fallback, as in watcherHost.js. A Worker
// constructor does not throw on a broken module; it emits 'error' and exits, and
// so does a worker that crashes later. An exit nobody asked for switches this
// runtime to the in-process collector, replays the calls that were waiting on
// the worker, and keeps later runtimes in-process for the rest of the process.
//
// On by default. TOKEN_MONITOR_USAGE_WORKER=0 pins the in-process collector.

const { startCollector } = require('./collector');
const { createLiveSubprocessTable, signalLiveSubprocesses } = require('./subprocessTermination');

const WORKER_PATH = require.resolve('./usageWorker');
// How long a stopping worker gets to stop its collector (which terminates its
// tokscale subprocesses) and close the archive before it is terminated anyway.
const STOP_GRACE_MS = 5000;
const TRANSFORMED = Object.freeze({ transformed: true });
const CALLER_OPTION_KEYS = Object.freeze([
  'onUpdate',
  'onPreview',
  'onError',
  'onDiagnosticEvent',
  'logger',
  'dailyHistoryArchiveWriteEnabled',
  'startBarrier'
]);

function usageWorkerRequested(env = process.env) {
  const raw = String(env.TOKEN_MONITOR_USAGE_WORKER ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function rebuildError(reported = {}) {
  const Constructor = reported.name === 'TypeError' ? TypeError : Error;
  const error = new Constructor(reported.message || 'usage worker error');
  if (reported.name && error.name !== reported.name) error.name = reported.name;
  return error;
}

// Exported as a factory for the same reason as the watcher coordinator: tests
// run concurrently and must not share one worker. Production uses the default
// instance below.
function createUsageHostCoordinator(deps = {}) {
  const WorkerClass = deps.Worker || require('node:worker_threads').Worker;
  const workerPath = deps.workerPath || WORKER_PATH;
  const startInProcess = deps.startCollector || startCollector;
  const stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
  const killSubprocess = deps.killSubprocess;
  let workerDisabled = false;
  // The subprocess tables of workers that have not exited yet.
  const liveSubprocessTables = new Set();
  // Settles once the most recently created runtime's worker has exited, or once
  // that runtime has given up on starting one.
  let previousExit = Promise.resolve();

  // `host` carries what the worker needs that is not a collector option:
  //   transformSettings   the settings the usage transform reads
  //   agentPidPath        the headless agent's PID file
  // A function-valued dailyHistoryArchiveWriteEnabled is taken to mean "write
  // unless the headless agent owns the archive" and is rebuilt in the worker
  // from agentPidPath, which is the only rule any caller passes.
  function create(options = {}, host = {}) {
    if (workerDisabled) return startInProcess(options);

    const collectorOptions = { ...options };
    for (const key of CALLER_OPTION_KEYS) delete collectorOptions[key];
    const archiveWritesYieldToAgent = typeof options.dailyHistoryArchiveWriteEnabled === 'function';
    if (!archiveWritesYieldToAgent && options.dailyHistoryArchiveWriteEnabled !== undefined) {
      collectorOptions.dailyHistoryArchiveWriteEnabled = options.dailyHistoryArchiveWriteEnabled;
    }
    const workerData = {
      options: collectorOptions,
      transformSettings: host.transformSettings || {},
      agentPidPath: host.agentPidPath,
      archiveWritesYieldToAgent,
      liveSubprocesses: createLiveSubprocessTable(),
      callbacks: {
        preview: typeof options.onPreview === 'function',
        error: typeof options.onError === 'function',
        logger: typeof options.logger === 'function'
      }
    };

    let worker = null;
    let collector = null;
    let stopped = false;
    let terminating = false;
    let stopTimer = null;
    let workerError = null;
    let diagnostics = null;
    let archiveState = null;
    let sentTransformSettings = JSON.stringify(workerData.transformSettings);
    // Resolvers for settings updates the worker has not confirmed yet, in the
    // order they were sent.
    const settingsAcks = [];
    let settingsApplied = Promise.resolve();
    let nextCallId = 0;
    const pending = new Map();
    const queued = [];
    let resolveExit;
    const exit = new Promise((resolve) => { resolveExit = resolve; });
    const gate = previousExit;
    previousExit = exit;

    function notify(fn, ...args) {
      try {
        return fn?.(...args);
      } catch (error) {
        try { options.onError?.(error, 'usage-host'); } catch (_) {}
        return undefined;
      }
    }

    function send(message) {
      if (worker) worker.postMessage(message);
      else queued.push(message);
    }

    function settleRemaining() {
      for (const entry of pending.values()) entry.resolve(undefined);
      pending.clear();
    }

    function fallBack(error) {
      worker = null;
      queued.length = 0;
      workerDisabled = true;
      diagnostics = null;
      archiveState = null;
      notify(options.onDiagnosticEvent, { subsystem: 'usage-runtime', code: 'usage-worker-failed' });
      notify(options.logger, `usage worker failed, collecting on this thread instead: ${error?.message || error}`);
      try {
        collector = startInProcess(options);
      } catch (startError) {
        settleRemaining();
        notify(options.onError, startError, 'startup');
        return;
      }
      // Calls the worker never answered are replayed rather than dropped: a
      // manual refresh or a targeted client scan still gets its tick.
      const replay = [...pending.values()];
      pending.clear();
      for (const entry of replay) {
        Promise.resolve()
          .then(() => collector[entry.method](...entry.args))
          .then(entry.resolve, entry.reject);
      }
    }

    function onMessage(message) {
      if (message?.diagnostics !== undefined) diagnostics = message.diagnostics;
      switch (message?.type) {
        case 'update':
          if (message.archive) archiveState = message.archive;
          notify(options.onUpdate, message.summary, message.reason, TRANSFORMED);
          return;
        case 'preview':
          if (message.archive) archiveState = message.archive;
          notify(options.onPreview, message.summary, message.reason, TRANSFORMED);
          return;
        case 'diagnostic':
          notify(options.onDiagnosticEvent, message.event);
          return;
        case 'error':
          notify(options.onError, rebuildError(message), message.reason);
          return;
        case 'log':
          notify(options.logger, message.message);
          return;
        case 'result': {
          const entry = pending.get(message.id);
          if (!entry) return;
          pending.delete(message.id);
          if (message.error) entry.reject(rebuildError(message.error));
          else entry.resolve(message.value);
          return;
        }
        case 'transformSettingsApplied':
          settingsAcks.shift()?.();
          return;
        case 'stopped':
          terminate();
          return;
        default:
      }
    }

    function terminate() {
      if (!worker || terminating) return;
      terminating = true;
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      Promise.resolve(worker.terminate()).catch(() => {});
    }

    function onExit(code) {
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      worker = null;
      // A worker that finished its stop has already terminated its
      // subprocesses. One that crashed, or was terminated after the grace,
      // leaves them running and unowned, so this is the last chance to reach
      // them.
      signalLiveSubprocesses(workerData.liveSubprocesses, 'SIGTERM', killSubprocess);
      liveSubprocessTables.delete(workerData.liveSubprocesses);
      // A worker that is gone captures nothing more under any settings.
      for (const resolve of settingsAcks.splice(0)) resolve();
      if (stopped) settleRemaining();
      else fallBack(workerError || new Error(`usage worker exited unexpectedly (code ${code})`));
      resolveExit();
    }

    Promise.all([gate, Promise.resolve(options.startBarrier).catch(() => {})]).then(() => {
      if (stopped) { resolveExit(); return; }
      if (workerDisabled) {
        // Another runtime's worker failed while this one waited its turn.
        fallBack(new Error('usage worker disabled'));
        resolveExit();
        return;
      }
      let spawned;
      try {
        spawned = new WorkerClass(workerPath, { workerData });
      } catch (error) {
        fallBack(error);
        resolveExit();
        return;
      }
      spawned.on('message', onMessage);
      spawned.on('error', (error) => { workerError = error; });
      spawned.on('exit', onExit);
      // Listeners first: attaching 'message' refs the port again.
      spawned.unref?.();
      worker = spawned;
      liveSubprocessTables.add(workerData.liveSubprocesses);
      for (const message of queued.splice(0)) worker.postMessage(message);
    });

    function call(method, args) {
      if (collector) return Promise.resolve().then(() => collector[method](...args));
      if (stopped) return Promise.resolve(undefined);
      return new Promise((resolve, reject) => {
        const id = ++nextCallId;
        pending.set(id, { method, args, resolve, reject });
        send({ type: 'call', id, method, args });
      });
    }

    return {
      getDiagnostics() {
        if (collector) return collector.getDiagnostics();
        const latest = diagnostics || { state: 'running' };
        return stopped ? { ...latest, state: 'stopped' } : latest;
      },
      // The session archive state the worker's transform last reported; null
      // once the in-process collector took over and the owner's own transform
      // is the one keeping it again.
      getArchiveState: () => (collector ? null : archiveState),
      // The settings the worker's transform reads can change without the
      // runtime being replaced, and a replacement waits out the reconfigure
      // settle delay, so the running worker is sent them directly. Before the
      // worker starts they become its initial settings instead. After a
      // fallback the owner's own transform reads its settings live, so there is
      // nothing to send.
      updateTransformSettings(next = {}) {
        if (collector) return;
        const serialized = JSON.stringify(next);
        if (serialized === sentTransformSettings) return;
        sentTransformSettings = serialized;
        // A worker asked to stop can still be finishing a capture, so only its
        // exit confirms that nothing more is written under the old settings.
        if (stopped) {
          settingsApplied = exit;
          return;
        }
        // Not started yet: the predecessor it waits for is the writer that can
        // still capture under the old settings.
        if (!worker) {
          workerData.transformSettings = next;
          settingsApplied = gate;
          return;
        }
        worker.postMessage({ type: 'transformSettings', settings: next });
        settingsApplied = new Promise((resolve) => settingsAcks.push(resolve));
      },
      // Settles once the worker has applied the latest settings sent to it. The
      // worker handles the message only after the work it is doing, so a
      // summary it was already producing is captured before this settles, as
      // it would be in-process, where the save itself waits behind that work.
      transformSettingsApplied: () => settingsApplied,
      refreshClient: (clientId, refreshOptions = {}) => call('refreshClient', [clientId, refreshOptions]),
      tick: (reason = 'manual', tickOptions = {}) => call('tick', [reason, tickOptions]),
      // Synchronous like the collector's stop(): nothing this runtime reports
      // afterwards reaches the owner as a live update, because the device runtime
      // fences by generation. The worker is gone once whenIdle() settles.
      stop(stopOptions = {}) {
        if (stopped) return;
        stopped = true;
        if (collector) {
          collector.stop(stopOptions);
          return;
        }
        if (!worker) {
          // Still waiting for its turn: it will never start, so nothing queued
          // for it will be answered.
          queued.length = 0;
          settleRemaining();
          return;
        }
        // The quit path (skipCloseWatchers) takes this route too. Terminating at
        // once would gain nothing, since the process exit takes the thread with
        // it, and would cost the worker its chance to stop the collector, which
        // is what terminates its tokscale subprocesses.
        worker.postMessage({ type: 'stop', options: stopOptions });
        stopTimer = setTimeout(terminate, stopGraceMs);
        stopTimer.unref?.();
      },
      whenIdle() {
        if (collector) return collector.whenIdle();
        if (stopped) return exit;
        return call('whenIdle', []);
      }
    };
  }

  return {
    create,
    // Settles once no worker created so far is still running.
    whenIdle: () => previousExit,
    // For the quit path, which exits right after stopping its runtimes without
    // waiting: nothing guarantees a worker handles its stop before the process
    // is gone, so its subprocesses are sent the same SIGTERM the in-process
    // collector's stop() sends, from this thread and synchronously.
    terminateSubprocesses() {
      for (const table of liveSubprocessTables) signalLiveSubprocesses(table, 'SIGTERM', killSubprocess);
    },
    inspect: () => ({ workerDisabled })
  };
}

const defaultCoordinator = createUsageHostCoordinator();

function createUsageHost(options = {}, host = {}, deps = {}) {
  const useWorker = deps.worker ?? usageWorkerRequested(deps.env || process.env);
  if (!useWorker) return (deps.startCollector || startCollector)(options);
  return (deps.coordinator || defaultCoordinator).create(options, host);
}

function whenUsageHostsIdle(coordinator = defaultCoordinator) {
  return coordinator.whenIdle();
}

function terminateUsageHostSubprocesses(coordinator = defaultCoordinator) {
  coordinator.terminateSubprocesses();
}

module.exports = {
  createUsageHost,
  createUsageHostCoordinator,
  terminateUsageHostSubprocesses,
  usageWorkerRequested,
  whenUsageHostsIdle
};
