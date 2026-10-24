'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { normalizeAppearance } = require('../../src/shared/plugins/appearance');
const { createPluginAppearance } = require('../../src/electron/plugins/appearance');
test('legacy appearance is read without rewriting or deleting user data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-style-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'appearance.json'); const raw = '{"font":"mono","density":"comfortable","colors":{"accent":"#ABCDEF"}}'; fs.writeFileSync(file, raw);
  const store = createPluginAppearance({ file });
  assert.equal(store.get().font, 'mono'); assert.equal(store.get().colors.accent, '#abcdef');
  assert.equal(store.set, undefined); assert.equal(fs.readFileSync(file, 'utf8'), raw);
  const clone = store.get(); clone.colors.accent = '#000000'; assert.equal(store.get().colors.accent, '#abcdef');
});
test('skin tokens cannot carry markup, arbitrary CSS or network assets', () => {
  const value = normalizeAppearance({ css: 'body{display:none}', fontUrl: 'https://example.test/a.woff', colors: { text: '#ffffff', arbitrary: 'url(x)' } });
  assert.deepEqual(Object.keys(value).sort(), ['colors','corners','density','font','panel']);
  assert.deepEqual(value.colors, { text: '#ffffff' });
});
test('malformed stored style is reported without silently replacing the original', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-style-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'appearance.json'); fs.writeFileSync(file, '{broken');
  const store = createPluginAppearance({ file }); assert(store.state().error); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.equal(store.set, undefined);
});
