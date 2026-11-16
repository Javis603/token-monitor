'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { clientSourceRoots } = require('../../src/shared/clientSources');
const { watchIgnoreMatcher, watchPathsForClients, openWatch, startCollector } = require('../../src/shared/collector');
const { installSourceEnvGuard, SOURCE_ENV_KEYS } = require('../helpers/sourceEnv');
const { installInProcessWatchHost } = require('../helpers/watchHost');

installSourceEnvGuard(test, [...SOURCE_ENV_KEYS, 'TOKEN_MONITOR_WATCH_POLLING', 'CHOKIDAR_USEPOLLING', 'TOKEN_MONITOR_SHARED_DIR']);
installInProcessWatchHost(test);

function fixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-kiro-watch-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const options = { homeDir: home, env: {} };
  const global = clientSourceRoots('kiro', options).kiro.find(root => root.id === 'kiro-ide-globalstorage').dir;
  const sessions = path.join(home, '.kiro', 'sessions');
  const write = (root, relative) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
    return file;
  };
  fs.mkdirSync(global, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  return { home, options, global, sessions, write };
}

test('Kiro legacy globalStorage remains interval-only while native sessions stay live', t => {
  const f = fixture(t);
  const dirs = watchPathsForClients('kiro', f.options);
  assert.equal(dirs.includes(f.global), false);
  assert.ok(dirs.includes(f.sessions));
});

test('Kiro native sessions keep headers, message streams and discovery but exclude snapshots', t => {
  const f = fixture(t);
  const sources = ['cli/header.json', 'cli/header.jsonl', 'cli/nested/header.json', 'cli/sess_nested/snapshots/header.jsonl',
    'workspace/sess_example/session.json', 'workspace/sess_example/messages.jsonl',
    'workspace/nested/sess_deep/session.json', 'workspace/nested/sess_deep/messages.jsonl'];
  const noise = ['workspace/sess_example/snapshots/commit/src/session.json',
    'workspace/sess_example/snapshots/commit/messages.jsonl', 'workspace/sess_example/runtime.log'];
  for (const name of [...sources, ...noise]) f.write(f.sessions, name);
  const ignored = watchIgnoreMatcher('kiro', f.options);
  for (const name of sources) {
    const file = path.join(f.sessions, name);
    assert.equal(ignored?.(file) ?? false, false, name);
    fs.unlinkSync(file);
    assert.equal(ignored?.(file) ?? false, false, `removed ${name}`);
  }
  for (const name of noise) assert.equal(ignored?.(path.join(f.sessions, name)) ?? false, true, name);
  const fresh = path.join(f.sessions, 'new-workspace', 'sess_new');
  fs.mkdirSync(fresh, { recursive: true });
  for (const dir of [path.dirname(fresh), fresh]) assert.equal(ignored(dir), false);
  assert.equal(ignored(path.join(f.sessions, 'workspace', 'sess_example', 'snapshots')), true);
});

test('Kiro snapshots do not consume the polling admission budget', t => {
  const f = fixture(t);
  f.write(f.sessions, 'workspace/sess_one/session.json');
  for (let i = 0; i < 30; i++) f.write(f.sessions, `workspace/sess_one/snapshots/commit/tree-${i}/messages.jsonl`);
  assert.doesNotThrow(() => openWatch({ watch: () => ({}) }, {
    ...f.options, dirs: [f.sessions], clients: 'kiro', usePolling: true, pollingEntryLimit: 6
  }));
});

