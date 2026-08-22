'use strict';

// Worker half of the watch host. chokidar's close() is synchronous and
// superlinear in the number of watched directories (measured: ~1.1s for 548
// dirs, ~12s for 1820), so running it on the main thread freezes the widget for
// as long as it takes. Nothing but the watcher itself lives here: roots,
// attribution, debouncing and every tick decision stay on the owning thread, so
// this file has no collector state to keep in sync.

const { parentPort, workerData } = require('node:worker_threads');
const chokidar = require('chokidar');

const { watcherOptions, watchIgnoreMatcher } = require('./collector');

// The ignore matcher is a function, so it cannot cross the postMessage
// boundary. The client list can, and rebuilding the matcher here from the same
// input keeps one definition of what is ignored.
const { dirs, clients, usePolling } = workerData || {};
const watcher = chokidar.watch(dirs, watcherOptions(usePolling === true, watchIgnoreMatcher(clients)));

watcher.on('ready', () => parentPort.postMessage({ type: 'ready' }));
watcher.on('all', (event, filePath) => parentPort.postMessage({ type: 'event', event, filePath }));
watcher.on('error', (error) => parentPort.postMessage({
  type: 'error',
  message: error?.message || String(error),
  code: error?.code || ''
}));

parentPort.on('message', (message) => {
  if (message?.type !== 'close') return;
  // Report before exiting so the owner can stop waiting on us, then let the
  // thread end on its own: terminate() from the other side would race this
  // close and is not documented to release the descriptors it holds.
  try {
    watcher.close();
  } catch (_) {
    // A failed close still has to release the owner.
  }
  parentPort.postMessage({ type: 'closed' });
  parentPort.close();
});
