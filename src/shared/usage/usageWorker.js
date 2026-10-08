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

function transformed(type, summary, reason) {
  const visible = transform.transform(summary);
  post({ type, summary: visible, reason, archive: transform.getState(), diagnostics: diagnostics() });
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
