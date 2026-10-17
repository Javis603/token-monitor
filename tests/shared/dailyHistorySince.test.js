'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-history-since-'));
process.env.TOKEN_MONITOR_SHARED_DIR = directory;
process.on('exit', () => fs.rmSync(directory, { recursive: true, force: true }));

const { collectUsageOnce } = require('../../src/shared/collector');
const { normalizeAllTimeSince, usageConfigFromSettings } = require('../../src/electron/runtimeConfig');
const { allTimeCumulativeFromArchive, captureDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');
const { createDailyHistoryFloorReader, createUsageTransform, usageTransformSettings } = require('../../src/shared/usage/usageTransform');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createUsageHostCoordinator } = require('../../src/shared/usage/usageHost');

const archivePath = path.join(directory, 'daily-history-archive.json');
const archive = captureDailyHistoryArchive({}, { contributions: [
  ['2026-06-30', 'old-model', 1000], ['2026-07-01', 'boundary-model', 100], ['2026-07-09', 'live-model', 500]
].map(([date, modelId, tokens]) => ({ date, clients: [{
  client: 'claude', modelId, tokens: { input: tokens }, cost: tokens / 100, messages: 1
}] })) });
fs.writeFileSync(archivePath, JSON.stringify(archive));

// The host unrefs its worker; keep the test alive until its round trip settles.
let keepAlive;
test.before(() => { keepAlive = setInterval(() => {}, 1000); });
test.after(() => clearInterval(keepAlive));

async function scan(options) {
  assert.equal(options.allTimeSince, normalizeAllTimeSince(options.allTimeSince), 'the scanner receives a normalized date');
  const flags = [];
  const summary = await collectUsageOnce({
    ...options, now: new Date(2026, 6, 9, 12), homeDir: directory, env: {},
    includeHistory: false, dailyHistoryArchiveWriteEnabled: false, wslScanEnabled: false,
    runTokscale: async (input) => {
      flags.push(input.flags);
      return { entries: [{ client: 'claude', sessionId: 'live', model: 'live-model', input: 500, output: 0, cost: 5 }] };
    }
  });
  assert.deepEqual(flags, [['--today'], ['--month'], ['--since', options.allTimeSince]]);
  assert.equal(summary.allTime.totalTokens, 500, 'the scanner is already inside the requested range');
  return summary;
}

function assertTotal(summary, tokens) {
  assert.equal(summary.allTime.totalTokens, tokens);
  assert.equal(summary.allTime.costUsd, tokens / 100);
  assert.equal(summary.today.totalTokens, 500);
  assert.equal(summary.month.totalTokens, 500);
}

test('daily reduction includes the starting day, excludes earlier days, and stays unbounded without since', () => {
  const floor = allTimeCumulativeFromArchive(archive, { allTimeSince: '2026-07-01' }).claude;
  assert.equal(floor.totalTokens, 600);
  assert.equal(floor.costUsd, 6);
  assert.deepEqual({ ...floor.models }, { 'boundary-model': 100, 'live-model': 500 });
  assert.equal(allTimeCumulativeFromArchive(archive).claude.totalTokens, 1600);
  const beforeDefault = { days: { '2023-12-31': { ...archive.days['2026-06-30'], date: '2023-12-31' } } };
  assert.equal(allTimeCumulativeFromArchive(beforeDefault).claude.totalTokens, 1000,
    'omitting since does not introduce the runtime default cutoff into the reducer');
  assert.deepEqual({ ...allTimeCumulativeFromArchive(archive, { allTimeSince: '2026-07-10' }) }, {});
});

test('reader cache uses the normalized since as well as mtime, including returning to no cutoff', () => {
  let reads = 0;
  const load = createDailyHistoryFloorReader({
    dailyHistoryArchive: { path: archivePath },
    readDailyHistoryArchive: () => { reads += 1; return archive; }
  });
  const first = load(' 2026-07-01 ');
  assert.equal(first.claude.totalTokens, 600);
  assert.equal(load('2026-07-01'), first, 'equivalent dates reuse the cached reduction');
  assert.equal(reads, 1);
  assert.equal(load('2026-07-09').claude.totalTokens, 500);
  assert.equal(load('2026-06-30').claude.totalTokens, 1600);
  assert.equal(load().claude.totalTokens, 1600);
  assert.equal(reads, 4, 'each changed cutoff invalidates the cache despite an unchanged file');
});

