'use strict';

// Worker half of the usage host. The collector, the usage transform and the
// session archive store all run on this thread, so the synchronous work around
// a scan — the watch delta, merging periods, session metadata, archive capture
// and projection — never blocks the thread that owns the widget's input and
// windows. usageHost.js is the owning side and documents the lifecycle.
//
// Everything the owner configured arrives as data. Its callbacks come back out
// as messages: summaries leave here already transformed, so the owner does not
// run the transform a second time.

const { parentPort, workerData } = require('node:worker_threads');

const { startCollector } = require('../collector');
const { externalAgentActive } = require('./agentPid');
const { createCursorUsageEventIndex } = require('../providers/cursor/usageEvents');
const { createSessionUsageArchiveStore } = require('./sessionUsageArchiveStore');
const { trackLiveSubprocesses } = require('../subprocessTermination');
const { createUsageTransform } = require('./usageTransform');

const config = workerData || {};
// Lists this thread's subprocesses where the owner can signal them if the
// process exits before this thread handles its stop.
trackLiveSubprocesses(config.liveSubprocesses);
const callbacks = config.callbacks || {};
const isExternalAgentActive = () => externalAgentActive(config.agentPidPath);
const store = createSessionUsageArchiveStore({ cursorUsageEvents: createCursorUsageEventIndex() });
let collector = null;

function post(message) {
  try { parentPort.postMessage(message); } catch (_) { /* owner is gone */ }
}

// Attached to every message so the owner's synchronous getDiagnostics() can
// answer from the latest state this thread reported.
function diagnostics() {
  try { return collector?.getDiagnostics() ?? null; } catch (_) { return null; }
}

const transform = createUsageTransform({
  store,
  getSettings: () => config.transformSettings || {},
  isExternalAgentActive,
  onCaptureFailure: () => post({
    type: 'diagnostic',
    event: { subsystem: 'storage', code: 'storage-archive-update-failed' }
  })
});

// Return dead heap to the OS after publishing.
//
// A tick allocates the merged summary and its structured-clone payload, and V8
// sizes this isolate's heap from allocation rate rather than live data. With
// the default old-space limit nothing asks for a collection, so pages that held
// superseded summaries stay committed and the process looks large long after
// those objects died. A full GC here is cheap (tens of milliseconds on this
// thread, which owns no window) and V8 decommits what it frees. A collection
// that reclaims little means the live set owns the heap, so the next threshold
// moves above it instead of collecting on every tick.
const GC_THRESHOLD_BYTES = 96 * 1024 * 1024;
const GC_RECLAIM_FLOOR_BYTES = 8 * 1024 * 1024;
const GC_MIN_INTERVAL_MS = 10_000;
const collectGarbage = (() => {
  try {
    // `gc` is only injected for --expose-gc starts; enabling it here changes
    // nothing else about V8's behaviour.
    require('node:v8').setFlagsFromString('--expose-gc');
    return require('node:vm').runInNewContext('gc');
  } catch (_) {
    return null;
  }
})();
let gcThresholdBytes = GC_THRESHOLD_BYTES;
let lastGcAt = 0;

function collectDeadHeap() {
  if (!collectGarbage) return;
  const startedAt = Date.now();
  if (startedAt - lastGcAt < GC_MIN_INTERVAL_MS) return;
  if (process.memoryUsage().heapUsed < gcThresholdBytes) return;
  lastGcAt = startedAt;
  // Let the tick or the postMessage serialization that grew the heap finish.
  setImmediate(() => {
    const before = process.memoryUsage().heapUsed;
    try {
      collectGarbage();
    } catch (_) {
      // A collection failing must not take the collector down.
      return;
    }
    const after = process.memoryUsage().heapUsed;
    if (before - after < GC_RECLAIM_FLOOR_BYTES) gcThresholdBytes = after + 32 * 1024 * 1024;
  });
}

function transformed(type, summary, reason) {
  const visible = transform.transform(summary, reason, { preview: type === 'preview' });
  post({ type, summary: visible, reason, archive: transform.getState(), diagnostics: diagnostics() });
  collectDeadHeap();
  return visible;
}

collector = startCollector({
  ...config.options,
  // The owner's rule is "write unless the headless agent owns the archive". A
  // function cannot cross the thread boundary, so it is rebuilt from the same
  // PID file here.
  ...(config.archiveWritesYieldToAgent
    ? { dailyHistoryArchiveWriteEnabled: () => !isExternalAgentActive() }
    : {}),
  onUpdate: (summary, reason) => transformed('update', summary, reason),
  ...(callbacks.activity ? { onSessionActivity: (patch) => post({ type: 'activity', patch }) } : {}),
  ...(callbacks.preview ? { onPreview: (summary, reason) => { transformed('preview', summary, reason); } } : {}),
  ...(callbacks.error
    ? {
        onError: (error, reason) => post({
          type: 'error',
          reason,
          name: error?.name,
          message: error?.message || String(error),
          diagnostics: diagnostics()
        })
      }
    : {}),
  ...(callbacks.logger ? { logger: (message) => post({ type: 'log', message }) } : {}),
  onDiagnosticEvent: (event) => post({ type: 'diagnostic', event, diagnostics: diagnostics() })
});
post({ type: 'diagnostics', diagnostics: diagnostics() });

const CALLS = new Set(['tick', 'refreshClient', 'whenIdle', 'setCodexDotsVisible']);

function call(message) {
  Promise.resolve()
    .then(() => collector[message.method](...(message.args || [])))
    .then(
      (value) => post({ type: 'result', id: message.id, value, diagnostics: diagnostics() }),
      (error) => post({
        type: 'result',
        id: message.id,
        error: { name: error?.name, message: error?.message || String(error) },
        diagnostics: diagnostics()
      })
    );
}

async function stop(options) {
  // A throwing stop must still close the store and report back; the owner
  // would otherwise only learn of the exit from its grace timer.
  try { collector.stop(options); } catch (_) {}
  // The store is closed only once no tick is left to capture into it.
  try { await collector.whenIdle(); } catch (_) {}
  try { store.close(); } catch (_) {}
  post({ type: 'stopped', diagnostics: diagnostics() });
}

parentPort.on('message', (message) => {
  if (message?.type === 'call' && CALLS.has(message.method)) {
    call(message);
    return;
  }
  if (message?.type === 'transformSettings') {
    config.transformSettings = message.settings || {};
    post({ type: 'transformSettingsApplied' });
    return;
  }
  if (message?.type === 'stop') void stop(message.options || {});
});
