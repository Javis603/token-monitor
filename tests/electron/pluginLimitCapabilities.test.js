'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const { localize } = require('../../src/shared/plugins/localized');
const { pluginLimitCapabilityTags } = require('../../src/electron/renderer/limits/providerPresentation');
const { translate } = require('../../src/electron/renderer/i18n');
const base = { tmApi: 1, id: 'sample-quota', name: 'Example', version: '1.0.0', backend: 'backend.cjs', files: ['backend.cjs'] };
const parse = module => normalizeManifest({ ...base, limits: [{ id: 'quota', name: 'Quota', ...module }] });
test('capability declarations have a closed vocabulary and stable order, without changing execution', () => {
  const result = parse({ capabilities: ['cli', 'oauth', 'apiKey', 'web', 'api'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.limits[0].capabilities, ['api', 'apiKey', 'oauth', 'web', 'cli']);
  assert.equal(result.manifest.background, false);
  assert.equal(result.manifest.limits[0].connection, null);
  for (const capabilities of [['Auto'], ['manual'], ['local'], ['relay'], ['desktopApp'], ['api', 'api'], 'api', [null]]) assert.equal(parse({ capabilities }).ok, false);
});
test('custom labels are author text, localized, optional and bounded', () => {
  const result = parse({ tags: [{ en: 'Our team', 'zh-TW': '自訂名稱' }, '自由填寫'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.limits[0].tags.map(tag => localize(tag, 'zh-TW')), ['自訂名稱', '自由填寫']);
  assert.equal(localize(result.manifest.limits[0].tags[0], 'ko'), 'Our team');
  for (const tags of [['a', 'b', 'c'], [''], [{}], [42], ['x'.repeat(17)], [{ en: 'Short', 'zh-TW': '長'.repeat(17) }], 'Text']) assert.equal(parse({ tags }).ok, false);
  assert.equal(parse({ tags: ['😀'.repeat(16)] }).ok, true);
  assert.equal(parse({ tags: ['Local'] }).ok, true);
});
test('adapter-derived capabilities deduplicate, authors choose sources, host owns automatic sampling', () => {
  const module = { connection: 'openai', capabilities: ['web', 'oauth', 'cli'], tags: ['自訂方案'], sampling: true };
  assert.deepEqual(pluginLimitCapabilityTags(module).map(tag => tag.label), ['Auto', 'OAuth/Web/CLI', '自訂方案']);
  assert.deepEqual(pluginLimitCapabilityTags({ ...module, sampling: false }).map(tag => tag.label), ['OAuth/Web/CLI', '自訂方案']);
  assert.deepEqual(pluginLimitCapabilityTags({ connection: 'openai' }).map(tag => tag.label), ['Web']);
});
test('API key uses existing translation and supersedes redundant API; custom text is not interpreted as status', () => {
  const tags = pluginLimitCapabilityTags({ capabilities: ['api', 'apiKey'], tags: ['中轉站'] });
  assert.equal(tags[0].key, 'settings.limits.capability.apiKey');
  assert.equal(translate('zh-TW', tags[0].key), 'API 金鑰');
  assert.deepEqual(tags[1], { label: '中轉站', kind: 'custom' });
});
test('limits module IDs do not coerce missing or non-string values', () => {
  for (const id of [undefined, true, false, null, 123, {}, ['quota']]) {
    const result = normalizeManifest({ ...base, limits: [{ id, name: 'Quota' }] });
    assert.equal(result.ok, false, String(id));
  }
});
