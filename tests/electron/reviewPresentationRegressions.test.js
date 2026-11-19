'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
for (const id of ['opencode','muse','openrouter']) test(`${id} account title honors the shared display name`, () => {
  const owner = require(`../../src/electron/renderer/providers/${id}/windows`)({namedApiAccountTitle:row=>row.accountName,limitAccountDefaultTitle:()=> 'Fallback'});
  assert.equal(owner.accountTitle({accountDisplayName:'Work',accountName:'Personal',source:'web'},0),'Work');
});
test('a reading switching source invalidates the settings render signature', () => {
  // The connection card highlights the sources fresh readings came through.
  const app=fs.readFileSync(path.join(__dirname,'../../src/electron/renderer/app.js'),'utf8');
  const body=app.slice(app.indexOf('function limitProviderSettingsRenderSignature('),app.indexOf('function limitProviderSettingsList('));
  const reading={provider:'codex',status:'ok',source:'oauth',sourceDetail:''};
  const state={settings:{},stats:{limits:{providers:[reading]}}};
  const local=[{provider:'codex',status:'ok',source:'oauth'}];
  const context={state,LIMIT_PROVIDER_SETTINGS:{},currentLocale:()=> 'en',enabledLimitProviderSet:()=>new Set(['codex']),strictLocalProviderStatuses:()=>local,limitProviderOrderApi:{orderedLimitProviders:()=>[]},desktopLimitProviders:()=>[],limitProviderUsageItemRows:()=>[],limitProviderQuery:()=>''};
  const signature=()=>vm.runInNewContext(body+'\nlimitProviderSettingsRenderSignature()',context);
  // This device's own rows can change while the Hub aggregate keeps another device's newer row.
  const aggregateOnly=signature();local[0].stale=true;
  assert.notEqual(signature(),aggregateOnly);
  const before=signature();Object.assign(reading,{source:'rpc',sourceDetail:'app'});
  assert.notEqual(signature(),before);
  const switched=signature();reading.stale=true;
  assert.notEqual(signature(),switched);
});
