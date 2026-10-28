'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPluginSettingsStore, MAX_BYTES } = require('../../src/electron/plugins/settings');
const { normalizeSettings } = require('../../src/shared/plugins/settings');
const schema = normalizeSettings({ version: 1, fields: [{ id: 'count', type: 'number', label: 'Count', default: 2, min: 0 }] });
function fixture(t, injected = fs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-author-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createPluginSettingsStore({ directory, fs: injected }) };
}
function record(directory, values, version = 1) {
  fs.writeFileSync(path.join(directory, 'alpha.json'), JSON.stringify({ formatVersion: 1, schemaVersion: version, revision: 4, values }));
}

test('defaults are read-only projection, saves are isolated and restart durable with revision CAS', t => {
  const { directory, store } = fixture(t);
  assert.equal(store.get('alpha', schema).values.count, 2); assert.deepEqual(fs.readdirSync(directory), []);
  const saved = store.save('alpha', schema, { revision: 0, values: { count: 7 } });
  assert.equal(saved.revision, 1); assert.equal(store.get('beta', schema).revision, 0);
  assert.deepEqual(createPluginSettingsStore({ directory }).get('alpha', schema), saved);
  assert.throws(() => store.save('alpha', schema, { revision: 0, values: { count: 8 } }), /settings-conflict/);
  assert.throws(() => store.update('alpha', schema, { schemaVersion: 2, expectedRevision: 1, patch: {} }), /settings-conflict/);
  assert.equal(store.get('alpha', schema).values.count, 7);
  saved.values.count = 99; assert.equal(store.get('alpha', schema).values.count, 7);
});

for (const failure of ['writeFileSync', 'renameSync']) test(`${failure} failure preserves prior bytes, revision, values and removes temporary files`, t => {
  let fail = false;
  const injected = Object.create(fs);
  injected[failure] = (...args) => { if (fail) throw Object.assign(new Error('disk failure'), { code: 'EIO' }); return fs[failure](...args); };
  const { directory, store } = fixture(t, injected);
  const original = store.save('alpha', schema, { revision: 0, values: { count: 5 } });
  const bytes = fs.readFileSync(path.join(directory, 'alpha.json'), 'utf8'); fail = true;
  assert.throws(() => store.save('alpha', schema, { revision: 1, values: { count: 8 } }), /disk failure/);
  assert.deepEqual(store.get('alpha', schema), original);
  assert.equal(fs.readFileSync(path.join(directory, 'alpha.json'), 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(directory), ['alpha.json']);
  fail = false; assert.equal(store.save('alpha', schema, { revision: 1, values: { count: 8 } }).revision, 2);
});

test('migration, reset and downgrade preserve unknown data; invalid old values require explicit repair', t => {
  const { directory, store } = fixture(t);
  record(directory, { count: 'old-invalid', future: { retained: true } });
  assert.equal(store.get('alpha', schema).status, 'invalid');
  assert.throws(() => store.save('alpha', schema, { revision: 4, values: {} }), /invalid-settings-values/);
  const next = store.reset('alpha', schema, { revision: 4 }); assert.equal(next.values.count, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'alpha.json'))).values.future, { retained: true });
  const newer = normalizeSettings({ version: 2, fields: [{ id: 'size', type: 'number', label: 'Size', default: 1 }], migrations: [{ fromVersion: 1, renames: { count: 'size' } }] });
  assert.equal(store.get('alpha', newer).values.size, 2);
  store.save('alpha', newer, { revision: 5, values: { size: 9 } });
  assert.equal(store.get('alpha', schema).readOnly, true);
  const bytes = fs.readFileSync(path.join(directory, 'alpha.json'), 'utf8');
  assert.throws(() => store.reset('alpha', schema, { revision: 6 }), /settings-newer-schema/);
  assert.equal(fs.readFileSync(path.join(directory, 'alpha.json'), 'utf8'), bytes);
  assert.equal(store.get('alpha', newer).values.size, 9);
});

test('corrupt, oversized, symlinked and non-file stores fail closed; unsafe ids rejected', t => {
  const { directory, store } = fixture(t); const file = path.join(directory, 'alpha.json');
  for (const bytes of ['{', '{}', ' '.repeat(MAX_BYTES + 1)]) {
    fs.writeFileSync(file, bytes); assert.throws(() => store.get('alpha', schema));
    assert.throws(() => store.save('alpha', schema, { revision: 0, values: {} })); assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
  fs.unlinkSync(file); fs.mkdirSync(file); assert.throws(() => store.get('alpha', schema)); fs.rmdirSync(file);
  const target = path.join(directory, 'target'); fs.writeFileSync(target, '{}'); fs.symlinkSync(target, file);
  assert.throws(() => store.get('alpha', schema)); assert.equal(fs.readFileSync(target, 'utf8'), '{}');
  for (const id of ['../alpha', 'a/b', 'A', '']) assert.throws(() => store.get(id, schema), /invalid-plugin-id/);
});

test('quota failure keeps compatibility data untouched and explicit remove only affects one plugin', t => {
  const { directory, store } = fixture(t);
  record(directory, { old: 'x'.repeat(MAX_BYTES - 90) });
  const bytes = fs.readFileSync(path.join(directory, 'alpha.json'), 'utf8');
  assert.ok(Buffer.byteLength(bytes) <= MAX_BYTES);
  const large = normalizeSettings({ version: 1, fields: [{ id: 'text', type: 'string', label: 'Text', default: 'x'.repeat(4096) }] });
  assert.throws(() => store.save('alpha', large, { revision: 4, values: {} }), /settings-quota/);
  assert.equal(fs.readFileSync(path.join(directory, 'alpha.json'), 'utf8'), bytes);
  store.save('beta', schema, { revision: 0, values: {} }); store.remove('alpha');
  assert.equal(store.get('beta', schema).revision, 1); assert.equal(store.get('alpha', schema).revision, 0);
});

test('public transport budget is enforced before commit for every writer', t => {
  const { directory, store } = fixture(t);
  const { publicSettings, MAX_PUBLIC_BYTES } = require('../../src/electron/plugins/settings');
  const wide = normalizeSettings({ version: 1, fields: Array.from({ length: 20 }, (_, i) => ({ id: `text${i}`, type: 'string', label: 'Text', default: '' })) });
  const original = store.update('alpha', wide, { schemaVersion: 1, expectedRevision: 0, patch: {} });
  const bytes = fs.readFileSync(path.join(directory, 'alpha.json'), 'utf8');
  const patch = Object.fromEntries(wide.fields.map(field => [field.id, '漢'.repeat(4096)]));
  assert.throws(() => store.update('alpha', wide, { schemaVersion: 1, expectedRevision: 1, patch }), /settings-payload-too-large/);
  assert.equal(fs.readFileSync(path.join(directory, 'alpha.json'), 'utf8'), bytes);
  const dto = publicSettings(original); assert.equal(dto.schema, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(dto)) <= MAX_PUBLIC_BYTES);
  dto.values.text0 = 'mutated'; assert.equal(store.get('alpha', wide).values.text0, '');
});
