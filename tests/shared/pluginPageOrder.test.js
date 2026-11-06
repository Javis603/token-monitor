'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeNotchPageOrder, orderNotchPages, mergeNotchPageOrder, MAX_NOTCH_PAGES } = require('../../src/shared/plugins/placements');
const { buildNotchData } = require('../../src/electron/notch/data');

test('mixed Notch order is bounded, canonical and nonthrowing for malformed values', () => {
  assert.deepEqual(normalizeNotchPageOrder(['PLUGIN:DEMO/MAIN', 'home', 'bad', 'home', { toString: 0 }, null]), ['plugin:demo/main', 'home']);
  assert.deepEqual(normalizeNotchPageOrder(null), []);
  const refs = Array.from({ length: 1100 }, (_, i) => `plugin:demo/page${i}`);
  assert.equal(normalizeNotchPageOrder(refs).length, MAX_NOTCH_PAGES + 4);
});
test('mixed order filters unavailable ids and appends new pages without resetting saved positions', () => {
  const order = ['plugin:demo/main', 'limits', 'plugin:missing/main', 'home'];
  assert.deepEqual(orderNotchPages(['home', 'limits', 'sessions', 'plugin:demo/main'], order), ['plugin:demo/main', 'limits', 'home', 'sessions']);
  assert.deepEqual(orderNotchPages(['home', 'limits'], []), ['home', 'limits']);
  assert.deepEqual(mergeNotchPageOrder(order, ['home', 'plugin:demo/main', 'limits']), ['home', 'plugin:demo/main', 'plugin:missing/main', 'limits']);
  assert.deepEqual(orderNotchPages(['home', 'limits', 'plugin:demo/main'], mergeNotchPageOrder(order, ['home', 'plugin:demo/main', 'limits'])), ['home', 'plugin:demo/main', 'limits']);
});
test('retained missing pages cannot crowd current selections out of the order bound', () => {
  const old = Array.from({ length: 1028 }, (_, i) => `plugin:old/page${i}`);
  const current = ['plugin:demo/main', 'home', 'limits', 'sessions', 'breakdown'];
  const merged = mergeNotchPageOrder(old, current);
  assert.equal(merged.length, 1028);
  assert.deepEqual(orderNotchPages(current, merged), current);
});
test('panel projection carries order separately from visibility and global plugin enable state', () => {
  const settings = { notchBuiltinPages: ['limits'], notchPluginPages: ['demo/main'], notchPageOrder: ['plugin:demo/main', 'limits', 'home'] };
  const first = buildNotchData({ periods: {} }, [], settings).panel;
  assert.deepEqual(first.pageOrder, settings.notchPageOrder);
  assert.deepEqual(first.builtinPages, ['limits']);
  assert.deepEqual(first.pluginPages, ['demo/main']);
  const off = buildNotchData({ periods: {} }, [], { ...settings, pluginsEnabled: false }).panel;
  assert.deepEqual(off.pluginPages, []);
  assert.deepEqual(off.pageOrder, settings.notchPageOrder);
});
