'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const { pluginTypes } = require('../../src/electron/plugins/types');
const { createPluginLimits, desktopProviderPreference, normalizeReading } = require('../../src/electron/plugins/limits');
const order = require('../../src/electron/renderer/limits/providerOrder');
const manifest = { tmApi: 1, id: 'sample-plugin', name: 'Sample', version: '1.0.0', backend: 'index.cjs', files: ['index.cjs'], limits: [{ id: 'one', name: 'Claude' }, { id: 'two', name: 'Claude' }] };
test('declarations require backend, bounded unique IDs, derived Limits type', () => {
  const parsed = normalizeManifest(manifest); assert.equal(parsed.ok, true);
  assert.deepEqual(pluginTypes(parsed.manifest), ['limits']);
  assert.equal(normalizeManifest({ ...manifest, backend: undefined }).ok, false);
  assert.equal(normalizeManifest({ ...manifest, limits: [manifest.limits[0], manifest.limits[0]] }).ok, false);
  assert.equal(normalizeManifest({ ...manifest, limits: [{ id: 'one', name: 'X', connection: 'arbitrary' }] }).ok, false);
});
test('mixed namespaced preferences survive absent modules without entering built-in parser', () => {
  const ids = ['plugin:sample-plugin:two', 'claude', 'plugin:sample-plugin:one'];
  const providers = ids.map(id => ({ id, label: 'Claude' }));
  const raw = desktopProviderPreference(ids.join(','), value => String(value).split(',').filter(id => id === 'claude'));
  assert.deepEqual(raw.split(','), ids);
  assert.deepEqual(order.orderedLimitProviders(providers, ids).map(p => p.id), ids);
});
test('normalization projects fields and rejects bad windows', () => {
  assert.throws(() => normalizeReading({ status: 'ok', windows: [null] }, 'plugin:sample-plugin:one'));
  const value = normalizeReading({ status: 'ok', windows: [], authorization: 'synthetic' }, 'plugin:sample-plugin:one');
  assert.equal(value.authorization, undefined);
});
test('native demand samples two modules, drops late data on disable, resumes after revision update', async t => {
  let active = true, revision = 'a', calls = 0;
  const settings = { limitProviders: 'plugin:sample-plugin:one,plugin:sample-plugin:two', limitsEnabled: true };
  const manager = { list: () => ({ plugins: [{ id: manifest.id, status: active ? 'active' : 'disabled', revision, limits: manifest.limits }] }), call: async () => { calls++; return { status: 'ok', windows: [] }; } };
  const service = createPluginLimits({ manager, getSettings: () => settings, changed: () => {} }); t.after(() => service.dispose());
  service.reconcile(); assert.equal(calls, 0);
  service.demand(true);
  for (let n = 0; n < 20 && service.records().length < 2; n++) await new Promise(setImmediate);
  assert.equal(calls, 2); assert.equal(service.records().length, 2);
  active = false; service.reconcile(); assert.deepEqual(service.records(), []);
  active = true; revision = 'b'; service.reconcile();
  for (let n = 0; n < 20 && service.records().length < 2; n++) await new Promise(setImmediate);
  assert.equal(calls, 4); service.demand(false); assert.deepEqual(service.records(), []);
});
test('editing visible preferences while a plugin is disabled retains its selection and mixed-order slots', () => {
  const providers = [{ id: 'claude' }, { id: 'codex' }];
  const one = 'plugin:sample-plugin:one', two = 'plugin:sample-plugin:two';
  const saved = `${one},claude,${two},codex`;
  assert.deepEqual(order.absentPluginProviders(saved, providers), [one, two]);
  const selection = [...['codex'], ...order.absentPluginProviders(saved, providers)];
  assert.deepEqual(new Set(selection), new Set(['codex', one, two]));
  const moved = order.preserveAbsentPluginOrder(saved, ['codex', 'claude'], providers);
  assert.deepEqual(moved, [one, 'codex', two, 'claude']);
  assert.deepEqual(order.orderedLimitProviders([...providers, { id: one }, { id: two }], moved).map(row => row.id), moved);
});
