'use strict';

// Real-filesystem coverage of the macOS native `fs.watch({recursive: true})`
// path through `createPlatformWatcher`. Skipped off darwin — `recursive: true`
// is documented as not fully supported on Linux, and the production intent is
// "use this on macOS where FSEvents handles it natively", not "fall back to
// this on other platforms".
//
// The companion test `watcherNativeEvents.test.js` exercises chokidar
// end-to-end; together they cover both backends that `createPlatformWatcher`
// can pick on real CI hardware (darwin for this file, ubuntu+windows+macos
// for the chokidar one).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installSourceEnvGuard } = require('../helpers/sourceEnv');
const { createPlatformWatcher, shouldUseNativeWatcher } = require('../../src/shared/nativeWatcher');
const { watchIgnoreMatcher } = require('../../src/shared/collector');

installSourceEnvGuard(test);

const IS_DARWIN = process.platform === 'darwin';

// Generous for shared CI runners; the goal is "events arrive at all", not a
// timing assertion (the chokidar test has the same shape — see its header
// comment for the reasoning).
const EVENT_TIMEOUT_MS = 45 * 1000;

function withTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-watch-native-'));
}

// Wait for the helper to either emit 'ready' (the stream is live) or 'error'
// (construction failed and the stream is never going live). The native
// watcher's deferred-construction fix (cubic review #1) means 'ready' is
// suppressed when 'error' fires; without this helper, a setup-time failure
// would hang the test until its EVENT_TIMEOUT_MS bound. A short explicit
// timeout also catches the case where 'ready' never fires and 'error'
// never fires — neither should happen in a working build, but a stuck
// microtask is a plausible failure mode worth naming.
function waitForReadyOrError(watcher, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.off('ready', onReady);
      watcher.off('error', onError);
      reject(new Error(`Timed out waiting for ${label} to be ready or error`));
    }, timeoutMs);
    function onReady() {
      clearTimeout(timer);
      watcher.off('error', onError);
      resolve();
    }
    function onError(error) {
      clearTimeout(timer);
      watcher.off('ready', onReady);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    watcher.once('ready', onReady);
    watcher.once('error', onError);
  });
}

function waitForWatcherError(watcher, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.off('error', onError);
      reject(new Error(`Timed out waiting for ${label} to error`));
    }, timeoutMs);
    function onError(error) {
      clearTimeout(timer);
      watcher.off('error', onError);
      resolve(error instanceof Error ? error : new Error(String(error)));
    }
    watcher.once('error', onError);
  });
}
function withControlledOpencodeHome(homeDir, fn) {
  const originalHomedir = os.homedir;
  const originalCodexHome = process.env.CODEX_HOME;
  os.homedir = () => homeDir;
  // Match the chokidar test's setup exactly: CODEX_HOME = opencodeRoot so
  // codex's source root (codexRoot = CODEX_HOME/sessions) is a subdir of
  // opencodeRoot. A file under opencodeRoot/sessions/ is then under BOTH
  // source roots; the opencode policy keeps it and the codex recursive
  // pass's KEEP_EVERYTHING=false policy filters it (the matcher's `!policy`
  // is `!false = true`, returning false → kept). A file under
  // opencodeRoot/log/ is only under opencodeRoot; the opencode policy
  // also keeps it, and there is no codex entry, so the matcher returns
  // true (dropped). Same shapes as the chokidar test's relevantFile /
  // unrelatedFile.
  process.env.CODEX_HOME = path.join(homeDir, '.local', 'share', 'opencode');
  try {
    return fn();
  } finally {
    os.homedir = originalHomedir;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  }
}

function waitForEvent(watcher, predicate, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.off('all', listener);
      reject(new Error(`Timed out waiting for ${label}`));
    }, EVENT_TIMEOUT_MS);
    function listener(event, filePath) {
      if (predicate(event, filePath)) {
        clearTimeout(timer);
        watcher.off('all', listener);
        resolve({ event, filePath });
      }
    }
    watcher.on('all', listener);
  });
}

test('platform strategy selects the native path on darwin with no polling', { skip: !IS_DARWIN }, () => {
  assert.equal(shouldUseNativeWatcher(false), true, 'macOS + no polling → native');
  assert.equal(shouldUseNativeWatcher(true), false, 'macOS + polling → chokidar (fs.watch has no polling mode)');
});

