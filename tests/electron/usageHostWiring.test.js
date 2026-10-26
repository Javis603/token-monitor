'use strict';

// Unless TOKEN_MONITOR_USAGE_WORKER=0, the collector, the transform and the
// session archive writer run on a worker thread (tests/shared/usageHost.test.js
// covers the host itself). main.js cannot be required outside Electron, so these
// pin the wiring that decides whether every runtime actually goes through it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { createUsageHost, createUsageHostCoordinator } = require('../../src/shared/usage/usageHost');
const { createDeviceRuntime } = require('../../src/shared/usage/deviceRuntime');
const { normalizePeriod } = require('../../src/shared/usage');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

for (const externalAgent of [false, true]) {
  for (const failure of ['open', 'full-cursor', 'revision-cursor']) {
    test(`last-good survives ${failure} after worker handoff (${externalAgent ? 'agent refresh' : 'capture'})`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-last-good-'));
      let fail = false;
      let revisionFailed = false;
      const cursors = [];
      class FailingDatabase extends DatabaseSync {
        constructor(file, options = {}) {
          if (fail && failure === 'open') throw new Error('temporary EIO');
          super(file, options);
        }
        prepare(sql) {
          const statement = super.prepare(sql);
          if (!/SELECT session_key, entry_json/.test(sql)) return statement;
          return new Proxy(statement, { get(target, property) {
            if (property !== 'iterate') {
              const value = target[property];
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return (...args) => {
              const rows = target.iterate(...args);
              const cursor = { returned: false, steps: 0 };
              cursors.push(cursor);
              return {
                [Symbol.iterator]() { return this; },
                next() {
                  const row = rows.next();
                  if (fail && cursor.steps++ === 1
                    && (revisionFailed || /WHERE revision/.test(sql) === (failure === 'revision-cursor'))) {
                    revisionFailed = failure === 'revision-cursor';
                    throw new Error('temporary EIO');
                  }
                  return row;
                },
                return() { cursor.returned = true; return rows.return(); }
              };
            };
          } });
        }
      }
      const opts = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
      const store = createSessionUsageArchiveStore({ ...opts, DatabaseSync: FailingDatabase });
      const writer = createSessionUsageArchiveStore(opts);
      const at = new Date();
      const summary = (id, tokens) => {
        const period = () => normalizePeriod({ totalTokens: tokens, clients: { codex: tokens },
          sessions: { [`codex:${id}`]: { client: 'codex', sessionId: id, totalTokens: tokens } } });
        return { updatedAt: at.toISOString(), today: period(), month: period(), allTime: period() };
      };
      writer.capture(summary('retained', 1000), at);
      const transform = createUsageTransform({ store, isExternalAgentActive: () => externalAgent, log: () => {} });
      if (!externalAgent) transform.ensureLoaded();
      let worker;
      class ScriptedWorker extends EventEmitter {
        constructor() { super(); worker = this; }
        postMessage(message) { if (message.type === 'stop') setImmediate(() => this.emit('exit', 0)); }
        unref() {}
      }
      const coordinator = createUsageHostCoordinator({ Worker: ScriptedWorker });
      const start = main.indexOf('function createElectronUsageRuntime(');
      let delivery;
      let limits;
      const context = { usageTransform: transform, latestUsageHost: null, settings: {},
        AGENT_PID_PATH: path.join(dir, 'absent.pid'), usageTransformSettings: (settings) => settings,
        console: { log: () => {} },
        createUsageHost: (options, host) => {
          delivery = options;
          return createUsageHost(options, host, { worker: true, coordinator });
        } };
      vm.runInNewContext(main.slice(start, main.indexOf('\n}\n', start) + 3), context);
      const records = [], sinks = [], errors = [], diagnostics = [];
      let liveTokens = 100;
      const runtime = createDeviceRuntime({
        progressive: true, transformUsage: transform.transform,
        envelope: { deviceId: 'last-good' }, sink: { enqueue: (record) => sinks.push(record) },
        onRecord: (record) => records.push(record), onError: (error) => errors.push(error),
        onDiagnosticEvent: (event) => diagnostics.push(event),
        usageOptions: {
          onError: (error) => errors.push(error),
          clients: 'codex', allTimeSince: '2024-01-01', homeDir: dir, env: {},
          osInfo: {}, sessionMetadataDeps: { sessionMetadataResolvers: new Map() },
          lookupModelPricing: async () => null,
          runGraph: async () => { throw new Error('unexpected graph request'); },
          anchorPath: path.join(dir, 'collector-anchor.json'), pricingPath: path.join(dir, 'pricing.json'),
          intervalMs: 3600000, watchEnabled: false, historyEnabled: false,
          dailyHistoryArchiveEnabled: false, anchorPersistenceEnabled: false,
          sessionActivityPolling: false, codexLocalUsageEnabled: false, wslScanEnabled: false,
          runTokscale: async () => ({ entries: [{ client: 'codex', sessionId: 'live', model: 'fixture', input: liveTokens, output: 0 }] })
        }
      }, { createUsageRuntime: context.createElectronUsageRuntime,
        createLimitsRuntime: (_options, deps) => { limits = deps; return { stop() {} }; } });
      t.after(async () => {
        fail = false;
        runtime.stop();
        await context.latestUsageHost.whenIdle();
        store.close(); writer.close();
        fs.rmSync(dir, { recursive: true, force: true });
      });
      await new Promise((resolve) => setImmediate(resolve));
      const workerTransform = createUsageTransform({ store: writer });
      worker.emit('message', { type: 'update', summary: workerTransform.transform(summary('live', 100)) });
      assert.equal(runtime.getSnapshot().allTime.totalTokens, 1100);
      assert.equal(transform.getState().loaded, false, 'worker delivery releases main archive');
      // Revision catch-up starts with a complete loaded object; loaded=true
      // must still not authorize a partial/uncommitted publication.
      if (failure === 'revision-cursor') {
        store.refresh();
        writer.capture(summary('live', 120), at);
      }
      const published = records.length;
      fail = true;
      worker.emit('exit', 1); // Real coordinator starts the real collector fallback.
      await context.latestUsageHost.whenIdle();
      assert.equal(runtime.getSnapshot().allTime.totalTokens, 1100, 'failed archive must not publish live-only 100');
      assert.ok(errors.some((error) => /temporary EIO/.test(error.message)));
      assert.ok(diagnostics.some((event) => event.code === 'collector-tick-failed'));
      assert.equal(context.latestUsageHost.getDiagnostics().lastTickSuccessAt, null);
      assert.equal(records.length, published, 'neither fallback preview nor update may reach publication');
      assert.equal(sinks.length, published);
      assert.throws(() => delivery.onPreview(summary('live', 100), 'progress'), /temporary EIO/);
      assert.throws(() => delivery.onUpdate(summary('live', 100), 'manual'), /temporary EIO/);
      assert.equal(records.length, published);
      assert.equal(sinks.length, published);
      assert.equal(runtime.getSnapshot().allTime.totalTokens, 1100);
      assert.equal(runtime.getSnapshot().allTime.sessions['codex:retained'].totalTokens, 1000);
      if (failure !== 'open') assert.ok(cursors.at(-1).returned, 'failed partial cursor is closed');
      limits.onUpdate({ providers: [] });
      assert.equal(records.at(-1).allTime.totalTokens, 1100, 'limits-only publication carries last-good usage');
      assert.equal(sinks.at(-1).allTime.totalTokens, 1100);
      fail = false;
      liveTokens = 120;
      assert.equal(await runtime.tick('manual'), true);
      assert.equal(runtime.getSnapshot().allTime.totalTokens, 1120);
      assert.equal(sinks.at(-1).allTime.totalTokens, 1120);
      assert.equal(context.latestUsageHost.getDiagnostics().lastFailureCode, null);
      assert.ok(diagnostics.some((event) => event.code === 'collector-recovered'));
      assert.equal(writer.refresh().sessions['codex:retained'].periods.allTime.totalTokens, 1000);
    });
  }
}

