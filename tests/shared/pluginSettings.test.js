'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSettings, applySettingsPatch, prepareSettings } = require('../../src/shared/plugins/settings');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const raw = () => ({ version: 1, fields: [
  { id: 'grid', type: 'boolean', label: 'Grid', default: true },
  { id: 'width', type: 'number', label: 'Width', default: 2, min: 1, max: 20, integer: true },
  { id: 'note', type: 'string', label: { en: 'Note' }, default: '', maxLength: 20 },
  { id: 'mode', type: 'select', label: 'Mode', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }
] });

test('settings schema validates defaults and manifest fails closed on invalid declarations', () => {
  const manifest = { id: 'demo', name: 'Demo', version: '1.0.0', tmApi: 1, backend: 'main.js', files: ['main.js'], settings: raw() };
  assert.equal(normalizeManifest(manifest).manifest.settings.version, 1);
  for (const patch of [{ default: 'true' }, { id: 'constructor' }, { id: 'toString' }, { id: undefined }, { type: 'secret' }]) {
    const schema = raw(); Object.assign(schema.fields[0], patch);
    assert.throws(() => normalizeSettings(schema), /invalid-settings-schema/);
    assert.equal(normalizeManifest({ ...manifest, settings: schema }).ok, false);
  }
  for (const mutate of [s => s.fields.push(s.fields[0]), s => s.fields[1].min = 50,
    s => s.fields[2].maxLength = 5000, s => s.fields[3].options.push(s.fields[3].options[0]),
    s => s.version = 0, s => s.migrations = [{ fromVersion: 1, renames: { grid: 'other' } }]]) {
    const schema = raw(); mutate(schema); assert.throws(() => normalizeSettings(schema));
  }
});

test('typed validation never coerces and unknown or prototype fields cannot be written', () => {
  const schema = normalizeSettings(raw());
  for (const patch of [{ grid: 1 }, { width: '2' }, { width: NaN }, { width: 2.5 }, { width: 21 },
    { note: 'x'.repeat(21) }, { mode: 'c' }, { hidden: 3 }, JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: 1 }]) {
    assert.throws(() => applySettingsPatch(schema, null, patch), error => error.code === 'invalid-settings-values' && Object.keys(error.fields).length > 0);
  }
  const values = applySettingsPatch(schema, null, { grid: false, width: 3, note: 'ok', mode: 'b' });
  assert.deepEqual(values, { grid: false, width: 3, note: 'ok', mode: 'b' });
});

test('declarative migrations copy without deletion or overwrite, validate, and do not mutate inputs', () => {
  const source = raw(); source.version = 3; source.migrations = [
    { fromVersion: 1, renames: { oldNote: 'middle' } }, { fromVersion: 2, renames: { middle: 'note' } }
  ];
  const schema = normalizeSettings(source);
  const stored = { schemaVersion: 1, values: { oldNote: 'kept', opaque: { keep: true } } };
  const before = JSON.stringify(stored);
  const projected = prepareSettings(schema, stored);
  assert.equal(projected.values.note, 'kept'); assert.equal(projected.values.opaque, undefined);
  const saved = applySettingsPatch(schema, stored, { width: 4 });
  assert.deepEqual(saved.opaque, { keep: true }); assert.equal(saved.oldNote, 'kept');
  assert.equal(JSON.stringify(stored), before);
  assert.equal(prepareSettings(schema, { schemaVersion: 1, values: { oldNote: 'old', note: 'new' } }).values.note, 'new');
  const invalid = { schemaVersion: 1, values: { oldNote: 'x'.repeat(21) } };
  assert.equal(prepareSettings(schema, invalid).errors.note, 'length');
  assert.throws(() => applySettingsPatch(schema, invalid, { width: 4 }), /invalid-settings-values/);
  assert.equal(applySettingsPatch(schema, invalid, { note: 'fixed' }).oldNote, 'x'.repeat(21));
});
