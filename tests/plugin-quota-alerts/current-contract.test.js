'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../../plugins/quota-alerts/manifest.json');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');

test('current official host accepts first-use background suggestion and six purpose translations', () => {
  const result = normalizeManifest(manifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.manifest.defaults.background, true);
  assert.equal(result.manifest.background, true);
  assert.equal(result.manifest.category, 'automation');
  assert.deepEqual(result.manifest.views[0].surfaces, ['settings']);
  assert.deepEqual(result.manifest.views[0].defaultSurfaces, []);
  assert.equal(Object.keys(result.manifest.backgroundDescription).length, 6);
  assert.equal(Object.hasOwn(manifest, 'backgroundControl'), false);
  assert.match(manifest.backgroundDescription['zh-TW'], /保持運行/);
});
test('first-use suggestion never turns on quota monitoring, delivery or a visible placement', () => {
  const { defaults } = require('../../plugins/quota-alerts/preferences.cjs');
  assert.deepEqual([defaults.lowQuota, defaults.recovery], [false,false]);
  assert.deepEqual(Object.keys(manifest.defaults), ['background']);
  assert.equal(manifest.views.some(view => view.surfaces.some(surface => surface !== 'settings')), false);
});
test('official validator enforces background capability for purpose and first-use background', () => {
  assert.equal(normalizeManifest({ ...manifest, background: false }).ok, false);
  assert.equal(normalizeManifest({ ...manifest, backgroundDescription: { en: '' } }).ok, false);
  const result = normalizeManifest({ ...manifest, defaults: { background: false } });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.defaults.background, false);
});
