'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pluginTypes, normalizeTypes } = require('../../src/electron/plugins/types');
const { parsePackage, describePackage } = require('../../src/electron/plugins/package');
const { parseIndex } = require('../../src/electron/plugins/catalogSources');
test('feature labels cover declared surfaces, page extensions and skins without implying execution', () => {
  for (const surface of ['home', 'tray', 'edgeDock', 'notch']) assert.deepEqual(pluginTypes({ views: [{ surfaces: [surface] }] }), ['widget']);
  assert.deepEqual(pluginTypes({ views: [{ surfaces: ['home', 'page'] }], skins: [{}] }), ['widget', 'page', 'appearance']);
  for (const target of ['model', 'tool', 'device', 'page']) assert.deepEqual(pluginTypes({ webUi: { documents: [{ target }] } }), ['page']);
  assert.deepEqual(pluginTypes({ main: 'main.js', background: {}, permissions: ['tm.pages', 'ui.web'], webUi: { documents: [{ target: 'settings' }] } }), []);
  assert.deepEqual(normalizeTypes(['official', 'page', 'page', 'widget', 'appearance']), ['widget', 'page', 'appearance']);
});
test('package preview derives labels from the manifest and ignores author supplied type claims', () => {
  const pkg = parsePackage(Buffer.from(JSON.stringify({ format: 1, manifest: { id: 'types-demo', name: 'Demo', version: '1.0.0', tmApi: '^1', types: ['appearance'], views: [{ id: 'view', title: 'Demo', surfaces: ['page'], layout: { type: 'text', value: 'Demo' } }] } })));
  assert.deepEqual(describePackage(pkg).types, ['page']);
});
test('catalog labels are optional per-version hints, bounded to known types', () => {
  const raw = { format: 1, title: 'Fixture', plugins: [{ id: 'types-demo', name: 'Demo', versions: [
    { version: '1.0.0', sha256: 'a'.repeat(64), url: 'https://example.test/v1.tmplugin' },
    { version: '2.0.0', sha256: 'b'.repeat(64), url: 'https://example.test/v2.tmplugin', types: ['page', 'widget', 'page', '<script>', 'official'] }
  ] }] };
  const versions = parseIndex(Buffer.from(JSON.stringify(raw))).plugins[0].versions;
  assert.deepEqual(versions.map(version => version.types), [['widget', 'page'], []]);
});
