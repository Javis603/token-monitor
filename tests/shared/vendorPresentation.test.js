'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_VENDOR_COLOR,
  MARK_IDS,
  ROW_ICON_MASKS,
  VENDOR_IDS,
  VENDOR_LABELS,
  VENDOR_PRESENTATION,
  trayIconFile,
  vendorColors,
  widgetVendorPalette
} = require('../../src/shared/vendorPresentation');
const { rowIconMaskRules } = require('../../src/electron/renderer/rowIconMasks');

const iconsDir = path.join(__dirname, '..', '..', 'assets', 'icons');
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

test('each mark id appears once and names only safe characters', () => {
  // rowIconMasks.js writes ids and file stems into CSS unquoted.
  assert.equal(new Set(MARK_IDS).size, MARK_IDS.length, 'duplicate vendor entries');
  for (const entry of VENDOR_PRESENTATION) {
    for (const value of [entry.id, entry.icon, entry.mask, entry.trayIcon].filter(Boolean)) {
      assert.match(value, /^[a-z0-9-]+$/, `${entry.id}: ${value}`);
    }
  }
});

test('every artwork file an entry names exists', () => {
  for (const entry of VENDOR_PRESENTATION) {
    for (const file of new Set([ROW_ICON_MASKS[entry.id], trayIconFile(entry.id), entry.icon || entry.id])) {
      assert.ok(fs.existsSync(path.join(iconsDir, `${file}.svg`)), `${entry.id} needs assets/icons/${file}.svg`);
    }
  }
});

test('every coloured vendor has a label, from the catalog or its own entry', () => {
  for (const id of VENDOR_IDS) {
    assert.ok(VENDOR_LABELS[id], `${id} needs a label: add it to the entry, or it is not a catalog client`);
  }
  assert.equal(VENDOR_LABELS.default, 'Default');
});

test('the widget fields say something the brand colour does not', () => {
  for (const entry of VENDOR_PRESENTATION) {
    if (entry.color) assert.match(entry.color, HEX, `${entry.id} color`);
    if (entry.widgetColor) {
      assert.match(entry.widgetColor, HEX, `${entry.id} widgetColor`);
      assert.notEqual(entry.widgetColor.toLowerCase(), entry.color?.toLowerCase(), `${entry.id}: drop a widgetColor equal to color`);
    }
    assert.ok(!(entry.widgetInk && entry.widgetColor), `${entry.id}: widgetInk and widgetColor contradict`);
  }
});

test('vendorColors hands out a fresh map with the default last', () => {
  const first = vendorColors();
  first.claude = '#123456';
  const second = vendorColors();
  assert.notEqual(second.claude, '#123456', 'overrides applied to one copy must not leak into the next');
  assert.deepEqual(Object.keys(second), [...VENDOR_IDS, 'default']);
  assert.equal(second.default, DEFAULT_VENDOR_COLOR);
});

test('the widget palette omits entries that restate the defaults', () => {
  const palette = widgetVendorPalette();
  assert.deepEqual(palette.default, { color: DEFAULT_VENDOR_COLOR });
  assert.equal(palette.newapi, undefined);
  assert.deepEqual(palette.grok, { ink: true });
  assert.deepEqual(palette.hermes, { color: '#d4af37', icon: 'hermes-agent' });
});

test('one mask rule is installed per mark id', () => {
  const rules = rowIconMaskRules('../../../assets/icons/').split('\n');
  assert.equal(rules.length, MARK_IDS.length);
  assert.ok(rules.includes('.row-icon-grok { -webkit-mask-image: url(../../../assets/icons/xai.svg); mask-image: url(../../../assets/icons/xai.svg); }'));
});
