'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { usageConfigFromSettings } = require('../../src/electron/runtimeConfig');
const { collectUsageOnce } = require('../../src/shared/collector');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');
const agent = fs.readFileSync(path.join(ROOT, 'src/agent/agent.js'), 'utf8');

function functionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = source.indexOf('\nfunction ', start + signature.length);
  return source.slice(start, end === -1 ? source.length : end);
}

// Local / sync / host must every one of them take their usage options from
// electronUsageConfig, or a mode quietly stops honouring the settings below.
// Each keeps that exact object in a const: local shares it with the cold-start
// anchor check, while sync/host also register its structural fingerprint.
function assertEveryCollectorModeUsesUsageConfig() {
  for (const [name, label] of [
    ['startLocalCollector', 'collector'],
    ['startSyncCollector', 'sync-collector'],
    ['startHostCollector', 'host-collector']
  ]) {
    const collector = functionSource(main, `function ${name}()`);
    assert.match(collector, new RegExp(`const usageOptions = electronUsageConfig\\('${label}'\\);`));
    assert.match(collector, /^\s+usageOptions,$/m);
  }
}

test('every Electron collector mode takes daily history options from the same configuration', () => {
  assert.match(main, /function electronUsageConfig/);
  assert.match(main, /usageConfigFromSettings\(settings, \{/);
  assertEveryCollectorModeUsesUsageConfig();
});

test('Electron records while paused, shows only source totals, and restores the archive on resume', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-daily-history-wiring-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = {
    ...usageConfigFromSettings({ clients: 'claude', sessionUsageArchiveEnabled: false, projectsEnabled: false }),
    homeDir: directory,
    env: { TOKEN_MONITOR_SHARED_DIR: directory },
    includeHistory: true,
    dailyHistoryArchiveOptions: { path: path.join(directory, 'daily-history.json') }
  };
  const first = await collectUsageOnce({
    ...options,
    now: new Date(2026, 7, 5, 23, 55),
    runGraph: async () => ({ contributions: [] }),
    runTokscale: async () => ({ entries: [{ client: 'claude', modelId: 'opus', input: 100, messages: 1 }] })
  });
  assert.equal(first.history?.daily.find((day) => day.date === '2026-08-05')?.tokens, 100);

  const nextOptions = {
    ...options,
    now: new Date(2026, 7, 6, 0, 5),
    runGraph: async () => ({ contributions: [{ date: '2026-08-05', clients: [
      { client: 'claude', modelId: 'opus', tokens: { input: 30 }, messages: 1 }
    ] }] }),
    runTokscale: async () => ({ entries: [] })
  };
  const next = await collectUsageOnce(nextOptions);
  assert.equal(next.history.daily.find((day) => day.date === '2026-08-05')?.tokens, 30);
  assert.equal(next.history.summary.totalTokens, 30);

  const emptySource = { ...nextOptions, runGraph: async () => ({ contributions: [] }) };
  const empty = await collectUsageOnce(emptySource);
  assert.equal(empty.history.summary.totalTokens, 0);

  const resumed = await collectUsageOnce({
    ...emptySource,
    ...usageConfigFromSettings({ clients: 'claude', projectsEnabled: false, sessionUsageArchiveEnabled: true })
  });
  assert.equal(resumed.history.daily.find((day) => day.date === '2026-08-05')?.tokens, 100);
});

test('every Electron collector mode yields daily-history writes to an external agent', () => {
  assert.match(main, /dailyHistoryArchiveWriteEnabled:\s*\(\) => !isExternalAgentActive\(\)/);
  assertEveryCollectorModeUsesUsageConfig();
});

test('clearing retained session usage also clears retained daily history', () => {
  assert.match(main, /sessionUsageArchiveStore\.clear\(\);\s*clearDailyHistoryArchive\(\);/);
});

test('the headless agent follows the history setting and leaves storage alone in dry-run mode', () => {
  assert.match(agent, /dailyHistoryArchiveEnabled:\s*historyEnabled/);
  assert.match(agent, /dailyHistoryArchiveVisible:\s*sessionUsageArchiveEnabled/);
  assert.match(agent, /dailyHistoryArchiveWriteEnabled:\s*!dryRun/);
});

test('a non-dry-run one-shot agent claims archive ownership before collecting', () => {
  const ownership = agent.indexOf('if (!dryRun) registerPidFile(');
  const oneShot = agent.indexOf('if (once) {');
  assert.ok(ownership >= 0);
  assert.ok(oneShot >= 0);
  assert.ok(ownership < oneShot);
});
