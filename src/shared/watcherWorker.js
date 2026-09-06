'use strict';

// Worker half of the watch host. The owning thread would otherwise block on
// chokidar's close() (superlinear in watched-directory count), so the watcher
// runs here, isolated from the UI.
//
// The macOS optimisation: a single `fs.watch(root, { recursive: true })` per
// top-level dir replaces chokidar's per-directory handles, so a 10k-dir tree
// like OpenClaw's agent dir costs one FSEvents stream per root instead of
// 10k descriptors. See `src/shared/nativeWatcher.js` for the strategy
// selection (macOS only; polling override still flips us back to chokidar).
// The worker still owns the watcher so other platforms keep their close()
// isolation, and so a collect-restart can recycle the thread to release
// any native allocation high-water.
//
// Nothing but the watcher lives here. Roots, attribution, debouncing and
// every tick decision stay on the owning thread, so there is no collector
// state to keep in sync.

const { parentPort, workerData } = require('node:worker_threads');

const { createPlatformWatcher } = require('./nativeWatcher');

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
  // Per-instance rather than one worker-wide flag: a flag would let a
  // teardown we asked for mask a genuine failure of the watcher that
  // replaced it. The flag only gates 'ready' — a single broken root out
  // of many must not suppress events from the valid roots (the collector's
  // reaction logic is identical for events from any root, and a teardown
  // here would just hide live work behind a single bad entry in
  // `watchClientRootsForClients()`'s output). The 'all' handler posts as
  // long as the watcher instance is still the live one.
  let failed = false;
  instance.on('all', (event, filePath) => {
    if (revision !== watcherRevision) return;
    post({ type: 'event', revision, event, filePath });
  });
  instance.on('error', (error) => {
    failed = true;
    post({
      type: 'error',
      revision,
      message: error?.message || String(error),
      code: error?.code || ''
    });
  });
  instance.on('ready', () => {
    // An initialisation error is not readiness, and a watcher that has
    // since been replaced must not announce itself.
    if (failed) return;
    if (watcher !== instance || watcherRevision !== revision) return;
    post({ type: 'ready', revision });
  });
}

async function closeCurrent() {
  if (!watcher) return;
  const instance = watcher;
  watcher = null;
  watcherRevision = -1;
  // The platform watcher's close() is async to match the chokidar shape; the
  // native backend's close resolves synchronously, so its await is cheap.
  // Reporting before the close settles would let the owner start the next
  // watcher while the old one still holds descriptors — the overlap this
  // design exists to prevent.
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
          const instance = createPlatformWatcher({ dirs, clients, usePolling });
          watcher = instance;
          watcherRevision = target.revision;
          appliedRevision = target.revision;
          wire(instance, target.revision);
        } catch (error) {
          appliedRevision = target.revision;
          post({
            type: 'error',
            revision: target.revision,
            message: error?.message || String(error),
            code: error?.code || ''
          });
        }
      } else appliedRevision = target.revision;
    }
  } finally {
    running = false;
  }
}

parentPort.on('message', (message) => {
  if (message?.type === 'configure') {
    desired = { revision: message.revision, config: message.config };
    void pump();
  }
});

if (desired) void pump();
