'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_HOME_MODULE_ORDER,
  defaultHomeModulePreferences,
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
  { id: 'trends', label: 'Activity' }
];

test('defaultHomeModulePreferences keeps the full Home module order and hides new modules', () => {
  assert.equal(DEFAULT_HOME_MODULE_ORDER, 'limits,tool,device,model,trends,liveRate');
  assert.deepEqual(defaultHomeModulePreferences(), {
    homeModuleOrder: 'limits,tool,device,model,trends,liveRate',
    hiddenHomeModules: 'tool,device,liveRate'
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
    ['device', 'limits', 'tool', 'model', 'trends']
  );
});

test('normalizeHiddenHomeModules keeps known ids but never hides every Home module', () => {
  assert.equal(normalizeHiddenHomeModules('tool,unknown,tool,trends', modules), 'tool,trends');
  assert.equal(normalizeHiddenHomeModules('limits,tool,device,model,trends', modules), '');
});

test('orderedHomeModules returns module objects in saved order', () => {
  assert.deepEqual(
    orderedHomeModules(modules, 'device,limits').map((module) => module.id),
    ['device', 'limits', 'tool', 'model', 'trends']
  );
});

test('moveHomeModuleOrder and reorderHomeModuleOrder update saved order', () => {
  assert.equal(
    moveHomeModuleOrder('limits,tool,device,model,trends', modules, 'device', 'up'),
    'limits,device,tool,model,trends'
  );
  assert.equal(
    reorderHomeModuleOrder('limits,tool,device,model,trends', modules, 'trends', 1),
    'limits,trends,tool,device,model'
  );
});
