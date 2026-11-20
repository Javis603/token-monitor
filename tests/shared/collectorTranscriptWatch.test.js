'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { watchIgnoreMatcher, startCollector } = require('../../src/shared/collector');
const { copilotExporterWatch } = require('../../src/shared/clientSources');
const { clientsForWatchPath, openWatch, watchAttributionRootsForClients, watchPathsForClients } = require('../../src/shared/watchPolicy');
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

test('a nested Codex home owns its catalog inside an enclosing custom root', (t) => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-codex-nested-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const imports = path.join(home, 'imports');
  const one = path.join(imports, 'one');
  for (const name of ['sqlite/state_5.sqlite', 'sessions/rollout.jsonl']) {
    const file = path.join(one, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  fs.mkdirSync(imports, { recursive: true });
  fs.writeFileSync(path.join(imports, 'other.jsonl'), 'fixture');
  const ignored = watchIgnoreMatcher('codex', {
    homeDir: home, env: {}, customScanPaths: { codex: [imports, one] }
  });
  assert.equal(ignored(path.join(one, 'sqlite', 'state_5.sqlite-shm')), true, 'a catalog sidecar is not a source');
  assert.equal(ignored(path.join(one, 'sqlite', 'state_5.sqlite-wal')), true);
  assert.equal(ignored(path.join(one, 'sessions', 'rollout.jsonl')), false);
  assert.equal(ignored(path.join(imports, 'other.jsonl')), false);
  assert.equal(ignored(path.join(imports, 'node_modules', 'pkg', 'index.js')), true);
});

test('Codex watch setup uses its captured home classification across matchers', (t) => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-codex-watch-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const catalog = path.join(home, 'state_5.sqlite');
  const rollout = path.join(home, 'imports', 'rollout.jsonl');
  fs.mkdirSync(catalog);
  fs.mkdirSync(path.dirname(rollout));
  fs.writeFileSync(rollout, 'fixture');
  const options = { homeDir: home, env: {}, customScanPaths: { codex: [home] } };
  assert.equal(watchIgnoreMatcher('codex', options)(rollout), false);
  fs.rmdirSync(catalog);
  fs.writeFileSync(catalog, 'fixture');
  assert.equal(watchIgnoreMatcher('codex', options)(rollout), true);

  const captured = { ...options, codexHomes: [] };
  assert.equal(watchIgnoreMatcher('codex', captured)(rollout), false);
  openWatch({ watch(_dirs, { ignored }) {
    assert.equal(ignored(rollout), false);
  } }, { ...captured, clients: 'codex', dirs: [home] });
});

test('Reasonix watches the configured state directory in the watcher worker', (t) => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-reasonix-watch-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'reasonix-state');
  const sessions = path.join(state, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const options = { homeDir: home, env: { REASONIX_STATE_HOME: state } };
  assert.ok(watchPathsForClients('reasonix', options).includes(sessions));
  openWatch({ watch(_dirs, { ignored }) {
    assert.equal(ignored(path.join(sessions, 'session.jsonl.meta')), false);
    assert.equal(ignored(path.join(sessions, 'unrelated.data')), true);
  } }, { ...options, clients: 'reasonix', dirs: [sessions] });
});

test('a Copilot exporter parent named like a workspace root keeps only the exporter file', (t) => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-copilot-exporter-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const exporterDir = path.join(home, 'workspaceStorage');
  const exporter = path.join(exporterDir, 'export.jsonl');
  fs.mkdirSync(path.join(exporterDir, 'project'), { recursive: true });
  fs.writeFileSync(exporter, 'fixture');
  fs.writeFileSync(path.join(exporterDir, 'project', 'workspace.json'), 'fixture');
  fs.writeFileSync(path.join(exporterDir, 'other.txt'), 'fixture');
  const previous = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = exporter;
  t.after(() => {
    if (previous === undefined) delete process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
    else process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = previous;
  });
  const ignored = watchIgnoreMatcher('copilot', { homeDir: home, env: process.env });
  assert.equal(ignored(exporter) ?? false, false);
  assert.equal(ignored(path.join(exporterDir, 'project', 'workspace.json')), true);
  assert.equal(ignored(path.join(exporterDir, 'other.txt')), true);
});

