'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chokidar = require('chokidar');
const { openWatch, watchIgnoreMatcher } = require('../../src/shared/collector');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

installSourceEnvGuard(test);

function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-desktop-watch-'));
  const root = path.join(home, 'Library/Application Support/Claude/local-agent-mode-sessions');
  const lane = path.join(root, 'account/session/.claude/projects');
  fs.mkdirSync(lane, { recursive: true });
  // Seed the startup probe before discovery so polling registers the file,
  // even if its first directory stat would swallow a post-ready creation.
  fs.writeFileSync(path.join(lane, 'watch-live.jsonl'), '{}\n');
  const result = { home, root, lane, options: { homeDir: home, env: {} } };
  t.after(async () => {
    await result.watcher?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return result;
}

test('Desktop pruning keeps dynamic ancestors and transcript removal without following unrelated trees', (t) => {
  const f = fixture(t);
  const ignored = watchIgnoreMatcher('claude', f.options);
  const blocked = [
    'runtime/node_modules/pkg/dist', 'runtime/.git/objects', 'runtime/.venv/lib',
    'account/session/.claude/settings.json', 'account/session/.claude/projects/a/log.txt'
  ];
  for (const relative of blocked) {
    const file = path.join(f.root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
    assert.equal(ignored(file), true, relative);
  }
  for (const relative of ['new-account', 'new-account/new-session', 'new-account/new-session/.claude',
    'new-account/new-session/.claude/transcripts', 'account/session/.claude/projects/a/deleted.jsonl']) {
    assert.equal(ignored(path.join(f.root, relative)), false, relative);
  }
  // A recursive source on the same root retains the source-policy union.
  const overlap = watchIgnoreMatcher('claude,codex', { ...f.options, customScanPaths: { codex: [f.root] } });
  const file = path.join(f.lane, 'log.txt'); fs.writeFileSync(file, 'fixture');
  assert.equal(overlap(file), false);
});

test('Desktop links follow discovery, explicit scan-root and file boundaries', (t) => {
  const f = fixture(t);
  const outside = path.join(f.home, 'outside');
  const targetLane = path.join(outside, '.claude/projects');
  fs.mkdirSync(targetLane, { recursive: true });
  const targetFile = path.join(targetLane, 'usage.jsonl'); fs.writeFileSync(targetFile, '{}\n');
  try {
    fs.symlinkSync(outside, path.join(f.root, 'linked'), 'dir');
    fs.mkdirSync(path.join(f.root, 'linked-claude'), { recursive: true });
    fs.symlinkSync(path.dirname(targetLane), path.join(f.root, 'linked-claude/.claude'), 'dir');
    fs.symlinkSync(targetLane, path.join(f.lane, 'directory-link'), 'dir');
    fs.symlinkSync(targetLane, path.join(path.dirname(f.lane), 'transcripts'), 'dir');
    fs.symlinkSync(targetFile, path.join(f.lane, 'file-link.jsonl'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable');
    throw error;
  }
  const ignored = watchIgnoreMatcher('claude', f.options);
  for (const relative of ['linked', 'linked/.claude/projects/usage.jsonl', 'linked-claude/.claude',
    'linked-claude/.claude/projects/usage.jsonl', 'account/session/.claude/projects/directory-link',
    'account/session/.claude/projects/directory-link/usage.jsonl']) {
    assert.equal(ignored(path.join(f.root, relative)), true, relative);
  }
  assert.equal(ignored(path.join(path.dirname(f.lane), 'transcripts/usage.jsonl')), false);
  assert.equal(ignored(path.join(f.lane, 'file-link.jsonl')), false);
  fs.unlinkSync(targetFile);
  assert.equal(ignored(path.join(f.lane, 'file-link.jsonl')), false, 'a dangling file link retains removal events');
  fs.rmSync(targetLane, { recursive: true });
  assert.equal(ignored(path.join(path.dirname(f.lane), 'transcripts')), false, 'a dangling lane retains removal events');
  assert.equal(ignored(path.join(path.dirname(f.lane), 'transcripts/usage.jsonl')), false);
  fs.unlinkSync(path.join(f.lane, 'file-link.jsonl'));
  assert.equal(ignored(path.join(f.lane, 'file-link.jsonl')), false, 'unlink still requests a scan');
});

async function waitForEvent(watcher, file, action, expectedEvent = null) {
  // Once the stream is live, mutate once and require the exact event/path.
  await new Promise((resolve, reject) => {
    const observed = [];
    const cleanup = () => {
      clearTimeout(timer);
      watcher.off('all', listener);
      watcher.off('error', onError);
    };
    const listener = (event, candidate) => {
      observed.push(`${event}:${path.basename(candidate)}`);
      if (path.resolve(candidate) === file && (!expectedEvent || event === expectedEvent)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`missing native/polling ${expectedEvent || 'event'}: ${path.basename(file)}; observed: ${observed.join(', ') || 'none'}`));
    }, 30_000);
    watcher.on('all', listener);
    watcher.on('error', onError);
    try { action(); } catch (error) { onError(error); }
  });
}

async function awaitWatcherLive(watcher, lane) {
  // As in watcherNativeEvents.test.js, ready completes the initial scan, not
  // necessarily native-stream startup. Prove delivery before testing a one-off
  // creation/removal; retries belong only to this disposable startup probe.
  const sentinel = path.join(lane, 'watch-live.jsonl');
  assert.equal(watcher.getWatched()[lane]?.includes(path.basename(sentinel)), true,
    'the startup probe must be registered by initial discovery');
  const touch = () => fs.appendFileSync(sentinel, '{}\n');
  const retry = setInterval(touch, 3000);
  try {
    await waitForEvent(watcher, sentinel, touch);
  } finally {
    clearInterval(retry);
    fs.rmSync(sentinel, { force: true });
  }
}

for (const usePolling of [false, true]) {
  test(`Desktop watches permitted links and their removals (${usePolling ? 'polling' : 'native'})`, async (t) => {
    const f = fixture(t);
    const outside = path.join(f.home, 'outside');
    const fileTarget = path.join(outside, 'file.jsonl');
    const laneTarget = path.join(outside, 'lane');
    const laneFile = path.join(laneTarget, 'usage.jsonl');
    const fileLink = path.join(f.lane, 'file-link.jsonl');
    const laneLink = path.join(path.dirname(f.lane), 'transcripts');
    fs.mkdirSync(laneTarget, { recursive: true });
    fs.writeFileSync(fileTarget, '{}\n'); fs.writeFileSync(laneFile, '{}\n');
    try {
      fs.symlinkSync(fileTarget, fileLink, 'file');
      fs.symlinkSync(laneTarget, laneLink, 'dir');
    } catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable');
      throw error;
    }
    const watcher = openWatch(chokidar, { ...f.options, clients: 'claude', dirs: [f.root], usePolling });
    f.watcher = watcher;
    await new Promise((resolve, reject) => { watcher.once('ready', resolve); watcher.once('error', reject); });
    await awaitWatcherLive(watcher, f.lane);
    // Windows native fs.watch watches the file link's parent, not its external
    // target. An unfiltered control has the same limit; polling follows target
    // stats. Keep native link registration/removal and lane-target assertions.
    const followsFileTarget = process.platform !== 'win32' || usePolling;
    if (followsFileTarget) {
      await waitForEvent(watcher, fileLink, () => fs.appendFileSync(fileTarget, '{}\n'));
    } else {
      assert.equal(watcher.getWatched()[f.lane]?.includes(path.basename(fileLink)), true,
        'the permitted file link must remain registered');
    }
    await waitForEvent(watcher, path.join(laneLink, 'usage.jsonl'), () => fs.appendFileSync(laneFile, '{}\n'));
    await waitForEvent(watcher, fileLink, () => {
      fs.unlinkSync(followsFileTarget ? fileTarget : fileLink);
    }, 'unlink');
    await waitForEvent(watcher, path.join(laneLink, 'usage.jsonl'), () => {
      if (followsFileTarget) fs.rmSync(laneTarget, { recursive: true, force: true });
      else fs.unlinkSync(laneFile);
    }, 'unlink');
    if (!followsFileTarget) {
      // A Windows directory watch sees child deletion while the target exists;
      // deleting the watched target directory itself can close the OS handle.
      await waitForEvent(watcher, laneLink, () => fs.unlinkSync(laneLink), 'unlinkDir');
    }
  });

  test(`Desktop discovers sessions created after startup (${usePolling ? 'polling' : 'native'})`, async (t) => {
    const f = fixture(t);
    const dependencies = path.join(f.root, 'runtime/node_modules/pkg/dist');
    fs.mkdirSync(dependencies, { recursive: true });
    const watcher = openWatch(chokidar, { ...f.options, clients: 'claude', dirs: [f.root], usePolling });
    f.watcher = watcher;
    const events = [];
    watcher.on('all', (_event, file) => events.push(file));
    await new Promise((resolve, reject) => { watcher.once('ready', resolve); watcher.once('error', reject); });
    await awaitWatcherLive(watcher, f.lane);
    const existing = path.join(f.lane, 'existing.jsonl');
    await waitForEvent(watcher, existing, () => fs.appendFileSync(existing, '{}\n'));
    const fresh = path.join(f.root, 'new-account/new-session/.claude/transcripts/fresh.jsonl');
    fs.mkdirSync(path.dirname(fresh), { recursive: true });
    await waitForEvent(watcher, fresh, () => fs.appendFileSync(fresh, '{}\n'));
    fs.mkdirSync(path.join(dependencies, 'new'), { recursive: true });
    fs.writeFileSync(path.join(dependencies, 'new/unrelated.jsonl'), '{}\n');
    await new Promise(resolve => setTimeout(resolve, usePolling ? 2500 : 1000));
    assert.equal(events.some(file => file.includes(`${path.sep}node_modules${path.sep}`)), false);
    assert.equal(Object.keys(watcher.getWatched()).some(dir => dir.includes(`${path.sep}node_modules`)), false);
    await waitForEvent(watcher, fresh, () => { if (fs.existsSync(fresh)) fs.unlinkSync(fresh); });
  });
}
