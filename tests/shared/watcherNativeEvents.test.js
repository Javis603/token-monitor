'use strict';

// Every other watcher test mocks chokidar, which means none of them can tell
// whether native file events actually arrive on the platform running them.
// That gap is the whole risk in watching without polling: the failure mode is
// not a crash but silence, and silence looks exactly like an idle machine.
//
// So this file talks to the real filesystem with the real production options
// (watcherOptions, imported rather than restated, so the two cannot drift) and
// asserts that a write produces an event. CI runs the suite on ubuntu-latest,
// windows-latest and macos-latest, so this is the check that keeps native
// events honest on the two platforms the maintainer cannot test by hand.
//
// It asserts delivery, never latency. A shared CI runner is far too noisy for a
// timing assertion, and a flaky test in this position would get muted, which
// costs exactly the coverage it exists to provide.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chokidar = require('chokidar');

const { watcherOptions, watchIgnoreMatcher } = require('../../src/shared/collector');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

installSourceEnvGuard(test);

// awaitWriteFinish holds an event for stabilityThreshold (500 ms) before it is
// emitted, so the floor is already half a second before any scheduling noise.
// The bound is generous on purpose: this asserts that events arrive at all, so
// the only thing a tighter bound buys is a faster failure on a starved runner,
// at the cost of failing for a reason that has nothing to do with the watcher.
const EVENT_TIMEOUT_MS = 45 * 1000;

// Why the writes below are retried rather than done once after `ready`.
//
// chokidar's `ready` means "the initial directory scan finished", NOT "the
// native stream is delivering". A file created between those two moments is
// reported by neither: ignoreInitial suppresses the scan, and the stream's
// start point is already past the file's creation. That event is lost for good,
// while any later write to the same path arrives normally.
//
// Measured on darwin with the repro that found this: writing once immediately
// after `ready` lost the event in 0/120 runs single-process, but 27% of runs
// with eight watcher processes in parallel — which is what `node --test` does
// to this file. Every failure had the same shape: no first event, and a second
// write to the same path delivered ~610 ms later. That is the ~15% CI flake.
//
// Re-touching until an event lands does not weaken anything. A watcher that is
// genuinely not delivering never produces an event however many times the file
// is written; only the unobservable scan/stream boundary is retried away. It
// also makes the pruning assertion below stronger, because by the time it runs
// the stream is proven live rather than assumed live.
const TOUCH_INTERVAL_MS = 1500;

// Retrying an individual write is not enough on its own: if the action being
// tested is `mkdir`, its addDir is what falls into the gap, chokidar never
// starts watching the new directory, and no amount of writing inside it will
// ever produce an event. So prove the stream is delivering with a throwaway
// file first, and only then let the test do what it came to do.
//
// `liveDir` must be a path the watcher is not pruning — for a test that passes
// an `ignored` matcher, the sentinel goes in a directory that matcher keeps.
async function awaitWatcherLive(watcher, liveDir) {
  const sentinel = path.join(liveDir, '.tm-watch-live');
  const seen = new Promise((resolve) => {
    watcher.on('all', (_event, filePath) => {
      if (path.basename(filePath) === '.tm-watch-live') resolve();
    });
  });
  try {
    await writeUntilObserved(sentinel, 'live\n', seen, 'the liveness sentinel');
  } finally {
    fs.rmSync(sentinel, { force: true });
  }
}

async function writeUntilObserved(filePath, contents, observed, label) {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  let firstWrite = true;
  while (Date.now() < deadline) {
    if (firstWrite) {
      fs.writeFileSync(filePath, contents);
      firstWrite = false;
    } else {
      fs.appendFileSync(filePath, contents);
    }
    const landed = await Promise.race([
      observed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), TOUCH_INTERVAL_MS).unref())
    ]);
    if (landed) return;
  }
  throw new Error(`no native file event for ${label} within ${EVENT_TIMEOUT_MS}ms on ${process.platform}`);
}

// os.tmpdir() is an 8.3 short path on the Windows CI runner
// (C:\Users\RUNNER~1\...), and handing one to fs.watch aborts the process
// inside libuv rather than raising anything catchable. Production never watches
// tmp, and canonicalWatchPath() guards the roots it does watch, so canonicalise
// here for the same reason: to exercise native events, not that libuv bug.
function withTmpDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-watch-'));
}

function samePath(left, right) {
  return Boolean(left) && path.resolve(left) === path.resolve(right);
}