test('Kiro native discovery rejects directory symlinks while retaining transcript links', t => {
  if (process.platform === 'win32') return t.skip('creating file symlinks requires Windows privileges');
  const f = fixture(t);
  const target = f.write(f.home, 'external/messages.jsonl');
  const session = path.join(f.sessions, 'workspace', 'sess_one');
  fs.mkdirSync(session, { recursive: true });
  const messageLink = path.join(session, 'messages.jsonl');
  fs.symlinkSync(target, messageLink);
  const directoryLink = path.join(f.sessions, 'linked-workspace');
  fs.symlinkSync(path.dirname(session), directoryLink, 'dir');
  const cliLink = path.join(f.sessions, 'cli');
  fs.symlinkSync(path.dirname(target), cliLink, 'dir');
  const sessionLink = path.join(session, 'session.json');
  fs.symlinkSync(path.dirname(target), sessionLink, 'dir');
  const ignored = watchIgnoreMatcher('kiro', f.options);
  assert.equal(ignored(messageLink), false);
  assert.equal(ignored(directoryLink), true);
  assert.equal(ignored(cliLink), false, 'Tokscale follows the separate CLI scan-root link');
  const nestedCliLink = path.join(cliLink, 'history.jsonl');
  fs.symlinkSync(path.dirname(session), nestedCliLink, 'dir');
  assert.equal(ignored(nestedCliLink), true, 'CLI scan-root links do not admit nested directory links');
  assert.equal(ignored(sessionLink), true, 'a source filename cannot admit a directory link');
  fs.unlinkSync(messageLink);
  assert.equal(ignored(messageLink), false, 'source unlink remains observable');
});

test('explicit custom Kiro roots retain recursive discovery outside the built-in layout', t => {
  const f = fixture(t);
  const custom = path.join(f.home, 'custom');
  const file = f.write(custom, 'nonstandard/nested/chat.json');
  const ignored = watchIgnoreMatcher('kiro', { ...f.options, customScanPaths: { kiro: [custom] } });
  assert.equal(ignored?.(file) ?? false, false);
});

test('an untracked Copilot exporter cannot weaken the Kiro source policy', t => {
  const f = fixture(t);
  const exporter = f.write(f.sessions, 'workspace/sess_one/copilot.jsonl');
  process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = exporter;
  t.mock.method(os, 'homedir', () => f.home);
  assert.equal(watchIgnoreMatcher('kiro', { homeDir: f.home })(exporter), true);
  assert.equal(watchIgnoreMatcher('kiro,copilot', { homeDir: f.home })(exporter), false);
});

test('an overlapping Copilot exporter does not request an unrelated Kiro scan', async t => {
  const f = fixture(t);
  const exporter = f.write(f.sessions, 'workspace/sess_one/copilot.jsonl');
  const messages = f.write(f.sessions, 'workspace/sess_one/messages.jsonl');
  process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = exporter;
  process.env.TOKEN_MONITOR_SHARED_DIR = f.home;
  t.mock.method(os, 'homedir', () => f.home);
  const globalIgnore = watchIgnoreMatcher('kiro,copilot', { homeDir: f.home });
  assert.equal(globalIgnore(exporter), false, 'the exporter must survive the global policy union');
  const chokidar = require('chokidar');
  let onEvent;
  t.mock.method(chokidar, 'watch', () => {
    const watcher = { on(event, handler) { if (event === 'all') onEvent = handler; return watcher; }, close() {} };
    return watcher;
  });
  const scans = [];
  const runtime = startCollector({
    clients: 'kiro,copilot', homeDir: f.home, allTimeSince: '2024-01-01',
    deviceId: 'kiro-overlap-test', agentVersion: 'test', intervalMs: 3600000,
    watchEnabled: true, watchDebounceMs: 10, historyEnabled: false,
    dailyHistoryArchiveEnabled: false, anchorPersistenceEnabled: false,
    projectsEnabled: false, wslScanEnabled: false, sessionActivityPolling: false,
    async runTokscale(input) {
      scans.push(input.clients);
      return { entries: ['kiro', 'copilot'].filter(client => input.clients.split(',').includes(client))
        .map(client => ({ client, model: 'test-model', input: 1, output: 1 })) };
    }
  });
  t.after(async () => { runtime.stop(); await runtime.whenIdle(); });
  await runtime.whenIdle();
  assert.equal(scans.length, 3);
  onEvent('change', exporter);
  await delay(40); await runtime.whenIdle();
  assert.deepEqual(scans.slice(3), ['copilot']);
  onEvent('change', messages);
  await delay(40); await runtime.whenIdle();
  assert.deepEqual(scans.slice(3), ['copilot', 'kiro']);
});
