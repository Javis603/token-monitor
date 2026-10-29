'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareSkinSettings } = require('../../src/electron/plugins/skinSettings');

test('preparing a skin merges declared colors and snapshots normalized appearance without mutating inputs', () => {
  const current = { themeColors: { accent: '#112233', text: '#ffffff' },
    vendorColors: { claude: '#123456', codex: '#654321' } };
  const skin = { ref: 'author/blue', colors: { accent: '#abcdef', chart: '#aabbcc' },
    vendorColors: { claude: '#fedcba' }, appearance: { font: 'mono', colors: { accent: '#ABCDEF' } } };
  const before = structuredClone({ current, skin });
  const prepared = prepareSkinSettings(current, skin);
  assert.deepEqual(prepared, { authorSkin: { ref: 'author/blue', appearance: {
    font: 'mono', density: 'standard', corners: 'rounded', panel: 'plain', colors: { accent: '#abcdef' }
  } }, patch: {
    themeColors: { accent: '#abcdef', text: '#ffffff', chart: '#aabbcc' },
    vendorColors: { claude: '#fedcba', codex: '#654321' }
  } });
  assert.deepEqual({ current, skin }, before);
  prepared.patch.themeColors.text = '#000000';
  prepared.patch.vendorColors.codex = '#000000';
  prepared.authorSkin.appearance.colors.accent = '#000000';
  assert.deepEqual({ current, skin }, before, 'prepared settings must not alias live settings or author appearance');
});

test('a color-only skin supplies default appearance and preserves unspecified vendor colors', () => {
  const prepared = prepareSkinSettings({ vendorColors: { claude: '#123456' } },
    { ref: 'author/colors', colors: { accent: '#abcdef' } });
  assert.deepEqual(prepared.patch, { themeColors: { accent: '#abcdef' }, vendorColors: { claude: '#123456' } });
  assert.deepEqual(prepared.authorSkin, { ref: 'author/colors', appearance: {
    font: 'inherit', density: 'standard', corners: 'rounded', panel: 'plain', colors: {}
  } });
});

test('an appearance-only skin preserves theme colors while replacing the previous appearance snapshot', () => {
  const current = { themeColors: { accent: '#112233' }, vendorColors: {},
    pluginAuthorSkin: { ref: 'other/skin', appearance: { font: 'mono' } } };
  const prepared = prepareSkinSettings(current, { ref: 'author/compact', appearance: { density: 'compact' } });
  assert.deepEqual(prepared.patch, { themeColors: { accent: '#112233' }, vendorColors: {} });
  assert.deepEqual(prepared.authorSkin, { ref: 'author/compact', appearance: {
    font: 'inherit', density: 'compact', corners: 'rounded', panel: 'plain', colors: {}
  } });
  assert.equal(current.pluginAuthorSkin.ref, 'other/skin');
});