test('a genuinely empty database publishes zero usage normally', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-empty-archive-'));
  const store = createSessionUsageArchiveStore({ env: { TOKEN_MONITOR_SHARED_DIR: dir } });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const transform = createUsageTransform({ store });
  let delivery;
  const records = [];
  const runtime = createDeviceRuntime({ transformUsage: transform.transform,
    onRecord: (record) => records.push(record) }, {
    createUsageRuntime: (options) => { delivery = options; return { stop() {} }; },
    createLimitsRuntime: () => ({ stop() {} })
  });
  t.after(() => runtime.stop());
  const period = () => normalizePeriod({});
  delivery.onUpdate({ updatedAt: new Date().toISOString(), today: period(), month: period(), allTime: period() }, 'startup');
  assert.equal(records.length, 1);
  assert.equal(runtime.getSnapshot().allTime.totalTokens, 0);
  assert.deepEqual(runtime.getSnapshot().allTime.sessions, {});
});

test('Electron releases prime only on transformed worker delivery and forwards fallback callbacks', () => {
  const start = main.indexOf('function createElectronUsageRuntime(');
  const body = main.slice(start, main.indexOf('\n}\n', start) + 3);
  let captured;
  let releases = 0;
  const events = [];
  const context = {
    console: { log: () => {} },
    latestUsageHost: null,
    usageTransform: { release: () => { releases += 1; } },
    createUsageHost: (options) => { captured = options; return { host: true }; },
    AGENT_PID_PATH: '/agent.pid',
    usageTransformSettings: (settings) => settings,
    settings: {}
  };
  vm.runInNewContext(body, context);
  const options = {
    onUpdate: (...args) => { events.push(args); return 'updated'; },
    onPreview: (...args) => events.push(args)
  };
  context.createElectronUsageRuntime(options);
  assert.equal(releases, 0, 'worker construction alone is not a handoff');
  assert.equal(captured.onUpdate('fallback-before', 'startup'), 'updated');
  assert.equal(releases, 0);
  const meta = { transformed: true };
  captured.onPreview('worker-preview', 'progress', meta);
  assert.equal(releases, 1);
  assert.equal(captured.onUpdate('worker-full', 'startup', meta), 'updated');
  assert.equal(releases, 2);
  captured.onUpdate('fallback-after', 'manual');
  assert.equal(releases, 2, 'fallback keeps its reloaded archive');
  assert.deepEqual(events, [
    ['fallback-before', 'startup', undefined],
    ['worker-preview', 'progress', meta],
    ['worker-full', 'startup', meta],
    ['fallback-after', 'manual', undefined]
  ]);
  context.createElectronUsageRuntime({ onUpdate: options.onUpdate });
  assert.equal(captured.onPreview, undefined, 'do not enable progressive collection for other modes');
  context.usageTransform.release = () => { throw new Error('close failed'); };
  assert.equal(captured.onUpdate('worker-cleanup-failed', 'manual', meta), 'updated', 'cleanup must not discard worker data');
});

