'use strict';

// Worker half of the watch host. chokidar's close() walks every watched entry
// and its cost is superlinear in that count, so running it on the thread that
// owns the collector froze the UI for about a second on every runtime restart.
//
// This thread is the only place a chokidar instance ever exists, which is what
// keeps descriptors from overlapping: a reconfigure closes the previous watcher
// and awaits it before opening the next, so the old roots are fully released
// first. That ordering used to be provided by the owner closing synchronously
// before starting a new collector, and it has to be preserved here instead.
//
// Nothing but the watcher lives here. Roots, attribution, debouncing and every
// tick decision stay on the owning thread, so there is no collector state to
// keep in sync.

const { parentPort, workerData } = require('node:worker_threads');
const chokidar = require('chokidar');

const { watcherOptions, watchIgnoreMatcher } = require('./collector');

// Latest-wins rather than a queue. A teardown can run for seconds, and a user
// flipping several settings in that window must not make the worker replay
// every intermediate root set: only the newest request is worth applying, and
// the ones it overtook are answered by having moved past them.
let desired = workerData?.initial || null;
let appliedRevision = -1;
let watcher = null;
let watcherRevision = -1;
let running = false;

function post(message) {
  try { parentPort.postMessage(message); } catch (_) { /* owner is gone */ }
}

function wire(instance, revision) {
  instance.on('all', (event, filePath) => {
    // Keyed on the live watcher rather than the applied revision: a teardown
    // has not finished applying the next config yet, so comparing against
    // appliedRevision would keep forwarding events from roots being released.
    if (revision !== watcherRevision) return;
    post({ type: 'event', revision, event, filePath });
  });
  instance.on('error', (error) => post({
    type: 'error',
    revision,
    message: error?.message || String(error),
    code: error?.code || ''
  }));
}

async function closeCurrent() {
  if (!watcher) return;
  const instance = watcher;
  watcher = null;
  watcherRevision = -1;
  // chokidar's close() is documented as async and only settles once every
  // closer has run. Reporting before it resolves would let the owner start a
  // new watcher while these descriptors are still held, which is the overlap
  // this design exists to prevent.
  try { await instance.close(); } catch (_) { /* teardown must not throw */ }
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (desired && desired.revision !== appliedRevision) {
      const target = desired;
      await closeCurrent();
      // A newer request arrived while the old tree was closing. Drop this one
      // and apply the newest instead of rebuilding something already stale.
      if (desired !== target) continue;
      if (target.config) {
        try {
          const { dirs, clients, usePolling } = target.config;
          const instance = chokidar.watch(dirs, watcherOptions(usePolling === true, watchIgnoreMatcher(clients)));
          watcher = instance;
          watcherRevision = target.revision;
          appliedRevision = target.revision;
          wire(instance, target.revision);
          await new Promise((resolve) => {
            let settled = false;
            const finish = () => { if (!settled) { settled = true; resolve(); } };
            instance.once('ready', finish);
            instance.once('error', finish);
          });
          if (watcherRevision === target.revision) post({ type: 'ready', revision: target.revision });
        } catch (error) {
          appliedRevision = target.revision;
          post({
            type: 'error',
            revision: target.revision,
            message: error?.message || String(error),
            code: error?.code || ''
          });
        }
      } else {
        appliedRevision = target.revision;
        post({ type: 'stopped', revision: target.revision });
      }
    }
  } finally {
    running = false;
  }
}

parentPort.on('message', (message) => {
  if (message?.type === 'configure') {
    desired = { revision: message.revision, config: message.config };
    void pump();
    return;
  }
  if (message?.type === 'stop') {
    desired = { revision: message.revision, config: null };
    void pump();
  }
});

if (desired) void pump();
