'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const fixture = require('../fixtures/trusted-plugin/manifest.json');
test('trusted manifest supports UI/backend, all surfaces, content extensions and localized metadata', () => {
  const result = normalizeManifest(fixture); assert.equal(result.ok, true); assert.equal(result.manifest.apiMajor, 1);
  assert.equal(result.manifest.views[0].surfaces.length, 6); assert.equal(result.manifest.views[1].mode, 'replace');
});
for (const patch of [{tmApi:2},{tmApi:0},{tmApi:undefined},{tmApi:'1'},{tmApi:'^1'},{permissions:[]},{main:'old.js'},{webUi:{}},{files:['../escape.js']},{backend:'undeclared.cjs'},{css:['undeclared.css']},{views:[{id:true}]},{views:[{id:'one',surfaces:['unknown']}]},{files:['ui.mjs','UI.mjs']}]) test(`invalid/incompatible metadata rejects ${JSON.stringify(patch)}`, () => {
  assert.equal(normalizeManifest({...fixture,...patch}).ok, false);
});
test('backend-only and skin-only packages need no renderer views', () => {
  assert.equal(normalizeManifest({...fixture,ui:undefined,views:[]}).ok,true);
  assert.equal(normalizeManifest({tmApi:1,id:'my-skin',name:'Style',version:'1.0.0',skins:[{id:'blue',name:'Blue',colors:{accent:'#123456'}}]}).ok,true);
});

test('background purpose is author-supplied localized text and requires declared support', () => {
  const backgroundDescription = { en: 'Refresh usage periodically.', 'zh-TW': '定期更新用量資料。' };
  const result = normalizeManifest({ ...fixture, background: true, backgroundDescription });
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.backgroundDescription, backgroundDescription);
  for (const patch of [{ background: false }, { backend: null }, { backgroundDescription: 42 }, { backgroundDescription: {} }]) {
    assert.equal(normalizeManifest({ ...fixture, background: true, backgroundDescription, ...patch }).ok, false);
  }
});

test('one plugin provides one replacement per target; composition uses plugin settings', () => {
  const view = { id: 'main', mode: 'replace', targets: ['main.home.content'] };
  const duplicate = normalizeManifest({ ...fixture, views: [view, { ...view, id: 'compact' }] });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors.join(' '), /only one replacement view per target/);
  assert.equal(normalizeManifest({ ...fixture, views: [view, { ...view, id: 'model', targets: ['main.model.content'] }] }).ok, true);
});
test('content selectors and backend Tray menu are explicit contracts; navigation replacement is rejected', () => {
  const view = { id: 'metric', targets: ['main.model.content'], selector: '.row-value' };
  const manifest = { ...fixture, views: [view], trayMenu: [{ id: 'refresh', label: 'Refresh' }] };
  assert.equal(normalizeManifest(manifest).ok, true);
  for (const selector of ['', true, [], 'x'.repeat(501)]) assert.equal(normalizeManifest({ ...manifest, views: [{ ...view, selector }] }).ok, false);
  assert.equal(normalizeManifest({ ...manifest, views: [{ ...view, targets: ['main.navigation.content'], mode: 'replace' }] }).ok, false);
  for (const trayMenu of [[{ id: true, label: 'Bad' }], [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], new Array(33).fill({ id: 'a', label: 'A' })]) assert.equal(normalizeManifest({ ...manifest, trayMenu }).ok, false);
  assert.equal(normalizeManifest({ ...manifest, backend: null }).ok, false);
});

test('omitted defaults suggest only replacement views and leave background and appearance unchanged', () => {
  const views = [
    { id: 'append', mode: 'append', targets: ['main.home.content', 'main.model.content'] },
    { id: 'replace', mode: 'replace', targets: ['main.home.content', 'main.session.content'] },
    { id: 'decorate', mode: 'decorate', targets: ['main.limits.content'] }
  ];
  const input = { ...fixture, background: true, views };
  delete input.defaults;
  const before = structuredClone(input);
  const result = normalizeManifest(input);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(result.manifest.defaults, { content: {
    'main.home.content': 'replace', 'main.session.content': 'replace'
  }, background: false, skin: null });
  assert.deepEqual(input, before);
});

test('partial content defaults preserve explicit native content and infer other declared replacements', () => {
  const result = normalizeManifest({ ...fixture, views: [
    { id: 'home', mode: 'replace', targets: ['main.home.content'] },
    { id: 'model', mode: 'replace', targets: ['main.model.content'] }
  ], defaults: { content: { 'main.home.content': null } } });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(result.manifest.defaults, { content: {
    'main.home.content': null, 'main.model.content': 'model'
  }, background: false, skin: null });
});

for (const [label, defaults] of [
  ['array defaults', []], ['string defaults', 'default'], ['boolean defaults', true],
  ['unknown setting', { placements: [] }], ['null content', { content: null }],
  ['array content', { content: [] }], ['string content', { content: 'content' }],
  ['qualified view reference', { content: { 'main.home.content': 'trusted-fixture/content' } }],
  ['non-replacement target', { content: { 'main.model.content': null } }],
  ['non-boolean background', { background: 1 }], ['null background', { background: null }],
  ['unknown skin', { skin: 'missing' }], ['non-string skin', { skin: false }]
]) test(`first-use manifest defaults reject ${label}`, () => {
  const result = normalizeManifest({ ...fixture,
    views: [{ id: 'content', mode: 'replace', targets: ['main.home.content'] }], defaults });
  assert.equal(result.ok, false);
  assert.equal(result.manifest, null);
  assert.ok(result.errors.some(error => /defaults/.test(error)), result.errors.join('; '));
});

for (const [label, support] of [
  ['no backend', { backend: null, trayMenu: [], background: true }],
  ['background disabled', { background: false }], ['background omitted', { background: undefined }]
]) test(`background suggestions require support: ${label}`, () => {
  const input = { ...fixture, ...support };
  const rejected = normalizeManifest({ ...input, defaults: { background: true } });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.includes('defaults.background requires background support'));
  const disabled = normalizeManifest({ ...input, defaults: { background: false } });
  assert.equal(disabled.ok, true, disabled.errors.join('; '));
  assert.equal(disabled.manifest.defaults.background, false);
});

test('background purpose text is cleaned and bounded before it reaches review metadata', () => {
  const result = normalizeManifest({ ...fixture, background: true,
    backgroundDescription: `  Refresh\n${'x'.repeat(500)}  ` });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(result.manifest.backgroundDescription, { '': `Refresh ${'x'.repeat(392)}` });
  assert.equal(normalizeManifest({ ...fixture, background: true, backgroundDescription: ' \n\t ' }).ok, false);
});
