'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const fixture = require('../fixtures/trusted-plugin/manifest.json');
test('trusted manifest supports UI/backend, all surfaces, content extensions and localized metadata', () => {
  const result = normalizeManifest(fixture); assert.equal(result.ok, true); assert.equal(result.manifest.apiMajor, 2);
  assert.equal(result.manifest.views[0].surfaces.length, 6); assert.equal(result.manifest.views[1].mode, 'replace');
});
for (const patch of [{tmApi:1},{tmApi:'^2'},{permissions:[]},{main:'old.js'},{webUi:{}},{files:['../escape.js']},{backend:'undeclared.cjs'},{css:['undeclared.css']},{views:[{id:true}]},{views:[{id:'one',surfaces:['unknown']}]},{files:['ui.mjs','UI.mjs']}]) test(`invalid/incompatible metadata rejects ${JSON.stringify(patch)}`, () => {
  assert.equal(normalizeManifest({...fixture,...patch}).ok, false);
});
test('backend-only and skin-only packages need no renderer views', () => {
  assert.equal(normalizeManifest({...fixture,ui:undefined,views:[]}).ok,true);
  assert.equal(normalizeManifest({tmApi:2,id:'my-skin',name:'Style',version:'1.0.0',skins:[{id:'blue',name:'Blue',colors:{accent:'#123456'}}]}).ok,true);
});
