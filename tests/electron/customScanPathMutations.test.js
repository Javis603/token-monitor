'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererPath = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js');

function mutationHarness(initialCustomScanPaths, saveSettings) {
  const app = fs.readFileSync(rendererPath, 'utf8');
  const queueStart = app.indexOf('let customScanPathMutationQueue = Promise.resolve();');
  const queueEnd = app.indexOf('function customSourceIcon(', queueStart);
  const resetStart = app.indexOf('function resetClientSourceProbe(');
  const addEnd = app.indexOf('// Values are formatted here', resetStart);
  assert.notEqual(queueStart, -1);
  assert.notEqual(queueEnd, -1);
  assert.notEqual(resetStart, -1);
  assert.notEqual(addEnd, -1);

  const state = {
    settings: { customScanPaths: structuredClone(initialCustomScanPaths) },
    customScanPathErrors: new Map(),
    clientSources: { entries: new Map() },
    clientSourcesKey: '',
    clientSourcesRequest: 0
  };
  const context = vm.createContext({
    state,
    saveSettings: (patch) => saveSettings(patch, state),
    enabledClientSet: () => new Set(['dsh', 'codex']),
    loadClientSources: () => {},
    refillOpenClientHealthPanel: () => {},
    window: { tokenMonitor: {} }
  });
  vm.runInContext(
    `${app.slice(queueStart, queueEnd)}\n${app.slice(resetStart, addEnd)}`,
    context
  );
  return {
    remove: (clientId, dir) => vm.runInContext(
      `removeCustomScanPath(${JSON.stringify(clientId)}, ${JSON.stringify(dir)})`,
      context
    ),
    state
  };
}

test('rapid custom path removals serialize and use the latest saved state', async () => {
  let releaseFirst;
  const firstSaveHeld = new Promise((resolve) => { releaseFirst = resolve; });
  const saves = [];
  const harness = mutationHarness({ dsh: ['/sessions/a', '/sessions/b'] }, async (patch, state) => {
    saves.push(structuredClone(patch.customScanPaths));
    if (saves.length === 1) await firstSaveHeld;
    state.settings = { ...state.settings, ...structuredClone(patch) };
  });

  const removeA = harness.remove('dsh', '/sessions/a');
  const removeB = harness.remove('dsh', '/sessions/b');
  await Promise.resolve();
  assert.deepEqual(saves, [{ dsh: ['/sessions/b'] }]);

  releaseFirst();
  await Promise.all([removeA, removeB]);

  assert.deepEqual(saves, [{ dsh: ['/sessions/b'] }, {}]);
  assert.deepEqual(harness.state.settings.customScanPaths, {});
});

test('queued custom path removals preserve mutations made for another client', async () => {
  const saves = [];
  const harness = mutationHarness({
    dsh: ['/sessions/dsh'],
    codex: ['/sessions/codex']
  }, async (patch, state) => {
    saves.push(structuredClone(patch.customScanPaths));
    await Promise.resolve();
    state.settings = { ...state.settings, ...structuredClone(patch) };
  });

  await Promise.all([
    harness.remove('dsh', '/sessions/dsh'),
    harness.remove('codex', '/sessions/codex')
  ]);

  assert.deepEqual(saves, [{ codex: ['/sessions/codex'] }, {}]);
  assert.deepEqual(harness.state.settings.customScanPaths, {});
});
