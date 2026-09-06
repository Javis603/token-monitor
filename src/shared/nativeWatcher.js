'use strict';

// Per-platform file watcher.
//
// macOS: one `fs.watch(dir, { recursive: true })` per top-level root. The
// recursive form is FSEvents-backed on darwin — one handle per root covers
// the entire subtree, so nothing allocates per directory. chokidar opens one
// watch handle per directory instead, and that count is the whole problem.
// Measured on macOS (kern.maxfilesperproc 61440) against a synthetic tree,
// as RSS delta after ready and the cost of close():
//
//        dirs   chokidar                     native
//         500   +50 MB, close 0.4 s          +0.4 MB, close 1 ms
//       2,000   +121 MB, close 10.4 s        +0.5 MB, close 1 ms
//       5,000   EMFILE, tree never opens     +0.5 MB, close 1 ms
//      10,000   EMFILE, tree never opens     +0.5 MB, close 1 ms
//
// So on a tree the size of OpenClaw's `~/.openclaw/agents/` (~9,700 dirs)
// chokidar does not just cost memory, it exhausts the per-process descriptor
// budget — and EMFILE is in WATCH_DESCRIPTOR_ERROR_CODES, so `handleWatchError`
// then drops the process to 2 s polling for the rest of its life, deliberately
// stickily. The installed app sat at ~2.2 GB there, and at <1 GB after this.
//
// Linux/Windows or any user opt-in to polling: fall back to chokidar, which
// is the only option that supports polling, atomic-write stability, and
// cross-platform inotify/ReadDirectoryChangesW semantics. fs.watch's
// recursive form is documented as not fully supported on Linux, so it is
// not a drop-in there.
//
// Two things chokidar does that the native backend deliberately does not, both
// accepted for the memory win and both macOS-only:
//   - `followSymlinks` (chokidar default true). FSEvents subscribes to a path
//     prefix, so a symlinked *subdirectory* inside a root is not traversed and
//     writes underneath it deliver no event. A symlinked root itself is fine —
//     the subscription resolves it. A user who relocates part of a client's
//     data dir behind a symlink falls back to the periodic full scan for that
//     subtree rather than getting 3–5 s refresh.
//   - `awaitWriteFinish` (500 ms stability in `watcherOptions()`). Native
//     events fire mid-write, so a watch tick can read a partially appended
//     JSONL line. `applyPeriodDelta()` is anchored rather than accumulated, so
//     that shows up as a transient dip corrected by the next event, not as
//     drift.
// Note that FSEvents subscribes by path, not by inode, so a root deleted and
// recreated at the same path keeps delivering — the inode caveat in the
// `fs.watch` docs applies to the inotify/kqueue backends, not to this one.
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
    if (closed) return;
    for (const dir of dirs) {
      let watcher;
      try {
        watcher = fs.watch(dir, { recursive: true, persistent: false }, (eventType, filename) => {
          if (closed) return;
          // `filename` is documented as possibly null, and macOS delivers that
          // for some root-level changes. Something moved inside a watched root
          // even when we cannot localise it, so attribute the event to the root
          // rather than dropping a real signal: `clientsForWatchPath` matches
          // `resolved === root`, so this scans exactly that root's clients
          // instead of degrading to an all-client scan or to nothing at all.
          const fullPath = filename ? path.join(dir, filename) : dir;
          // fs.watch has no `ignored` option, so the matcher runs per event
          // instead of per traversal entry. That is only equivalent to what
          // chokidar would have done because every policy in
          // `watchPolicyEntries()` is prefix-closed: chokidar never descends
          // into a directory it ignores, so a policy that pruned a directory
          // while keeping a path underneath it would be right for chokidar and
          // would leak those events here. Nothing in the type system enforces
          // that, so `watchPolicyPrefixClosure.test.js` asserts it.
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
        //
        // This is the only shape a setup failure takes: fs.watch reports it by
        // throwing from the constructor, not by emitting on the FSWatcher, so
        // there is no window between constructing and attaching the listener
        // below that needs its own guard.
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
