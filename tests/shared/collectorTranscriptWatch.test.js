'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { watchIgnoreMatcher, startCollector } = require('../../src/shared/collector');
const { installSourceEnvGuard, SOURCE_ENV_KEYS } = require('../helpers/sourceEnv');
const { installInProcessWatchHost } = require('../helpers/watchHost');

installSourceEnvGuard(test, [...SOURCE_ENV_KEYS, 'DSH_HOME', 'TOKEN_MONITOR_SHARED_DIR']);
installInProcessWatchHost(test);

const CASES = [
  { client: 'kilo', root: '.local/share/kilo',
    keep: ['kilo.db', 'kilo.db-wal', 'kilo.db-shm'],
    drop: ['runtime.log', 'cache/nested/blob', 'nested/kilo.db'], direct: true },
  { client: 'kilo', root: '.config/Code/User/globalStorage/kilocode.kilo-code/tasks',
    keep: ['task/ui_messages.json', 'nested/task/ui_messages.json', 'task/api_conversation_history.json'],
    drop: ['task/runtime.log', 'task/checkpoint.git/objects/pack/file.pack'] },
  { client: 'cline', root: '.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks',
    keep: ['task/ui_messages.json', 'nested/task/ui_messages.json', 'task/api_conversation_history.json'],
    drop: ['task/runtime.log', 'task/screenshot.png'] },
  { client: 'cline', root: '.cline/data/sessions',
    keep: ['session.messages.json', 'nested/session.messages.json', 'session.json', 'nested/session.json'],
    drop: ['session.lock', 'runtime.log'] },
  { client: 'claude', root: '.claude/projects',
    keep: ['project/session.jsonl', 'project/session/subagents/agent.jsonl',
      'project/session/subagents/agent-one.meta.json', 'project/session.meta.json'],
    drop: ['project/tool-output.txt', 'project/image.png', 'project/notes.md', 'project/settings.json'] },
  { client: 'claude', root: '.claude/transcripts',
    keep: ['nested/session.jsonl', 'nested/agent-one.meta.json'], drop: ['nested/runtime.log', 'nested/settings.json'] },
  { client: 'gemini', root: '.gemini/tmp',
    keep: ['project/chats/session.json', 'nested/session.jsonl'],
    drop: ['project/runtime.log', 'project/image.png'] },
  { client: 'dsh', root: '.dsh/sessions',
    keep: ['project/s/session.jsonl', 'project/s/session.jsonl.zstd',
      'project/s/session.v3.jsonl.zstd', 'nested/session.v42.jsonl'],
    drop: ['project/s/session.lock', 'runtime.db-shm', 'session.vnext.jsonl', 'session.v3.jsonl.zstd.tmp'] },
  { client: 'grok', root: '.grok/sessions',
    keep: ['project/s/updates.jsonl', 'project/s/summary.json', 'project/s/signals.json', 'project/s/events.jsonl'],
    drop: ['project/s/history.sqlite', 'project/s/lock', 'project/s/chat_history.jsonl'] }
];

for (const entry of CASES) {
  test(`${entry.client} ${entry.root} ignores non-source writes while retaining discovery and source deletion`, (t) => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-source-watch-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const root = path.join(home, entry.root);
    for (const name of [...entry.keep, ...entry.drop]) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'fixture');
    }
    const ignored = watchIgnoreMatcher(entry.client, { homeDir: home, env: {} });
    for (const name of entry.keep) assert.equal(ignored?.(path.join(root, name)) ?? false, false, name);
    for (const name of entry.drop) assert.equal(ignored?.(path.join(root, name)) ?? false, true, name);
    const discovered = path.join(root, 'new-project', 'new-session');
    fs.mkdirSync(discovered, { recursive: true });
    assert.equal(ignored(root), false);
    assert.equal(ignored(discovered), Boolean(entry.direct));
    for (const name of entry.keep) {
      const file = path.join(root, name);
      fs.unlinkSync(file);
      assert.equal(ignored(file), false, `deleted source ${name}`);
    }
  });
}