test('native watcher delivers a change for a file in a deeply nested subdirectory', { skip: !IS_DARWIN }, async () => {
  const dir = withTmpDir();
  // FSEvents only delivers events for changes that happen AFTER the
  // stream is registered. nativeWatcher's construction is deferred to a
  // microtask so the worker's error listener is in place before any
  // setup-time failure fires (cubic review #1); that means the test
  // must also wait for the 'ready' event before triggering the change,
  // otherwise the change lands before the FSEvents handle is registered
  // and the event is lost. (Production has the hourly reconciliation
  // safety net described in AGENTS.md; the test asserts delivery, not
  // safety nets.)
  const nested = path.join(dir, 'a', 'b', 'c');
  const target = path.join(nested, 'session.jsonl');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(target, '{"tokens":1}\n');

  const watcher = createPlatformWatcher({
    dirs: [dir],
    clients: 'claude',
    usePolling: false
  });
  try {
    await waitForReadyOrError(watcher, 'the deep-nested watcher');
    const seen = waitForEvent(
      watcher,
      (_event, filePath) => path.basename(filePath) === 'session.jsonl',
      'a session.jsonl event under a/b/c'
    );
    fs.appendFileSync(target, '{"tokens":2}\n');
    const observed = await seen;
    assert.ok(
      observed.filePath.endsWith(path.join('a', 'b', 'c', 'session.jsonl')),
      `expected nested session.jsonl path, got ${observed.filePath}`
    );
  } finally {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native watcher applies the ignore matcher post-event', { skip: !IS_DARWIN }, async () => {
  const dir = withTmpDir();
  // The matcher's polarity follows the chokidar `ignored` contract: truthy
  // means "drop this event" (the path is not part of a tracked source), falsy
  // means "emit it". Use paths where the polarity is unambiguous, derived
  // from the existing chokidar test (watcherNativeEvents.test.js):
  //   trackedFile: under both opencodeRoot AND codexRoot (so the codex
  //     recursive-pass policy returns false and the matcher returns false →
  //     emit). Same shape as the chokidar test's relevantFile.
  //   ignoredFile: under opencodeRoot only (log/ subdir). The opencode
  //     policy's `parts[0] !== 'storage'` is satisfied, so the policy
  //     returns true and the matcher returns true → drop. Same shape as
  //     the chokidar test's unrelatedFile.
  // Using the same paths as the chokidar test is a deliberate choice —
  // the two tests now exercise the same matcher outputs through different
  // backends, so a polarity flip in one is mirrored in the other.
  const home = dir;
  const opencodeRoot = path.join(home, '.local', 'share', 'opencode');
  const codexRoot = path.join(home, '.codex', 'sessions');
  const sessionsDir = path.join(opencodeRoot, 'sessions');
  const logDir = path.join(opencodeRoot, 'log');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  // codexRoot is a separate watch root (the createPlatformWatcher dirs param
  // lists it explicitly); it must exist on disk for fs.watch to register.
  fs.mkdirSync(codexRoot, { recursive: true });
  const trackedFile = path.join(sessionsDir, 'session.jsonl');
  const ignoredFile = path.join(logDir, 'runtime.log');
  fs.writeFileSync(trackedFile, '{"tokens":1}\n');
  fs.writeFileSync(ignoredFile, 'noise\n');

  await withControlledOpencodeHome(home, async () => {
    // Sanity: the matcher is real (returns a predicate) and the polarity
    // matches the chokidar test's expectations. If either sanity check
    // fails the rest of the assertions would pass vacuously on a runner
    // without a real OpenCode install, which is the regression this test
    // guards against.
    const ignoredMatcher = watchIgnoreMatcher('opencode,codex');
    assert.equal(typeof ignoredMatcher, 'function', 'matcher must be a predicate under controlled roots');
    assert.equal(ignoredMatcher(trackedFile), false, 'tracked file must NOT be dropped by the matcher (kept)');
    assert.equal(ignoredMatcher(ignoredFile), true, 'ignored file must be dropped by the matcher');

    const watcher = createPlatformWatcher({
      dirs: [opencodeRoot, codexRoot],
      // Both clients so the codex recursive-pass entry is in the matcher.
      // With clients='opencode' alone, the matcher returns true (drop) for
      // `${opencodeRoot}/sessions/*` because the opencode policy says
      // parts[0] !== 'storage' (it sees 'sessions'). The codex recursive
      // pass's KEEP_EVERYTHING=false policy then returns false (keep),
      // matching the chokidar test's relevantFile shape.
      clients: 'opencode,codex',
      usePolling: false
    });
    try {
      const accepted = [];
      const dropped = [];
      watcher.on('all', (event, filePath) => {
        // The native path uses the chokidar `ignored` convention: skip when
        // the matcher returns truthy. So events from paths the matcher drops
        // (truthy) never reach this handler, and the only events captured
        // here are the ones the matcher kept (falsy). The 'dropped' bucket
        // is built from the parallel matcher check, mirroring how the
        // chokidar test records 'unrelated' events that the matcher pruned.
        if (ignoredMatcher(filePath)) {
          dropped.push({ event, filePath });
        } else {
          accepted.push({ event, filePath });
        }
      });

      // FSEvents only delivers events for changes that happen after the
      // stream is registered. Defer the file change until 'ready' (or fail
      // fast on construction error).
      await waitForReadyOrError(watcher, 'the opencode watcher');
      // Compare paths the same way the chokidar test does — FSEvents may
      // deliver paths that differ from the literal watcher argument by
      // case (rare on macOS but possible under symlinks) or trailing
      // separator, and a strict-equality check is brittle on shared CI
      // runners.
      const normalizePath = (filePath) => path.resolve(filePath);
      const seen = waitForEvent(
        watcher,
        (_event, filePath) => path.basename(filePath) === 'session.jsonl' && normalizePath(filePath) === normalizePath(trackedFile),
        'a session.jsonl event from the tracked root'
      );
      // Write both files. The tracked one should produce an event; the
      // ignored one should not (it is dropped by the matcher before the
      // handler fires). Two touches spaced past awaitWriteFinish's window
      // matches the chokidar test's pattern for shared-runner noise.
      fs.writeFileSync(trackedFile, '{"tokens":2}\n');
      await seen;
      fs.writeFileSync(ignoredFile, 'more noise\n');
      await new Promise((resolve) => setTimeout(resolve, 250));
      fs.appendFileSync(ignoredFile, 'more noise\n');
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.ok(
        accepted.some((entry) => normalizePath(entry.filePath) === normalizePath(trackedFile)),
        `expected a kept event for ${trackedFile}, got accepted=${JSON.stringify(accepted)}`
      );
      assert.equal(
        accepted.some((entry) => normalizePath(entry.filePath) === normalizePath(ignoredFile)),
        false,
        `expected the matcher to drop the ignored event before delivery, but it was accepted: ${JSON.stringify(accepted)}`
      );
      assert.equal(
        dropped.length,
        0,
        `the parallel-matcher check should never have to drop events on the native path (drop is pre-handler); got ${JSON.stringify(dropped)}`
      );
    } finally {
      await watcher.close();
    }
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('native watcher keeps valid roots live after another root fails', { skip: !IS_DARWIN }, async () => {
  const dir = withTmpDir();
  const validRoot = path.join(dir, 'valid');
  const invalidRoot = path.join(dir, 'missing');
  const target = path.join(validRoot, 'session.jsonl');
  fs.mkdirSync(validRoot, { recursive: true });
  fs.writeFileSync(target, '{"tokens":1}\n');

  const watcher = createPlatformWatcher({
    // Keep the broken root first so the test proves that setup failure does
    // not prevent the later valid root from being registered.
    dirs: [invalidRoot, validRoot],
    clients: 'claude',
    usePolling: false
  });
  try {
    const error = await waitForWatcherError(watcher, 'the invalid root');
    assert.equal(error.code, 'ENOENT');
    const seen = waitForEvent(
      watcher,
      (_event, filePath) => path.resolve(filePath) === path.resolve(target),
      'an event from the valid root after the invalid root fails'
    );
    fs.appendFileSync(target, '{"tokens":2}\n');
    await seen;
  } finally {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native watcher close() resolves cleanly', { skip: !IS_DARWIN }, async () => {
  const dir = withTmpDir();
  const watcher = createPlatformWatcher({
    dirs: [dir],
    clients: 'claude',
    usePolling: false
  });
  // close() must resolve (not throw, not hang) so the worker's closeCurrent
  // await doesn't block the next config application.
  await watcher.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
