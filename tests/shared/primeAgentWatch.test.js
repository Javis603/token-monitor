'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { clientSourceRoots } = require('../../src/shared/clientSources');
const { watchIgnoreMatcher, openWatch } = require('../../src/shared/collector');
const chokidar = require('chokidar');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-prime-watch-'));
  const artifacts = path.join(home, 'session-artifacts');
  const child = path.join(artifacts, 'root', 'sub-worker');
  fs.mkdirSync(child, { recursive: true });
  for (const dir of ['node_modules/pkg', '.git/objects', 'Library/unrelated', 'project/src']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, 'noise.jsonl'), '{}\n');
  }
  fs.writeFileSync(path.join(home, 'root.jsonl'), '{}\n');
  fs.writeFileSync(path.join(child, 'child.jsonl'), '{}\n');
  const options = { homeDir: home, env: { PRIME_AGENT_SESSION_DIR: '~' } };
  const result = { home, artifacts, child, options };
  t.after(async () => {
    await result.watcher?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return result;
}

test('Prime home override bounds live watching without narrowing scanner roots', (t) => {
  const f = fixture(t);
  const ignored = watchIgnoreMatcher('prime-agent', f.options);
  assert.equal(typeof ignored, 'function');
  assert.deepEqual(clientSourceRoots('prime-agent', f.options)['prime-agent'].map(({ dir }) => dir), [f.home, path.join(path.dirname(f.home), 'session-artifacts')]);
  for (const relative of ['node_modules', '.git', 'Library', 'project', 'README.md', 'rlm-subagents.jsonl']) {
    assert.equal(ignored(path.join(f.home, relative)), true, relative);
  }
  assert.equal(ignored(path.join(f.home, 'root.jsonl')), false);
  assert.equal(ignored(path.join(f.home, 'deleted.jsonl')), false, 'unlink keeps the transcript signal');
});

test('Prime empty setting keeps its nested RLM source and other client roots', (t) => {
  const f = fixture(t);
  const oldCwd = process.cwd();
  fs.mkdirSync(path.join(f.home, '.prime', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.prime', 'agent', 'settings.json'), '{"sessionDir":""}');
  process.chdir(f.home);
  try {
    const options = { homeDir: f.home, env: {} };
    const ignored = watchIgnoreMatcher('prime-agent', options);
    assert.equal(typeof ignored, 'function');
    assert.deepEqual(clientSourceRoots('prime-agent', options)['prime-agent'].map(({ dir }) => dir), [f.home, f.artifacts]);
    for (const relative of ['root', 'root/sub-new', 'root/sub-new/new.jsonl', 'root/sub-worker/child.jsonl']) {
      assert.equal(ignored(path.join(f.artifacts, relative)), false, relative);
    }
    for (const relative of ['root/uploads', 'root/sub-worker/image.png', 'root/sub-worker/node_modules', 'root/sub-worker/deeper/log.jsonl', 'root/rlm-subagents.jsonl']) {
      assert.equal(ignored(path.join(f.artifacts, relative)), true, relative);
    }
    const overlap = watchIgnoreMatcher('prime-agent,codex', { ...options, customScanPaths: { codex: [f.home] } });
    assert.equal(overlap(path.join(f.home, 'project', 'src', 'noise.jsonl')), false, 'another source retains its recursive contract');
  } finally { process.chdir(oldCwd); }
});

for (const usePolling of [false, true]) {
  test(`Prime watcher registers sessions and dynamic RLM children without traversing project trees (${usePolling ? 'polling' : 'native'})`, async (t) => {
    const f = fixture(t);
    const options = { homeDir: f.home, env: { PRIME_AGENT_SESSION_DIR: f.home } };
    const sessions = path.join(f.home, 'project-root');
    const artifacts = path.join(f.home, 'session-artifacts');
    fs.mkdirSync(sessions);
    fs.writeFileSync(path.join(sessions, 'root.jsonl'), '{}\n');
    for (const dir of ['node_modules/pkg', '.git/objects', 'Library/unrelated']) {
      fs.mkdirSync(path.join(sessions, dir), { recursive: true });
      fs.writeFileSync(path.join(sessions, dir, 'noise.jsonl'), '{}\n');
    }
    options.env.PRIME_AGENT_SESSION_DIR = sessions;
    const watcher = openWatch(chokidar, { ...options, clients: 'prime-agent', dirs: [sessions, artifacts], usePolling, pollingEntryLimit: 40 });
    f.watcher = watcher;
    await new Promise((resolve, reject) => { watcher.once('ready', resolve); watcher.once('error', reject); });
    const watched = watcher.getWatched();
    assert.ok(watched[sessions]?.includes('root.jsonl'));
    assert.ok(watched[f.child]?.includes('child.jsonl'));
    assert.equal(Object.keys(watched).some((dir) => dir.includes('node_modules')), false);
    assert.equal(Object.keys(watched).some((dir) => dir.includes('Library')), false);
    // `ready` completes discovery before the native stream necessarily starts.
    // Retry only this disposable startup probe; create the RLM child once below.
    const probe = path.join(sessions, 'root.jsonl');
    await new Promise((resolve, reject) => {
      const retry = setInterval(() => fs.appendFileSync(probe, '{}\n'), 3000);
      const finish = (error) => { clearInterval(retry); clearTimeout(deadline); watcher.off('change', onChange); error ? reject(error) : resolve(); };
      const onChange = (file) => { if (file === probe) finish(); };
      const deadline = setTimeout(() => finish(new Error('root transcript changes were not observed')), 15000);
      watcher.on('change', onChange);
      fs.appendFileSync(probe, '{}\n');
    });
    const newChild = path.join(artifacts, 'new-root', 'sub-new', 'fresh.jsonl');
    const event = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('new RLM transcript was not discovered')), 15000);
      watcher.on('add', (file) => { if (file === newChild) { clearTimeout(deadline); resolve(); } });
      watcher.once('error', (error) => { clearTimeout(deadline); reject(error); });
    });
    fs.mkdirSync(path.dirname(newChild), { recursive: true });
    fs.writeFileSync(newChild, '{}\n');
    await event;
  });
}
