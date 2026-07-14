'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  defaultViewDisplayPreferences,
  hasViewDisplayPreferences,
  moveViewDisplayOrder,
  normalizeHiddenViews,
  normalizeViewDisplayOrder,
  orderedViews,
  preferredViewId,
  reorderViewDisplayOrder,
  visibleViewOrder
} = require('../../src/electron/renderer/viewDisplayPreferences');

const views = [
  { id: 'tool', label: 'Tools' },
  { id: 'device', label: 'Devices' },
  { id: 'model', label: 'Models' },
  { id: 'session', label: 'Sessions' },
  { id: 'limits', label: 'Limits' }
];

function extractViewIds(source, constantName) {
  const mappedMatch = source.match(new RegExp(`const ${constantName} = \\[([^\\]]+)\\]\\.map`));
  if (mappedMatch) {
    return [...mappedMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  }

  const literalMatch = source.match(new RegExp(`const ${constantName} = \\[([\\s\\S]*?)\\];`));
  if (literalMatch) {
    return [...literalMatch[1].matchAll(/id:\s*'([^']+)'/g)].map((match) => match[1]);
  }

  assert.fail(`Could not find ${constantName}`);
}

test('defaultViewDisplayPreferences hides the Status view by default', () => {
  assert.deepEqual(defaultViewDisplayPreferences(), {
    viewDisplayOrder: '',
    hiddenViews: 'status'
  });
});

test('main default settings use the default view display preferences', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  assert.match(mainSource, /defaultViewDisplayPreferences/);
  assert.match(mainSource, /hiddenViews:\s*defaultViewDisplayPreferences\(\)\.hiddenViews/);
  assert.match(mainSource, /projectsEnabled:\s*parseBoolean\(process\.env\.TOKEN_MONITOR_PROJECTS_ENABLED, false\)/);
});

test('main default settings include independent Home module preferences', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  assert.match(mainSource, /defaultHomeModulePreferences/);
  assert.match(mainSource, /homeModuleOrder:\s*defaultHomeModulePreferences\(\)\.homeModuleOrder/);
  assert.match(mainSource, /hiddenHomeModules:\s*defaultHomeModulePreferences\(\)\.hiddenHomeModules/);
  assert.match(mainSource, /homeLimitProviderOrder:\s*''/);
  assert.match(mainSource, /function migrateHomeLimitProviderOrder/);
  assert.match(mainSource, /homeLimitProviderOrder:\s*patch\.homeLimitProviderOrder !== undefined \? migrateHomeLimitProviderOrder\(patch\.homeLimitProviderOrder\) : \(settings\.homeLimitProviderOrder \|\| ''\)/);
  assert.match(mainSource, /hiddenHomeLimitProviders:\s*''/);
});

test('main and renderer keep their view display options in sync', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

  assert.deepEqual(
    extractViewIds(mainSource, 'DEFAULT_VIEW_LIST'),
    extractViewIds(rendererSource, 'VIEW_DISPLAY_OPTIONS')
  );
});

test('normalizeViewDisplayOrder drops invalid entries and appends missing views', () => {
  assert.deepEqual(
    normalizeViewDisplayOrder('model,unknown,model,tool', views),
    ['model', 'tool', 'device', 'session', 'limits']
  );
});

test('normalizeHiddenViews keeps known hidden views but never hides every view', () => {
  assert.equal(normalizeHiddenViews('model,unknown,model,session', views), 'model,session');
  assert.equal(normalizeHiddenViews('tool,device,model,session,limits', views), '');
});

test('orderedViews returns view objects in saved display order', () => {
  assert.deepEqual(
    orderedViews(views, 'session,tool').map((view) => view.id),
    ['session', 'tool', 'device', 'model', 'limits']
  );
});

test('moveViewDisplayOrder swaps a view with its neighbor only when possible', () => {
  assert.equal(
    moveViewDisplayOrder('tool,device,model,session,limits', views, 'model', 'up'),
    'tool,model,device,session,limits'
  );
  assert.equal(
    moveViewDisplayOrder('tool,device,model,session,limits', views, 'tool', 'up'),
    'tool,device,model,session,limits'
  );
});

test('reorderViewDisplayOrder moves a view to a target index', () => {
  assert.equal(
    reorderViewDisplayOrder('tool,device,model,session,limits', views, 'session', 0),
    'session,tool,device,model,limits'
  );
  assert.equal(
    reorderViewDisplayOrder('tool,device,model,session,limits', views, 'tool', 99),
    'device,model,session,limits,tool'
  );
  assert.equal(
    reorderViewDisplayOrder('tool,device,model,session,limits', views, 'unknown', 1),
    'tool,device,model,session,limits'
  );
});

test('visibleViewOrder applies order, hidden views, and runtime availability', () => {
  assert.deepEqual(
    visibleViewOrder({
      views,
      orderValue: 'session,limits,tool,device,model',
      hiddenValue: 'device',
      availableIds: ['tool', 'device', 'model', 'session']
    }),
    ['session', 'tool', 'model']
  );
});

test('visibleViewOrder temporarily includes a directly opened hidden view in configured order', () => {
  assert.deepEqual(
    visibleViewOrder({
      views,
      orderValue: 'session,limits,tool,device,model',
      hiddenValue: 'device,session',
      availableIds: ['tool', 'device', 'model', 'session'],
      includeIds: ['device']
    }),
    ['tool', 'device', 'model']
  );
});

test('visibleViewOrder falls back to the first available view when preferences hide every available view', () => {
  assert.deepEqual(
    visibleViewOrder({
      views,
      orderValue: 'limits,tool,device,model,session',
      hiddenValue: 'tool,device,model,session',
      availableIds: ['tool', 'device', 'model', 'session']
    }),
    ['tool']
  );
});

test('preferredViewId can use the first visible view for cold startup', () => {
  assert.equal(
    preferredViewId({
      views,
      orderValue: 'limits,tool,device,model,session',
      hiddenValue: '',
      availableIds: ['tool', 'device', 'model', 'session', 'limits'],
      currentId: 'tool',
      preferFirst: true
    }),
    'limits'
  );
});

test('preferredViewId preserves an explicit current view when it is still visible', () => {
  assert.equal(
    preferredViewId({
      views,
      orderValue: 'limits,tool,device,model,session',
      hiddenValue: '',
      availableIds: ['tool', 'device', 'model', 'session', 'limits'],
      currentId: 'model',
      preferFirst: false
    }),
    'model'
  );
});

test('hasViewDisplayPreferences detects custom order or hidden views', () => {
  assert.equal(hasViewDisplayPreferences('', '', views), false);
  assert.equal(hasViewDisplayPreferences('unknown', '', views), false);
  assert.equal(hasViewDisplayPreferences('', 'unknown', views), false);
  assert.equal(hasViewDisplayPreferences('session,tool', '', views), true);
  assert.equal(hasViewDisplayPreferences('', 'model', views), true);
});
