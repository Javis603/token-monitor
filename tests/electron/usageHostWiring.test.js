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

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

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
  const start = main.indexOf("ipcMain.handle('settings:update', async (_event, patch) => {");
  assert.ok(start >= 0, 'settings:update handler not found or not async');
  const body = main.slice(start, main.indexOf('\n  });', start));
  assert.ok(body.indexOf('applySettingsPatch(patch,') < body.indexOf('await latestUsageHost?.transformSettingsApplied?.()'));
});

test('Dots visibility refresh only delays its own settings save, including after failure', async () => {
  const start = main.indexOf("ipcMain.handle('settings:update', async (_event, patch) => {");
  const registration = main.slice(start, main.indexOf('\n  });', start) + '\n  });'.length);
  let update;
  let failRefresh;
  let saved;
  const refresh = new Promise((_resolve, reject) => { failRefresh = reject; });
  const contentRuntime = { status: () => ({ identity: 'test' }), publishPatch: async () => {} };
  vm.runInNewContext(registration, {
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
  const start = main.indexOf("ipcMain.handle('settings:update', async (_event, patch) => {");
  const registration = main.slice(start, main.indexOf('\n  });', start) + '\n  });'.length);
  let update;
  let release;
  const refresh = new Promise((resolve) => { release = resolve; });
  const contentRuntime = { status: () => ({ identity: 'test' }), publishPatch: async () => {} };
  let saved = { codexDotsVisible: true, currency: 'USD', clients: 'codex' };
  vm.runInNewContext(registration, {
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
