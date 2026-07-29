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

const { watcherOptions } = require('../../src/shared/collector');

// awaitWriteFinish holds an event for stabilityThreshold (500 ms) before it is
// emitted, so the floor is already half a second before any scheduling noise.
const EVENT_TIMEOUT_MS = 20 * 1000;

// os.tmpdir() is an 8.3 short path on the Windows CI runner
// (C:\Users\RUNNER~1\...), and handing one to fs.watch aborts the process
// inside libuv rather than raising anything catchable. Production never watches
// tmp, and canonicalWatchPath() guards the roots it does watch, so canonicalise
// here for the same reason: to exercise native events, not that libuv bug.
function withTmpDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-watch-'));
}

async function watchAndCollect(dir, act) {
  const events = [];
  const watcher = chokidar.watch(dir, watcherOptions(false));
  try {
    await new Promise((resolve, reject) => {
      watcher.once('ready', resolve);
      watcher.once('error', reject);
    });
    const seen = new Promise((resolve) => {
      watcher.on('all', (event, filePath) => {
        events.push({ event, filePath });
        resolve();
      });
    });
    await act();
    await Promise.race([
      seen,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`no native file event within ${EVENT_TIMEOUT_MS}ms on ${process.platform}`)),
        EVENT_TIMEOUT_MS
      ).unref())
    ]);
  } finally {
    await watcher.close();
  }
  return events;
}

test('native file events reach a watcher on this platform', async () => {
  const dir = withTmpDir();
  try {
    const events = await watchAndCollect(dir, async () => {
      fs.writeFileSync(path.join(dir, 'session.jsonl'), '{"tokens":1}\n');
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
    const events = await watchAndCollect(dir, async () => {
      fs.mkdirSync(projectDir);
      // Give chokidar a moment to watch the directory it just discovered,
      // otherwise the write races the addDir handler and the assertion would
      // pass on the mkdir event alone.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      fs.writeFileSync(path.join(projectDir, 'session.jsonl'), '{"tokens":1}\n');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });
    assert.ok(
      events.some((entry) => path.basename(entry.filePath) === 'session.jsonl'),
      `expected an event inside the new directory, got ${JSON.stringify(events)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
