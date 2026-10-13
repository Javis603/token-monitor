'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  { id: 'session', label: 'Sessions' },
  { id: 'trends', label: 'Activity' }
];

test('defaultHomeModulePreferences includes Sessions and shows it by default', () => {
  assert.equal(DEFAULT_HOME_MODULE_ORDER, 'limits,tool,model,session,modelspeed,device,trends');
  assert.deepEqual(defaultHomeModulePreferences(), {
    homeModuleOrder: 'limits,tool,model,session,modelspeed,device,trends',
    hiddenHomeModules: 'tool,device'
  });
});

test('main and renderer Home module options follow the default order', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const mainMatch = mainSource.match(/const DEFAULT_HOME_MODULE_LIST = \[([^\]]+)\]\.map/);
  const rendererMatch = rendererSource.match(/const HOME_MODULE_OPTIONS = \[([\s\S]*?)\];/);
  assert.ok(mainMatch);
  assert.ok(rendererMatch);
  const mainIds = [...mainMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const rendererIds = [...rendererMatch[1].matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(mainIds, DEFAULT_HOME_MODULE_ORDER.split(','));
  assert.deepEqual(rendererIds, mainIds);
});

test('default Home module preferences show Sessions in the overview', () => {
  const hidden = new Set(defaultHomeModulePreferences().hiddenHomeModules.split(','));
  assert.deepEqual(
    orderedHomeModules(modules, defaultHomeModulePreferences().homeModuleOrder)
      .map((module) => module.id)
      .filter((id) => !hidden.has(id)),
    ['limits', 'model', 'session', 'trends']
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

test('legacy Home settings append Sessions visibly while preserving hidden modules', () => {
  const order = normalizeHomeModuleOrder('model,limits,trends,tool,device', modules);
  const hidden = new Set(normalizeHiddenHomeModules('tool,device', modules).split(','));
  assert.deepEqual(order.filter((id) => !hidden.has(id)), ['model', 'limits', 'trends', 'session']);
  assert.equal(normalizeHiddenHomeModules('', modules), '');
});
