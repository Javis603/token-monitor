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
test('content selectors and backend Tray menu are explicit contracts; navigation replacement is rejected', () => {
  const view = { id: 'metric', targets: ['main.model.content'], selector: '.row-value' };
  const manifest = { ...fixture, views: [view], trayMenu: [{ id: 'refresh', label: 'Refresh' }] };
  assert.equal(normalizeManifest(manifest).ok, true);
  for (const selector of ['', true, [], 'x'.repeat(501)]) assert.equal(normalizeManifest({ ...manifest, views: [{ ...view, selector }] }).ok, false);
  assert.equal(normalizeManifest({ ...manifest, views: [{ ...view, targets: ['main.navigation.content'], mode: 'replace' }] }).ok, false);
  for (const trayMenu of [[{ id: true, label: 'Bad' }], [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], new Array(33).fill({ id: 'a', label: 'A' })]) assert.equal(normalizeManifest({ ...manifest, trayMenu }).ok, false);
  assert.equal(normalizeManifest({ ...manifest, backend: null }).ok, false);
});
