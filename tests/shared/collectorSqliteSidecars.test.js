'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');
const { installInProcessWatchHost } = require('../helpers/watchHost');
const { startCollector, isSelfWatchSqliteSidecarEvent } = require('../../src/shared/collector');

installSourceEnvGuard(test);
installInProcessWatchHost(test);

// Native macOS scans of unchanged WAL databases rewrite these SHM files.
// OpenCode and MiMo do so on the first read before their source cache is warm.
const sources = [
  ['kilo', '.local/share/kilo/kilo.db'],
  ['kiro', '.local/share/kiro-cli/data.sqlite3'],
  ['zed', '.local/share/zed/threads/threads.db'],
  ['hermes', '.hermes/state.db'],
  ['copilot', '.copilot/session-store.db'],
  ['unsloth', '.unsloth/studio/studio.db'],
  ['devin', '.local/share/devin/cli/sessions.db'],
  ['openclaw', '.openclaw/agents/main/agent/openclaw-agent.sqlite'],
  ['opencode', '.local/share/opencode/opencode.db'],
  ['mimo', '.local/share/mimocode/mimocode.db']
];

for (const [client, relative] of sources) {
  test(`${client} scan sidecars cannot feed another live scan, while DB and WAL changes still refresh`, async (t) => {
    // Match the canonical paths emitted by the native watcher on Windows,
    // where the temporary directory can otherwise retain an 8.3 alias.
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sqlite-watch-')));
    const database = path.join(home, relative);
    fs.mkdirSync(path.dirname(database), { recursive: true });
    fs.writeFileSync(database, '');
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    t.mock.method(os, 'homedir', () => home);
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
    const previousSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
    process.env.TOKEN_MONITOR_SHARED_DIR = home;
    t.after(() => {
      if (previousSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
      else process.env.TOKEN_MONITOR_SHARED_DIR = previousSharedDir;
    });

    const chokidar = require('chokidar');
    let onEvent;
    t.mock.method(chokidar, 'watch', () => {
      const watcher = {
        on(event, handler) { if (event === 'all') onEvent = handler; return watcher; },
        close() {}
      };
      return watcher;
    });
    let scans = 0;
    const updates = [];
    const runtime = startCollector({
      clients: client, homeDir: home, allTimeSince: '2024-01-01',
      deviceId: 'sqlite-sidecar-test', agentVersion: 'test', commandTimeoutMs: 1000,
      intervalMs: 3600000, watchEnabled: true, watchDebounceMs: 10,
      historyEnabled: false, dailyHistoryArchiveEnabled: false,
      anchorPersistenceEnabled: false, projectsEnabled: false,
      wslScanEnabled: false, sessionActivityPolling: false,
      async runTokscale() {
        scans += 1;
        // Model the measured SQLite read side effect, with no client writing usage.
        onEvent('change', `${database}-shm`);
        return { entries: [] };
      },
      onUpdate(_summary, reason) { updates.push(reason); }
    });
    t.after(async () => { runtime.stop(); await runtime.whenIdle(); });
    await runtime.whenIdle();
    assert.equal(scans, 3, 'startup scans Today, Month and All Time serially');
    await delay(60);
    assert.equal(scans, 3, 'scanner SHM writes must not start a feedback loop');
    assert.equal(updates.length, 1);

    for (const suffix of ['-wal', '']) {
      const previous = scans;
      onEvent('change', database + suffix);
      await delay(40);
      await runtime.whenIdle();
      assert.equal(scans, previous + 1, `${suffix || 'database'} changes still request a Today scan`);
      await delay(30);
      assert.equal(scans, previous + 1, 'the resulting scan cannot trigger itself');
    }
  });
}

test('SQLite self-scan filtering keeps real data, unrelated files and other client roots', () => {
  const root = path.resolve('/sqlite-sidecar-fixture');
  for (const [client, relative] of sources) {
    const name = path.basename(relative);
    const roots = { [client]: [root] };
    assert.equal(isSelfWatchSqliteSidecarEvent(path.join(root, `${name}-shm`), roots), true);
    for (const suffix of ['', '-wal', '-journal']) {
      assert.equal(isSelfWatchSqliteSidecarEvent(path.join(root, name + suffix), roots), false);
    }
    assert.equal(isSelfWatchSqliteSidecarEvent(path.join(root, 'runtime-shm'), roots), false);
    assert.equal(isSelfWatchSqliteSidecarEvent(path.join(`${root}-other`, `${name}-shm`), roots), false);
    assert.equal(isSelfWatchSqliteSidecarEvent(path.join(root, `${name}-shm`), { codex: [root] }), false);
  }
});