for (const [configuredName, actualName] of [['EXPORT.JSONL', 'export.jsonl'], ['Σ.jsonl', 'ς.jsonl']]) {
  test(`a late Copilot exporter follows the volume’s case rules for ${configuredName}`, (t) => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-copilot-case-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const dir = path.join(home, 'workspaceStorage');
    const file = path.join(dir, actualName);
    const configured = path.join(dir, configuredName);
    fs.mkdirSync(dir);
    t.mock.method(os, 'homedir', () => home);
    process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = configured;
    const options = { homeDir: home };
    const exporter = copilotExporterWatch(home);
    const attribution = watchAttributionRootsForClients('copilot', null, options);
    const ignored = watchIgnoreMatcher('copilot', options);

    // The file appears after both watch filtering and attribution are built.
    fs.writeFileSync(file, 'initial');
    if (!fs.existsSync(configured)) {
      assert.equal(ignored(file), true);
      assert.deepEqual(clientsForWatchPath(file, attribution, { copilot: ignored }, exporter), []);
      fs.writeFileSync(configured, 'distinct file');
      assert.equal(ignored(file), true);
    } else {
      assert.equal(ignored(file), false);
      assert.deepEqual(clientsForWatchPath(file, attribution, { copilot: ignored }, exporter), ['copilot']);
      fs.unlinkSync(file);
      assert.equal(ignored(file), false);
      assert.deepEqual(clientsForWatchPath(file, attribution, { copilot: ignored }, exporter), ['copilot']);
    }
    fs.writeFileSync(configured, 'export');
    const otherLink = path.join(dir, 'other-link.jsonl');
    fs.linkSync(configured, otherLink);
    assert.equal(ignored(otherLink), true);
  });
}

test('a volume root matches its descendants in watch attribution', () => {
  const volumeRoot = path.parse(process.cwd()).root;
  const target = path.join(volumeRoot, 'some', 'nested', 'session.jsonl');
  assert.deepEqual(clientsForWatchPath(target, { codex: [volumeRoot] }), ['codex']);
});

test('a Copilot exporter already on disk is attributed when unlink is its first event', async (t) => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-copilot-unlink-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'workspaceStorage');
  const file = path.join(dir, 'ς.jsonl');
  const configured = path.join(dir, 'Σ.jsonl');
  fs.mkdirSync(dir);
  fs.writeFileSync(file, 'export');
  if (!fs.existsSync(configured)) return t.skip('fixture requires a case-insensitive volume');
  t.mock.method(os, 'homedir', () => home);
  process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = configured;
  process.env.TOKEN_MONITOR_SHARED_DIR = home;
  let onEvent;
  t.mock.method(require('chokidar'), 'watch', () => {
    const watcher = { on(event, handler) { if (event === 'all') onEvent = handler; return watcher; }, close() {} };
    return watcher;
  });
  const scans = [];
  const runtime = startCollector({
    clients: 'claude,copilot', homeDir: home, allTimeSince: '2024-01-01',
    deviceId: 'copilot-unlink-test', agentVersion: 'test', intervalMs: 3600000,
    watchEnabled: true, watchDebounceMs: 10, historyEnabled: false,
    dailyHistoryArchiveEnabled: false, anchorPersistenceEnabled: false,
    projectsEnabled: false, wslScanEnabled: false, sessionActivityPolling: false,
    async runTokscale(input) {
      scans.push(input.clients);
      return { entries: [{ client: 'copilot', model: 'test-model', input: 1, output: 0 }] };
    }
  });
  t.after(async () => { runtime.stop(); await runtime.whenIdle(); });
  await runtime.whenIdle();
  assert.equal(scans.length, 3);
  fs.unlinkSync(file);
  onEvent('unlink', file);
  await delay(40); await runtime.whenIdle();
  assert.deepEqual(scans.slice(3), ['copilot']);
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
