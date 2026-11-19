'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { activityWatchSources, activityClientsForPath, activityWatchIgnored } = require('../../src/shared/sessionActivityWatch');

test('activity watches prune unrelated data and SQLite shm while retaining WAL, runtime and new directories', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-watch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.t3'));
  const sources = activityWatchSources(['claude', 'codex'], { homeDir: home, env: {} });
  const ignored = activityWatchIgnored(undefined, [], sources);
  const file = (relative) => path.join(home, relative);
  for (const relative of ['.claude/sessions', '.claude/sessions/123.json', '.t3/userdata', '.t3/userdata/statev2.sqlite-wal', '.t3/userdata/server-runtime.json', '.t3/dev/userdata/statev2.sqlite']) {
    assert.equal(ignored(file(relative)), false, relative);
    assert.ok(activityClientsForPath(file(relative), sources).length, relative);
  }
  for (const relative of ['.claude/settings.json', '.claude/projects/old.jsonl', '.claude/sessions/auth.json', '.claude/sessions/123.json/deep', '.t3/userdata/statev2.sqlite-shm', '.t3/scratch/deep', '.t3/userdata/attachments/private.png']) {
    assert.equal(ignored(file(relative)), true, relative);
    assert.deepEqual(activityClientsForPath(file(relative), sources), [], relative);
  }
  const shared = activityWatchIgnored(undefined, [file('.claude/projects')], sources);
  assert.equal(shared(file('.claude/projects/old.jsonl')), false);
});

test('absent installations never broaden the watch to the home and scoped homes do not use host state', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-watch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(activityWatchSources(['claude', 'codex'], { homeDir: home, env: {} }), []);
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  assert.deepEqual(activityWatchSources(['claude'], { homeDir: home, env: {}, scopedHome: true }), []);
  const custom = path.join(home, 'custom'); fs.mkdirSync(custom);
  const sources = activityWatchSources(['claude'], { homeDir: home, env: { CLAUDE_CONFIG_DIR: custom }, t3DbPaths: [] });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].dir, custom);
  assert.equal(sources[0].target, path.join(custom, 'sessions'));
});

test('activity allowlists preserve usage pruning and directory boundaries', () => {
  const root = path.resolve(os.tmpdir(), 'activity-boundaries');
  const file = (relative) => path.join(root, relative);
  const calls = [];
  const usageIgnored = (value) => { calls.push(value); return value.endsWith('.tmp'); };
  const sources = [
    { dir: file('claude'), target: file('claude/sessions'), kind: 'pid-registry' },
    { dir: file('t3'), target: file('t3/userdata/statev2.sqlite'), kind: 'sqlite' }
  ];
  const ignored = activityWatchIgnored(usageIgnored, [file('claude/projects'), file('t3/usage')], sources);
  for (const relative of ['claude/sessions/123.json', 't3/userdata', 't3/userdata/statev2.sqlite-wal']) {
    assert.equal(ignored(file(relative)), false, relative);
  }
  for (const relative of ['claude/sessions/123.JSON', 'claude/sessions/123.json/child',
    'claude/projects-other/log.jsonl', 't3/usage-other/log.jsonl', 't3/userdata/statev2.sqlite-shm']) {
    assert.equal(ignored(file(relative)), relative === 'claude/sessions/123.JSON' ? path.sep !== '\\' : true, relative);
  }
  assert.deepEqual(calls, [], 'activity-only paths never consult usage policy');
  for (const relative of ['claude/projects/log.jsonl', 't3/usage/log.jsonl', 't3-other/log.jsonl']) {
    assert.equal(ignored(file(relative)), false, relative);
  }
  assert.equal(ignored(file('claude/projects/log.tmp')), true);
  assert.equal(calls.length, 4, 'usage and unrelated paths retain the existing policy');
  assert.equal(activityWatchIgnored(usageIgnored, [], []), usageIgnored);
});

test('Windows activity allowlists and event attribution accept mixed case without broadening sources', () => {
  const filename = require.resolve('../../src/shared/sessionActivityWatch');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: (id) => id === 'node:path' ? path.win32 : localRequire(id)
  }, { filename });
  const api = module.exports;
  const file = (relative) => path.win32.join('C:\\Users\\MixedCase', relative);
  const sources = [
    { dir: file('Claude'), target: file('Claude/Sessions'), kind: 'pid-registry', clients: ['claude'] },
    { dir: file('T3'), target: file('T3/Userdata/StateV2.sqlite'), kind: 'sqlite',
      runtimeFile: file('T3/Userdata/Server-Runtime.json'), clients: ['claude', 'codex'] }
  ];
  const ignored = api.activityWatchIgnored(() => true, [], sources);
  for (const relative of ['Claude/Sessions', 'Claude/Sessions/123.json', 'T3/Userdata',
    'T3/Userdata/StateV2.sqlite', 'T3/Userdata/StateV2.sqlite-wal', 'T3/Userdata/Server-Runtime.json']) {
    for (const event of [file(relative).toLowerCase(), file(relative).toUpperCase()]) {
      assert.equal(ignored(event), false, event);
      const expected = relative.startsWith('Claude') ? ['claude'] : ['claude', 'codex'];
      assert.deepEqual([...api.activityClientsForPath(event, sources)], expected, event);
    }
  }
  for (const relative of ['Claude/Sessions/auth.json', 'Claude/Sessions/123.json/child',
    'Claude/Sessions-other/123.json', 'T3/Userdata/StateV2.sqlite-shm', 'T3/Userdata/StateV2.sqlite-wal/child']) {
    const event = file(relative).toUpperCase();
    assert.equal(ignored(event), true, event);
    assert.deepEqual([...api.activityClientsForPath(event, sources)], [], event);
  }
});
