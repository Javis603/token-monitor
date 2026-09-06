'use strict';

// Per-platform file watcher.
//
// macOS: one `fs.watch(dir, { recursive: true })` per top-level root. The
// recursive form is FSEvents-backed on darwin — one handle per root covers
// the entire subtree, no per-directory descriptor allocation. This is the
// change that brings the installed app's memory from ~2.2 GB to <1 GB on
// directories the size of OpenClaw's `~/.openclaw/agents/` (~9,700 dirs,
// ~22,300 files), where chokidar's per-dir model falls back to polling and
// pins the native allocator high-water.
//
// Linux/Windows or any user opt-in to polling: fall back to chokidar, which
// is the only option that supports polling, atomic-write stability, and
// cross-platform inotify/ReadDirectoryChangesW semantics. fs.watch's
// recursive form is documented as not fully supported on Linux, so it is
// not a drop-in there.
//
// Event protocol mirrors chokidar's `('all', event, filePath)` shape so the
// existing collector logic (`handleWatchEvent`, `clientsForWatchPath`,
// `isQoderCnSelfWatchEvent`) is unchanged.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const { watcherOptions, watchIgnoreMatcher } = require('./collector');

function shouldUseNativeWatcher(usePolling) {
  // macOS only, and only when polling is NOT requested. The polling override
  // (`TOKEN_MONITOR_WATCH_POLLING` and the sticky ENOSPC/EMFILE/ENFILE fallback
  // in `handleWatchError`) must still flip us back to chokidar on darwin, since
  // fs.watch has no polling mode.
  return process.platform === 'darwin' && usePolling !== true;
}

function createNativeWatcher(dirs, clients) {
  const emitter = new EventEmitter();
  const ignore = watchIgnoreMatcher(clients);
  const watchers = [];
  let ready = false;
  let failed = false;
  let closed = false;

  emitter.on('error', () => { failed = true; });

  // Defer fs.watch construction to the next microtask. EventEmitter.emit
  // is synchronous, and the worker's wire() attaches the error listener
  // AFTER createPlatformWatcher returns — without this, a setup-time
  // failure (ENOENT, ENOSPC) emitted during the for-loop below would
  // fire into a listener-less emitter and bypass the ENOSPC/EMFILE/ENFILE
  // sticky fallback in handleWatchError. The microtask also runs the
  // ready event after listeners are in place, matching the chokidar path's
  // async-ready contract.
  queueMicrotask(() => {
    try {
    if (closed) return;
    for (const dir of dirs) {
      let watcher;
      try {
        watcher = fs.watch(dir, { recursive: true, persistent: false }, (eventType, filename) => {
          if (closed) return;
          // Some FSEvents deliveries (root removal, race on close) come with a
          // null filename; nothing to attribute, drop them.
          if (!filename) return;
          const fullPath = path.join(dir, filename);
          // fs.watch has no `ignored` option. The matcher is a pure function
          // of the path (per its contract), so applying it post-event matches
          // what chokidar would have done at watch creation.
          //
          // The matcher follows the chokidar `ignored` contract: truthy =
          // drop the event (the path is not part of a tracked source), falsy
          // = keep. This is the inverse of "keep" semantics; an early version
          // got the polarity backwards and would have dropped the chokidar
          // 'kept' set while emitting the chokidar 'dropped' set.
          if (ignore && ignore(fullPath)) return;
          // FSEvents does not distinguish add / change / unlink in `eventType`
          // (rename covers both, change covers content). `handleWatchEvent`
          // uses the event only in a log-string (`watch:${event}:${basename}`),
          // so a synthetic 'change' keeps attribution correct without losing
          // observable behaviour.
          emitter.emit('all', 'change', fullPath);
        });
      } catch (error) {
        // Setup-time failures (ENOENT, EACCES, ENOSPC) — forward to the host
        // so the ENOSPC/EMFILE/ENFILE sticky fallback in `handleWatchError`
        // sees the real code and keeps unrelated roots up if only one dir is
        // broken. The deferred construction guarantees the worker's error
        // listener is in place by the time we get here.
        emitter.emit('error', error);
        continue;
      }
      watcher.on('error', (error) => {
        if (closed) return;
        emitter.emit('error', error);
      });
      watchers.push(watcher);
    }

    if (failed || ready) return;
    ready = true;
    emitter.emit('ready');
    } catch (error) {
      // Defense in depth: the per-dir try/catch above handles synchronous
      // fs.watch throws, but libuv's ENOENT on macOS can also surface as
      // an async 'error' event on the FSWatcher that fires before our
      // re-emit listener attaches, in which case the throw escapes both
      // try blocks. Forward it to the helper's 'error' channel rather
      // than letting it become an uncaughtException (the host's
      // 'error' handler in handleWatchError already routes ENOENT into
      // the per-root error path it expects).
      emitter.emit('error', error);
    }
  });

  return Object.assign(emitter, {
    kind: 'native',
    async close() {
      closed = true;
      for (const watcher of watchers) {
        try { watcher.close(); } catch (_) { /* teardown must not throw */ }
      }
    }
  });
}

function createChokidarWatcher(dirs, clients, options) {
  const { usePolling } = options;
  // Required lazily: tests stub chokidar via require interception, and the
  // worker-hosted run never wants to load chokidar on the main thread.
  const chokidar = require('chokidar');
  const instance = chokidar.watch(
    dirs,
    watcherOptions(usePolling === true, watchIgnoreMatcher(clients))
  );
  // Re-emit chokidar's events under the standard event names. chokidar's
  // own error/ready handling differs (it surfaces a `failed` flag via
  // close), so we keep its instance untouched and forward through an
  // EventEmitter that callers wire the same way as the native side.
  const emitter = new EventEmitter();
  instance.on('all', (event, filePath) => emitter.emit('all', event, filePath));
  instance.on('error', (error) => emitter.emit('error', error));
  instance.on('ready', () => emitter.emit('ready'));

  return Object.assign(emitter, {
    kind: 'chokidar',
    async close() {
      try { await instance.close(); } catch (_) { /* teardown must not throw */ }
    }
  });
}

function createPlatformWatcher(config) {
  const { dirs, clients, usePolling } = config;
  if (shouldUseNativeWatcher(usePolling)) {
    return createNativeWatcher(dirs, clients);
  }
  return createChokidarWatcher(dirs, clients, { usePolling });
}

module.exports = {
  createPlatformWatcher,
  shouldUseNativeWatcher,
  createNativeWatcher,
  createChokidarWatcher
};
