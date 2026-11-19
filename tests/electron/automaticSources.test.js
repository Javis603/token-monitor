'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limits/providers');
const { limitProviderEntry } = require('../../src/shared/limits/registry');
const { initialAccountSettings, limitsAccountConfig, limitConnectionSourcesForRenderer } = require('../../src/electron/limits/accountSettings');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');

test('collection sources are automatic: no provider registers a source preference setting', () => {
  const initial = initialAccountSettings({});
  const config = limitsAccountConfig({}, { env: {} });
  for (const id of LIMIT_PROVIDER_IDS) {
    assert.equal(`${id}SourcePreference` in initial, false, id);
    assert.equal(`${id}SourcePreference` in config, false, id);
    assert.equal(limitProviderEntry(id).fields.some(field => field.key === `${id}SourcePreference`), false, id);
  }
  for (const entry of limitConnectionSourcesForRenderer()) assert.deepEqual(Object.keys(entry).sort(), ['id', 'sources'], entry.id);
});

const jwt = id => `e30.${Buffer.from(JSON.stringify({user_id:id,email:`${id}@test.dev`})).toString('base64url')}.c2lnbmF0dXJl`;
const harkToken = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb+/=';

for (const [id, field, token, discovery] of [
  ['manus','manusSessionToken',jwt('one'), {readManusDesktopSession: () => ({token:jwt('desktop'),userId:'desktop'})}],
  ['hark','harkCookie',harkToken,{readHarkDesktopSession: () => harkToken.replace(/^a/,'c')}]
]) {
  test(`${id}: slot probe rejects the draft itself without reading the desktop session`, async () => {
    let settings = {};let reads=0,calls=0;
    const service = createAccountSlotService({getSettings:()=>settings,env:{},write:async patch=>{settings={...settings,...patch};},probeDeps:()=>({...discovery,
      [id === 'manus'?'readManusDesktopSession':'readHarkDesktopSession']:()=>{reads++;return id==='manus'?{token:jwt('other'),userId:'other'}:harkToken;},
      fetch:async()=>{calls++;return {ok:false,status:401};}})});
    const result=await service.add(id,{[field]:token});
    assert.equal(result.saved,false);assert.equal(result.verdict,'invalid');
    assert.equal(calls,1);assert.ok(reads <= 1, 'post-probe account DTO may read discovery but cannot validate the rejected draft');assert.equal(settings[`${id}AccountSlots`],undefined);
  });
}

test('Ollama slot API draft cannot be vouched for by a saved Cookie',async()=>{
  let settings={ollamaCookie:'session=old'};let calls=0;
  const service=createAccountSlotService({getSettings:()=>settings,env:{OLLAMA_API_KEY:'unrelated'},write:async patch=>{settings={...settings,...patch};},probeDeps:()=>({fetch:async(url,init)=>{
    calls++;assert.ok(String(url).endsWith('/balance'));assert.equal(init.headers.Authorization,'Bearer rejected-key');assert.equal(init.headers.Cookie,undefined);return {ok:false,status:401};
  }})});
  const result=await service.add('ollama',{ollamaApiKey:'rejected-key'});
  assert.equal(result.saved,false);assert.equal(calls,1);assert.equal(settings.ollamaCookie,'session=old');
});