// `act` receives a helper that writes the target file and keeps re-touching it
// until its event is observed, so callers never depend on the scan/stream gap.
async function watchAndCollect(dir, act) {
  const events = [];
  const options = watcherOptions(false);
  assert.strictEqual(options.usePolling, false, 'native watcher test must not opt into polling');
  const watcher = chokidar.watch(dir, options);

  function waitForEvent(predicate, description) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        watcher.off('all', onAll);
        watcher.off('error', onError);
      };
      const onAll = (event, filePath) => {
        const entry = { event, filePath };
        events.push(entry);
        if (!predicate(event, filePath)) return;
        cleanup();
        resolve(entry);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no ${description} within ${EVENT_TIMEOUT_MS}ms on ${process.platform}`));
      }, EVENT_TIMEOUT_MS);
      timer.unref();
      watcher.on('all', onAll);
      watcher.on('error', onError);
    });
  }

  try {
    await new Promise((resolve, reject) => {
      watcher.once('ready', resolve);
      watcher.once('error', reject);
    });
    await awaitWatcherLive(watcher, dir);
    const observedFor = (filePath) => new Promise((resolve) => {
      watcher.on('all', (event, seenPath) => {
        if (path.resolve(seenPath) === path.resolve(filePath)) resolve();
      });
    });
    watcher.on('all', (event, filePath) => events.push({ event, filePath }));
    await act({
      writeAndAwait: async (filePath, contents) => {
        await writeUntilObserved(filePath, contents, observedFor(filePath), path.basename(filePath));
      },
      waitForEvent
    });
  } finally {
    await watcher.close();
  }
  return events;
}

test('native file events reach a watcher on this platform', async () => {
  const dir = withTmpDir();
  try {
    const events = await watchAndCollect(dir, async ({ writeAndAwait }) => {
      await writeAndAwait(path.join(dir, 'session.jsonl'), '{"tokens":1}\n');
    });
    assert.ok(
      events.some((entry) => path.basename(entry.filePath) === 'session.jsonl'),
      `expected an event for session.jsonl, got ${JSON.stringify(events)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native file events reach a subdirectory created after the watch started', async () => {
  // The realistic hot path, and the one a per-directory backend can miss:
  // clients write into a fresh project directory (~/.claude/projects/<new>/)
  // that did not exist when the watcher was built. Neither inotify nor
  // ReadDirectoryChangesW recurses on its own, so this only works if chokidar
  // watches the new directory in response to its own addDir event.
  const dir = withTmpDir();
  try {
    const projectDir = path.join(dir, 'a-new-project');
    const sessionPath = path.join(projectDir, 'session.jsonl');
    const events = await watchAndCollect(dir, async ({ waitForEvent }) => {
      // addDir reports discovery, not completion of the child watcher setup.
      // Create the first file synchronously right after mkdir — before the
      // event loop runs — so chokidar's directory scan finds it already
      // present and emits its add event. Waiting for addDir first (then
      // writing) lands in the scan-done/sub-watcher-pending window and loses
      // the add event on platforms with slower watcher setup (Linux/Windows).
      const projectEvent = waitForEvent(
        (event, filePath) => event === 'addDir' && samePath(filePath, projectDir),
        'an addDir event for the new project directory'
      );
      const sessionAddedEvent = waitForEvent(
        (event, filePath) => event === 'add' && samePath(filePath, sessionPath),
        'an add event for session.jsonl inside the new directory'
      );
      fs.mkdirSync(projectDir);
      fs.writeFileSync(sessionPath, '{"tokens":1}\n');
      await projectEvent;
      await sessionAddedEvent;

      const sessionChangedEvent = waitForEvent(
        (event, filePath) => event === 'change' && samePath(filePath, sessionPath),
        'a change event for session.jsonl inside the new directory'
      );
      fs.appendFileSync(sessionPath, '{"tokens":2}\n');
      await sessionChangedEvent;
    });
    assert.ok(
      events.some((entry) => path.basename(entry.filePath) === 'session.jsonl'),
      `expected an event inside the new directory, got ${JSON.stringify(events)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native watcher applies bounded pruning without hiding an overlapping recursive source', async () => {
  const dir = withTmpDir();
  const opencodeRoot = path.join(dir, '.local', 'share', 'opencode');
  const codexRoot = path.join(opencodeRoot, 'sessions');
  const unrelatedRoot = path.join(opencodeRoot, 'log');
  const relevantFile = path.join(codexRoot, 'session.jsonl');
  const unrelatedFile = path.join(unrelatedRoot, 'runtime.log');
  const originalHomedir = os.homedir;
  const previousCodexHome = process.env.CODEX_HOME;
  let watcher;
  os.homedir = () => dir;
  try {
    fs.mkdirSync(codexRoot, { recursive: true });
    fs.mkdirSync(unrelatedRoot, { recursive: true });
    process.env.CODEX_HOME = opencodeRoot;
    const ignored = watchIgnoreMatcher('opencode,codex');
    watcher = chokidar.watch(
      [opencodeRoot, codexRoot],
      watcherOptions(false, ignored)
    );
    await new Promise((resolve, reject) => {
      watcher.once('ready', resolve);
      watcher.once('error', reject);
    });

    // codexRoot, not opencodeRoot: the sentinel has to land where this matcher
    // is not pruning, or proving liveness would need the very delivery it is
    // trying to establish.
    await awaitWatcherLive(watcher, codexRoot);

    const events = [];
    const normalizePath = (filePath) => {
      const resolved = path.resolve(filePath);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const relevantEvent = new Promise((resolve, reject) => {
      const onEvent = (event, filePath) => {
        events.push({ event, filePath });
        if (normalizePath(filePath) === normalizePath(relevantFile)) {
          resolve();
        }
      };
      watcher.on('all', onEvent);
      watcher.once('error', reject);
    });
    // Establishes that this watcher is delivering before anything is concluded
    // from the absence of an event below.
    await writeUntilObserved(relevantFile, '{"tokens":1}\n', relevantEvent, 'the recursive source');

    // The stream is live now, so silence here is pruning rather than the
    // scan/stream gap. Two touches spaced past awaitWriteFinish's window: one
    // write plus a fixed sleep could still be sitting in that window.
    fs.writeFileSync(unrelatedFile, 'noise\n');
    await new Promise((resolve) => setTimeout(resolve, TOUCH_INTERVAL_MS));
    fs.appendFileSync(unrelatedFile, 'more noise\n');
    await new Promise((resolve) => setTimeout(resolve, TOUCH_INTERVAL_MS));
    assert.ok(
      events.some((entry) => normalizePath(entry.filePath) === normalizePath(relevantFile)),
      `expected an event for ${relevantFile}, got ${JSON.stringify(events)}`
    );
    assert.equal(
      events.some((entry) => normalizePath(entry.filePath) === normalizePath(unrelatedFile)),
      false,
      `unexpected event for pruned path ${unrelatedFile}: ${JSON.stringify(events)}`
    );
  } finally {
    if (watcher) await watcher.close();
    os.homedir = originalHomedir;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