test('every device runtime starts its usage runtime through the usage host', () => {
  const runtimes = main.match(/createDeviceRuntime\(\{/g) || [];
  const hosted = main.match(/createUsageRuntime: createElectronUsageRuntime,/g) || [];
  assert.ok(runtimes.length > 0);
  assert.equal(hosted.length, runtimes.length);
});

test('the worker is handed the agent PID file and exactly the settings the transform reads', () => {
  const start = main.indexOf('function createElectronUsageRuntime(');
  assert.ok(start >= 0, 'createElectronUsageRuntime not found');
  const body = main.slice(start, main.indexOf('\n}\n', start));
  assert.match(body, /agentPidPath: AGENT_PID_PATH/);
  assert.match(body, /transformSettings: usageTransformSettings\(settings\)/);
});

test('archive diagnostics come from the worker while it owns the archive', () => {
  const start = main.indexOf('getArchiveState: () => {');
  assert.ok(start >= 0, 'getArchiveState not found');
  const body = main.slice(start, main.indexOf('\n  },', start));
  assert.match(body, /latestUsageHost\?\.getArchiveState\?\.\(\) \|\| usageTransform\.getState\(\)/);
});

test('clearing the archive waits for a worker-hosted collector to exit first', () => {
  const start = main.indexOf("ipcMain.handle('sessionUsageArchive:clear', async () => {");
  assert.ok(start >= 0, 'clear handler not found or not async');
  const body = main.slice(start, main.indexOf('\n  });', start));
  const wait = body.indexOf('await whenUsageHostsIdle()');
  const clear = body.indexOf('sessionUsageArchiveStore.clear()');
  assert.ok(body.indexOf('stopLocalCollector()') >= 0 && body.indexOf('stopLocalCollector()') < wait);
  assert.ok(body.indexOf('stopSyncCollector()') >= 0 && body.indexOf('stopSyncCollector()') < wait);
  assert.ok(wait >= 0 && wait < clear, 'the worker must be gone before the archive is deleted');
  const recheck = body.indexOf('isExternalAgentActive()', wait);
  assert.ok(recheck > wait && recheck < clear, 'agent ownership is checked again after the wait');
});

test('a settings change reaches the running worker as soon as it is saved', () => {
  const start = main.indexOf('function applySettingsPatch(');
  assert.ok(start >= 0, 'applySettingsPatch not found');
  const body = main.slice(start, main.indexOf('\n  }\n', start));
  const save = body.indexOf('saveSettings({ throwOnError: true });');
  const update = body.indexOf('latestUsageHost?.updateTransformSettings?.(usageTransformSettings(settings));');
  assert.ok(save >= 0 && update > save, 'the worker is updated right after the settings are saved');
  // Before the usage runtime is reconfigured, which only happens after the settle delay.
  assert.ok(update < body.indexOf('reconfigureUsageRuntimeForMode()'));
});

test('saving settings waits until a worker-hosted transform has applied them', () => {
  const start = main.indexOf("ipcMain.handle('settings:update', async (event, patch) => {");
  assert.ok(start >= 0, 'settings:update handler not found or not async');
  const body = main.slice(start, main.indexOf('\n  });', start));
  assert.ok(body.indexOf('applySettingsPatch(patch,') < body.indexOf('await latestUsageHost?.transformSettingsApplied?.()'));
});

test('Dots visibility refresh only delays its own settings save, including after failure', async () => {
  const start = main.indexOf("ipcMain.handle('settings:update', async (event, patch) => {");
  const registration = main.slice(start, main.indexOf('\n  });', start) + '\n  });'.length);
  let update;
  let failRefresh;
  let saved;
  const refresh = new Promise((_resolve, reject) => { failRefresh = reject; });
  const contentRuntime = { status: () => ({ identity: 'test' }), publishPatch: async () => {} };
  const guardStart = main.indexOf('function assertPluginSkinRequest(');
  const guardEnd = main.indexOf('\nfunction settingsForRenderer(', guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart);
  vm.runInNewContext(main.slice(guardStart, guardEnd) + registration, {
    pluginRuntime: null,
    ipcMain: { handle: (_name, handler) => { update = handler; } },
    getSyncContentRuntime: () => contentRuntime,
    latestUsageHost: { transformSettingsApplied: async () => {} },
    settingsForRenderer: () => saved,
    applySettingsPatch: (patch, onRefresh) => {
      saved = patch;
      if (patch.codexDotsVisible !== undefined) onRefresh(refresh);
      return patch;
    }
  });
  let visibilitySettled = false;
  const visibility = update(null, { codexDotsVisible: false });
  const failedVisibility = assert.rejects(visibility, /refresh failed/);
  visibility.finally(() => { visibilitySettled = true; }).catch(() => {});
  const currency = { currency: 'HKD' };
  assert.equal(await update(null, currency), currency);
  assert.equal(visibilitySettled, false);
  failRefresh(new Error('refresh failed'));
  await failedVisibility;
  const language = { language: 'zh-TW' };
  assert.equal(await update(null, language), language);
});

test('a delayed Dots visibility reply keeps the settings saved by a later write', async () => {
  const start = main.indexOf("ipcMain.handle('settings:update', async (event, patch) => {");
  const registration = main.slice(start, main.indexOf('\n  });', start) + '\n  });'.length);
  let update;
  let release;
  const refresh = new Promise((resolve) => { release = resolve; });
  const contentRuntime = { status: () => ({ identity: 'test' }), publishPatch: async () => {} };
  let saved = { codexDotsVisible: true, currency: 'USD', clients: 'codex' };
  const guardStart = main.indexOf('function assertPluginSkinRequest(');
  const guardEnd = main.indexOf('\nfunction settingsForRenderer(', guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart);
  vm.runInNewContext(main.slice(guardStart, guardEnd) + registration, {
    pluginRuntime: null,
    ipcMain: { handle: (_name, handler) => { update = handler; } },
    getSyncContentRuntime: () => contentRuntime,
    latestUsageHost: { transformSettingsApplied: async () => {} },
    settingsForRenderer: () => ({ ...saved }),
    applySettingsPatch: (patch, onRefresh) => {
      saved = { ...saved, ...patch };
      if (patch.codexDotsVisible !== undefined) onRefresh(refresh);
      return { ...saved };
    }
  });
  const visibility = update(null, { codexDotsVisible: false });
  const later = await update(null, { currency: 'HKD', clients: 'codex,claude' });
  assert.equal(later.currency, 'HKD');
  release();
  const reply = await visibility;
  assert.deepEqual(reply, later);
  assert.equal(reply.codexDotsVisible, false);
  assert.equal(reply.clients, 'codex,claude');
});