for (const [since, expected] of [[' 2026-07-01 ', 600], ['2026-07-09', 500], ['2026-02-30', 1600], [undefined, 1600]]) {
  for (const worker of [false, true]) {
    test(`widget ${worker ? 'worker' : 'in-process'} carries effective since ${since} from settings to recovery`, async (t) => {
      const settings = { clients: 'claude', projectsEnabled: false, allTimeSince: since };
      const options = usageConfigFromSettings(settings);
      const summary = await scan(options);
      if (worker) {
        const coordinator = createUsageHostCoordinator({
          workerPath: path.join(__dirname, '../fixtures/usageWorkerScriptedCollector.js')
        });
        const updates = [];
        const runtime = coordinator.create({
          ...options, scriptedSummary: summary, onUpdate: (value) => updates.push(value)
        }, { transformSettings: usageTransformSettings(settings), agentPidPath: path.join(directory, 'absent.pid') });
        t.after(async () => { runtime.stop(); await runtime.whenIdle(); });
        assert.equal(await runtime.tick('watch'), true);
        assert.equal(updates.length, 1);
        assertTotal(updates[0], expected);
        runtime.updateTransformSettings(usageTransformSettings({ ...settings, allTimeSince: '2026-07-09' }));
        await runtime.transformSettingsApplied();
        await runtime.tick('watch');
        assertTotal(updates[1], 500);
      } else {
        const store = createSessionUsageArchiveStore({ databasePath: path.join(directory, 'in-process.sqlite'), path: path.join(directory, 'legacy.json') });
        t.after(() => store.close());
        const transform = createUsageTransform({ store, dailyHistoryArchive: true, getSettings: () => settings });
        assertTotal(transform.transform(summary), expected);
        settings.allTimeSince = '2026-07-09';
        assertTotal(transform.transform(summary), 500);
      }
    });
  }
}

for (const dryRun of [false, true]) {
  for (const [flags, env, expected] of [
    [[], ' 2026-07-01 ', 600],
    [['--since=2026-07-09'], '2026-07-01', 500],
    [['--allTimeSince=2026-07-01'], undefined, 600],
    [[], undefined, 1600]
  ]) {
    test(`headless ${dryRun ? 'dry-run' : 'normal'} uses CLI/env since ${flags.join(',') || env || 'default'} for scanning and recovery`, async () => {
      const filename = path.resolve(__dirname, '../../src/agent/agent.js');
      const agentRequire = createRequire(filename);
      let resolve;
      let reject;
      const completed = new Promise((done, fail) => { resolve = done; reject = fail; });
      vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require(id) {
          if (id === '../shared/config') return { ...agentRequire(id), loadDotEnv() {}, pidFilePath: () => path.join(directory, 'agent.pid') };
          if (id === './seedClients') return { seedAgentClients: (clients) => clients };
          if (id === './titleSync') return { createAgentTitleSync: () => ({ negotiate: async () => ({}) }) };
          if (id === './runtime') return { async runAgentOnce(options) {
            try { resolve(options.transformUsage(await scan(options.usageOptions))); } catch (error) { reject(error); throw error; }
          } };
          return agentRequire(id);
        },
        process: {
          argv: ['node', filename, '--once', '--clients=claude', '--projects=false', ...(dryRun ? ['--dry-run'] : []), ...flags],
          pid: 123, env: { TOKEN_MONITOR_DEVICE_ID: 'fixture', ...(env === undefined ? {} : { TOKEN_MONITOR_ALL_TIME_SINCE: env }) }, on() {}
        },
        fetch: () => { throw new Error('unexpected network request'); },
        console: { log() {}, warn() {}, error(value) { if (value?.stack) reject(value); } }
      }, { filename });
      assertTotal(await completed, expected);
    });
  }
}
