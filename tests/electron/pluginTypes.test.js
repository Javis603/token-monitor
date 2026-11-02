'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {pluginTypes,normalizeTypes}=require('../../src/electron/plugins/types');
test('types derive from actual surfaces/targets and optional skins',()=>{
 assert.deepEqual(pluginTypes({views:[{surfaces:['home','notch','page']}],skins:[{}]}),['widget','page','appearance']);
 assert.deepEqual(pluginTypes({views:[{targets:['main.limits.content']}]}),['page']);
 assert.deepEqual(pluginTypes({views:[{surfaces:['settings']}]}),[]);
 assert.deepEqual(normalizeTypes(['page','bogus','page']),['page']);
});

test('automation classification requires explicit purpose, independently of background support', () => {
  assert.deepEqual(pluginTypes({ backend: 'backend.cjs', background: true }), []);
  assert.deepEqual(pluginTypes({ category: 'automation' }), ['automation']);
  assert.deepEqual(pluginTypes({ category: 'automation', views: [{ surfaces: ['home', 'page'] }] }), ['widget', 'page', 'automation']);
  assert.deepEqual(normalizeTypes(['automation', 'unknown', 'page', 'automation']), ['page', 'automation']);
});

test('remote catalog hints retain automation without starting or granting background work', () => {
  const { parseIndex } = require('../../src/electron/plugins/catalogSources');
  const index = parseIndex(Buffer.from(JSON.stringify({ format: 1, title: 'Fixture', plugins: [{ id: 'automation-fixture', name: 'Fixture', versions: [{
    version: '1.0.0', url: 'https://fixture.invalid/automation.tmplugin', sha256: '0'.repeat(64), types: ['automation']
  }] }] })));
  assert.deepEqual(index.plugins[0].versions[0].types, ['automation']);
});

test('production metadata labels render automation in all six languages without changing existing labels', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { Element } = require('../helpers/notchPanel');
  const { translate, MESSAGES } = require('../../src/electron/renderer/i18n');
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/pluginSettings.js'), 'utf8');
  const helper = source.match(/ {2}function el\(document,[\s\S]*?\n {2}\}/)?.[0];
  const renderer = source.match(/ {4}function typeLabels\(plugin\) \{[\s\S]*?\n {4}\}/)?.[0];
  assert.ok(helper && renderer);
  const document = { createElement: tag => new Element(tag) };
  const expected = { en: 'Automation', 'zh-TW': '自動化', 'zh-CN': '自动化', ko: '자동화', ja: '自動化', 'pt-BR': 'Automação' };
  for (const [locale, label] of Object.entries(expected)) {
    assert.equal(MESSAGES[locale]['plugins.type.automation'], label);
    const context = vm.createContext({ document, t: key => translate(locale, key) });
    vm.runInContext(`${helper}\n${renderer}`, context);
    const badge = context.typeLabels({ types: ['automation'] });
    assert.equal(badge.children.length, 1);
    assert.equal(badge.children[0].textContent, label);
    assert.equal(badge.children[0].className, 'plugin-type plugin-type-automation');
    const old = context.typeLabels({ types: ['widget', 'page', 'appearance'] });
    assert.deepEqual(old.children.map(node => node.textContent), ['widget', 'page', 'appearance'].map(type => translate(locale, `plugins.type.${type}`)));
    assert.equal(context.typeLabels({}).children.length, 0);
  }
});
