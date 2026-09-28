'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_HOME_MODULE_ORDER,
  defaultHomeModulePreferences,
  migrateHiddenHomeModules,
  moveHomeModuleOrder,
  normalizeHiddenHomeModules,
  normalizeHomeModuleOrder,
  orderedHomeModules,
  reorderHomeModuleOrder
} = require('../../src/electron/renderer/homeModulePreferences');

const modules = [
  { id: 'limits', label: 'Limits' },
  { id: 'tool', label: 'Tools' },
  { id: 'device', label: 'Devices' },
  { id: 'model', label: 'Models' },
  { id: 'session', label: 'Sessions' },
  { id: 'trends', label: 'Activity' }
];

test('defaultHomeModulePreferences includes Sessions but hides it by default', () => {
  assert.equal(DEFAULT_HOME_MODULE_ORDER, 'limits,tool,device,model,session,trends');
  assert.deepEqual(defaultHomeModulePreferences(), {
    homeModuleOrder: 'limits,tool,device,model,session,trends',
    hiddenHomeModules: 'tool,device,session'
  });
});

test('default Home module preferences show the original overview modules first', () => {
  const hidden = new Set(defaultHomeModulePreferences().hiddenHomeModules.split(','));
  assert.deepEqual(
    orderedHomeModules(modules, defaultHomeModulePreferences().homeModuleOrder)
      .map((module) => module.id)
      .filter((id) => !hidden.has(id)),
    ['limits', 'model', 'trends']
  );
});

test('normalizeHomeModuleOrder drops invalid ids and appends missing modules', () => {
  assert.deepEqual(
    normalizeHomeModuleOrder('device,unknown,device,limits', modules),
    ['device', 'limits', 'tool', 'model', 'session', 'trends']
  );
});

test('normalizeHiddenHomeModules keeps known ids but never hides every Home module', () => {
  assert.equal(normalizeHiddenHomeModules('tool,unknown,tool,trends', modules), 'tool,trends');
  assert.equal(normalizeHiddenHomeModules('limits,tool,device,model,session,trends', modules), '');
});

test('orderedHomeModules returns module objects in saved order', () => {
  assert.deepEqual(
    orderedHomeModules(modules, 'device,limits').map((module) => module.id),
    ['device', 'limits', 'tool', 'model', 'session', 'trends']
  );
});

test('moveHomeModuleOrder and reorderHomeModuleOrder update saved order', () => {
  assert.equal(
    moveHomeModuleOrder('limits,tool,device,model,session,trends', modules, 'device', 'up'),
    'limits,device,tool,model,session,trends'
  );
  assert.equal(
    reorderHomeModuleOrder('limits,tool,device,model,session,trends', modules, 'trends', 1),
    'limits,trends,tool,device,model,session'
  );
});

test('existing saved orders gain Sessions without dropping a custom order', () => {
  assert.deepEqual(
    normalizeHomeModuleOrder('model,limits,trends,tool,device', modules),
    ['model', 'limits', 'trends', 'tool', 'device', 'session']
  );
});

test('legacy Home settings hide Sessions while preserving previous visibility', () => {
  assert.equal(migrateHiddenHomeModules('tool,device', 'limits,tool,device,model,trends', modules), 'tool,device,session');
  assert.equal(migrateHiddenHomeModules('', 'model,limits,trends,tool,device', modules), 'session');
  assert.equal(migrateHiddenHomeModules('tool,device', 'limits,tool,device,model,session,trends', modules), 'tool,device');
});
