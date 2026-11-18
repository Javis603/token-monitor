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
test('connection source preference and declared choices invalidate settings render signature', () => {
  const app=fs.readFileSync(path.join(__dirname,'../../src/electron/renderer/app.js'),'utf8');
  const body=app.slice(app.indexOf('function limitProviderSettingsRenderSignature('),app.indexOf('function limitProviderSettingsList('));
  const state={settings:{limitConnectionSources:[{id:'grok',sourceSelection:{key:'grokSourcePreference',sources:['rpc','web']}}]}};
  const context={state,LIMIT_PROVIDER_SETTINGS:{},currentLocale:()=> 'en',enabledLimitProviderSet:()=>new Set(),limitProviderOrderApi:{orderedLimitProviders:()=>[]},desktopLimitProviders:()=>[],limitProviderUsageItemRows:()=>[],limitProviderQuery:()=>''};
  const signature=()=>vm.runInNewContext(body+'\nlimitProviderSettingsRenderSignature()',context);
  const before=signature();state.settings.grokSourcePreference='web';
  assert.notEqual(signature(),before);
  const selected=signature();state.settings.limitConnectionSources[0].sourceSelection.sources=['rpc'];
  assert.notEqual(signature(),selected);
});