test('source file policies preserve symlinked transcripts and recursive custom/overlapping roots', (t) => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-source-overlap-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.local/share/kilo');
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  const noise = path.join(nested, 'runtime.log');
  fs.writeFileSync(noise, 'fixture');
  const ownCustom = watchIgnoreMatcher('kilo', { homeDir: home, env: {}, customScanPaths: { kilo: [root] } });
  assert.equal(ownCustom?.(noise) ?? false, false);
  const overlapping = watchIgnoreMatcher('kilo,pi', { homeDir: home, env: {}, customScanPaths: { pi: [root] } });
  assert.equal(overlapping?.(noise) ?? false, false);
  if (process.platform !== 'win32') {
    const source = path.join(home, '.claude/projects/project/session.jsonl');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.symlinkSync(noise, source);
    const ignored = watchIgnoreMatcher('claude', { homeDir: home, env: {} });
    assert.equal(ignored?.(source) ?? false, false);
    const directoryLink = path.join(path.dirname(source), 'linked-history');
    fs.symlinkSync(nested, directoryLink, 'dir');
    assert.equal(ignored(directoryLink), true, 'the scanner does not recurse through directory symlinks');
    for (const name of ['linked-history.jsonl', 'agent-linked.meta.json']) {
      const sourceNamedDirectoryLink = path.join(path.dirname(source), name);
      fs.symlinkSync(nested, sourceNamedDirectoryLink, 'dir');
      assert.equal(ignored(sourceNamedDirectoryLink), true, 'a source filename cannot admit a directory link');
    }
  }
});

for (const entry of [
  { client: 'grok', root: '.grok/sessions/project/session', source: 'updates.jsonl', sidecar: 'signals.json',
    field: 'totalTokens', before: 100, after: 200 },
  { client: 'grok', root: '.grok/sessions/project/session', source: 'updates.jsonl', sidecar: 'events.jsonl',
    field: 'model_id', before: 'model-one', after: 'model-two' },
  { client: 'claude', root: '.claude/projects/project/session/subagents', source: 'agent-one.jsonl', sidecar: 'agent-one.meta.json',
    field: 'agentType', before: 'explorer', after: 'reviewer' }
]) {
  test(`${entry.client} refreshes when only ${entry.sidecar} changes`, async (t) => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sidecar-watch-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    process.env.TOKEN_MONITOR_SHARED_DIR = home;
    t.mock.method(os, 'homedir', () => home);
    const root = path.join(home, entry.root);
    fs.mkdirSync(root, { recursive: true });
    const source = path.join(root, entry.source);
    const sidecar = path.join(root, entry.sidecar);
    fs.writeFileSync(source, 'unchanged transcript\n');
    fs.writeFileSync(sidecar, JSON.stringify({ [entry.field]: entry.before }));
    const sourceStat = fs.statSync(source);
    let onEvent, watchIgnored;
    t.mock.method(require('chokidar'), 'watch', (_dirs, config) => {
      watchIgnored = config.ignored;
      const watcher = { on(event, handler) { if (event === 'all') onEvent = handler; return watcher; }, close() {} };
      return watcher;
    });
    const scans = [], values = [], updates = [];
    const runtime = startCollector({
      clients: entry.client, homeDir: home, allTimeSince: '2024-01-01',
      deviceId: 'sidecar-watch-test', agentVersion: 'test', intervalMs: 3600000,
      watchEnabled: true, watchDebounceMs: 10, historyEnabled: false,
      dailyHistoryArchiveEnabled: false, anchorPersistenceEnabled: false,
      projectsEnabled: false, wslScanEnabled: false, sessionActivityPolling: false,
      async runTokscale(input) {
        scans.push(input.clients);
        const value = JSON.parse(fs.readFileSync(sidecar, 'utf8'))[entry.field];
        values.push(value);
        return { entries: [{ client: entry.client,
          model: entry.field === 'model_id' ? value : 'test-model',
          input: entry.field === 'totalTokens' ? value : 100, output: 0 }] };
      },
      onUpdate(summary) { updates.push(summary); }
    });
    t.after(async () => { runtime.stop(); await runtime.whenIdle(); });
    await runtime.whenIdle();
    assert.equal(scans.length, 3);
    assert.equal(values.at(-1), entry.before);
    fs.writeFileSync(sidecar, JSON.stringify({ [entry.field]: entry.after }));
    if (!watchIgnored?.(sidecar)) onEvent('change', sidecar);
    await delay(40); await runtime.whenIdle();
    assert.deepEqual(scans.slice(3), [entry.client]);
    assert.equal(values.at(-1), entry.after);
    if (entry.field === 'totalTokens') assert.equal(updates.at(-1).today.totalTokens, 200);
    assert.equal(fs.statSync(source).mtimeMs, sourceStat.mtimeMs);
    assert.equal(fs.statSync(source).size, sourceStat.size);
  });
}
