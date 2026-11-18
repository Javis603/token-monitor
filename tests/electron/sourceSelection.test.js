'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { limitProviderEntry, LIMIT_PROVIDER_FETCHERS } = require('../../src/shared/limits/registry');
const { defaultAccountValues, accountValuesFingerprint } = require('../../src/shared/limits/accountSlots');
const { normalizeAccountPatch, finalAccountSettings, initialAccountSettings, limitsAccountConfig, accountFieldProjection, limitConnectionSourcesForRenderer } = require('../../src/electron/limits/accountSettings');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { transport } = require('../fixtures/accountSlotsBatch');
const ids = ['ollama', 'trae', 'cline', 'manus', 'hark', 'grok', 'codex', 'claude', 'alibaba', 'volcengine', 'cursor'];
for (const id of ids) test(`${id}: preference validates, defaults, projects and preserves credential fingerprint`, () => {
  const entry = limitProviderEntry(id), key = `${id}SourcePreference`;
  const chosen = entry.sourceSelection.sources[0];
  assert.equal(initialAccountSettings({})[key], 'auto');
  assert.equal(limitsAccountConfig({}, { env: {} })[key], 'auto');
  for (const invalid of ['complement', {}, ['api'], null, 'toString']) {
    const normalized = {}; normalizeAccountPatch({ [key]: invalid }, normalized);
    assert.equal(normalized[key], 'auto');
    assert.equal(accountFieldProjection({[key]:invalid}, {})[key], 'auto');
    assert.equal(limitsAccountConfig({ [key]: invalid }, { env: {} })[key], 'auto');
  }
  const normalized = {}; normalizeAccountPatch({ [key]: chosen }, normalized);
  const saved = finalAccountSettings(normalized, {});
  assert.equal(saved[key], chosen);
  assert.equal(accountFieldProjection(saved, {})[key], chosen);
  assert.equal(limitsAccountConfig(saved, { env: {} })[key], chosen);
  assert.equal(accountValuesFingerprint(defaultAccountValues(entry, {}, {})), accountValuesFingerprint(defaultAccountValues(entry, saved, {})));
});

test('only implemented exclusive lanes are exposed; complements stay independent', () => {
  const dto = limitConnectionSourcesForRenderer();
  assert.deepEqual(dto.find(x => x.id === 'claude').sourceSelection.sources, ['oauth', 'cli']);
  assert.equal(dto.find(x => x.id === 'deepseek').sourceSelection, undefined);
  for (const id of ids) {
    const entry = dto.find(x => x.id === id);
    assert.equal(entry.sourceSelection.key, `${id}SourcePreference`);
    assert.ok(entry.sourceSelection.sources.every(id => entry.sources.find(s => s.id === id)?.relation === 'alternative'));
  }
});
const response = body => ({ ok: true, status: 200, json: async () => body, text: async () => body });
const jwt = id => `e30.${Buffer.from(JSON.stringify({user_id:id,email:`${id}@test.dev`})).toString('base64url')}.c2lnbmF0dXJl`;
const harkToken = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb+/=';
const harkBody = { plan:{id:'free'}, meters:{harkTokens:{dailyUsed:1,dailyLimit:10,poolUsed:1,poolLimit:100}} };

for (const [id, field, token, body, discovery] of [
  ['manus','manusSessionToken',jwt('one'),require('../fixtures/manusAvailableCredits.json'), {readManusDesktopSession: () => ({token:jwt('desktop'),userId:'desktop'})}],
  ['hark','harkCookie',harkToken,harkBody,{readHarkDesktopSession: () => harkToken.replace(/^a/,'c')}]
]) {
  test(`${id}: saved, environment and discovered dispatch honor explicit source without credential substitution`, async () => {
    const key = `${id}SourcePreference`, entry = limitProviderEntry(id), seen = [];
    const deps = {env:{}, ...discovery, fetch:async (_url,init) => { seen.push(init.headers);return response(body); }};
    const saved = {[key]:'web',[`${id}AccountSlots`]:[{id:'saved',values:{[field]:token}}]};
    const web = await LIMIT_PROVIDER_FETCHERS[id](saved, deps);
    assert.equal(web.find(x => !x.removed && x.status === 'ok')?.source, 'web');
    assert.equal(seen.length,1);
    assert.equal(id === 'manus' ? seen[0].Authorization : seen[0].Cookie, id === 'manus' ? `Bearer ${token}` : `__Secure-hark.session_token=${token}`);
    seen.length=0;
    const local = await LIMIT_PROVIDER_FETCHERS[id]({...saved,[key]:'local'}, deps);
    assert.equal(local.find(x => !x.removed && x.status === 'ok')?.source, 'local');
    assert.equal(seen.length,1);
    const desktopToken = id === 'manus' ? jwt('desktop') : harkToken.replace(/^a/,'c');
    assert.equal(id === 'manus' ? seen[0].Authorization : seen[0].Cookie, id === 'manus' ? `Bearer ${desktopToken}` : `__Secure-hark.session_token=${desktopToken}`);
    assert.notEqual(web.find(x=>x.status==='ok').accountKey,local.find(x=>x.status==='ok').accountKey);
    seen.length=0;
    const envName = id === 'manus' ? 'MANUS_SESSION_TOKEN' : 'HARK_COOKIE';
    const envToken = id === 'manus' ? jwt('environment') : harkToken.replace(/^a/,'d');
    const envRows = await LIMIT_PROVIDER_FETCHERS[id]({[key]:'web'}, {...deps,env:{[envName]:envToken}});
    assert.equal(id === 'manus' ? seen[0].Authorization : seen[0].Cookie, id === 'manus' ? `Bearer ${envToken}` : `__Secure-hark.session_token=${envToken}`);
    assert.ok(envRows.some(x => x.status==='ok' && x.source==='web'));
    let desktopReads=0;
    const rejected = await entry.fetchLimits({[field]:token,[key]:'web'}, {...deps,fetch:async()=>({ok:false,status:401}), [id === 'manus'?'readManusDesktopSession':'readHarkDesktopSession']:()=>{desktopReads++;throw Error('unexpected');}});
    assert.equal(rejected.status,'unauthorized');assert.equal(desktopReads,0);
  });
  test(`${id}: slot probe ignores persisted local preference and rejects the draft itself`, async () => {
    let settings = {[`${id}SourcePreference`]:'local'};let reads=0,calls=0;
    const service = createAccountSlotService({getSettings:()=>settings,env:{},write:async patch=>{settings={...settings,...patch};},probeDeps:()=>({...discovery,
      [id === 'manus'?'readManusDesktopSession':'readHarkDesktopSession']:()=>{reads++;return id==='manus'?{token:jwt('other'),userId:'other'}:harkToken;},
      fetch:async()=>{calls++;return {ok:false,status:401};}})});
    const result=await service.add(id,{[field]:token});
    assert.equal(result.saved,false);assert.equal(result.verdict,'invalid');
    assert.equal(calls,1);assert.ok(reads <= 1, 'post-probe account DTO may read discovery but cannot validate the rejected draft');assert.equal(settings[`${id}AccountSlots`],undefined);
  });
}

test('Ollama forces web/API requests, shares proven identity and never falls back on rejection', async () => {
  const entry=limitProviderEntry('ollama'), seen=[];
  const options={ollamaApiKey:'key-a',ollamaCookie:'session=cookie',ollamaSourcePreference:'web'};
  const fetch=async(url,init)=>{seen.push([url,init.headers]);return response(String(url).endsWith('/me')?{email:'one@test.dev'}:String(url).endsWith('/balance')?{included:{balance_usd:5,allowance_usd:10}}:'<span id="header-email">one@test.dev</span><section>Weekly usage<span>10% used</span></section>');};
  const web=await entry.fetchLimits(options,{env:{},fetch,bypassValidationCache:true});
  assert.equal(web.status,'ok');assert.equal(String(seen[0][0]),'https://ollama.com/settings');
  const api=await entry.fetchLimits({...options,ollamaSourcePreference:'api'},{env:{},fetch});
  assert.equal(api.status,'ok');assert.equal(api.accountKey,web.accountKey);
  seen.length=0;
  const bad=await entry.fetchLimits({...options,ollamaSourcePreference:'api'},{env:{},fetch:async url=>{seen.push(url);return {ok:false,status:401};}});
  assert.equal(bad.status,'unauthorized');assert.equal(seen.length,1);assert.ok(seen[0].endsWith('/balance'));
  const missing=await entry.fetchLimits({ollamaCookie:'session=cookie',ollamaSourcePreference:'api'},{env:{},fetch:()=>assert.fail('wrong lane')});
  assert.equal(missing.status,'notConfigured');
});

test('Trae web and IDE route selection uses the actual selected credential',async()=>{
  const fetcher=limitProviderEntry('trae').fetchLimits, seen=[];
  const options={traeCookie:'sessionid=a',traeAccessToken:'legacy',traeSourcePreference:'ide'};
  const ide=await fetcher(options,{env:{},fetch:async(url,init)=>{seen.push([url,init]);return response({user_entitlement_pack_list:[{entitlement_base_info:{quota:{credits_limit:100}},usage:{credits_amount:10}}]});}});
  assert.equal(ide.status,'ok');assert.equal(ide.sourceDetail,'ide');assert.match(seen[0][1].headers.Authorization,/legacy/);
  assert.equal(seen.length,1);
  const web=await fetcher({...options,traeSourcePreference:'web'},{env:{},fetch:transport('trae')});
  assert.equal(web.source,'web');assert.equal(web.status,'ok');
});

test('Cline discovered credential is isolated from API preference and bad drafts never read local sign-in',async()=>{
  const entry=limitProviderEntry('cline');let calls=0;
  const options={clineApiKey:'bad',clineSourcePreference:'local'};
  const deps={env:{},fetch:async()=>{calls++;return {ok:false,status:401};}};
  assert.equal((await entry.fetchLimits(options,deps)).status,'notConfigured');assert.equal(calls,0);
  assert.equal((await entry.fetchLimits(options,{...deps,probe:true})).status,'unauthorized');assert.equal(calls,1);
  const local=await entry.fetchLimits({clineSourcePreference:'local'},{...deps,clineCredential:{source:'oauth',accessToken:'workos:local',accountId:'local'}});
  assert.equal(local.status,'unauthorized');assert.equal(local.source,'oauth');
});

test('Codex explicit OAuth does not fall back; app and CLI honor returned provenance',async()=>{
  const fetcher=limitProviderEntry('codex').fetchLimits;let rpc=0,oauth=0;
  const deps={env:{},readFileSync:()=>{throw Error('no auth');},readCodexUsage:async()=>{oauth++;throw Object.assign(Error('rejected'),{status:'unauthorized'});},
    readCodexRpc:async()=>{rpc++;return {sourceDetail:'cli',account:{email:'one@test.dev'},rateLimits:{primary:{usedPercent:20,windowDurationMins:300}}};}};
  await assert.rejects(fetcher({codexSourcePreference:'oauth'},deps), {status:'unauthorized'});assert.equal(rpc,0);
  const cli=await fetcher({codexSourcePreference:'cli'},deps);
  assert.equal(cli.status,'ok');assert.equal(cli.sourceDetail,'cli');assert.equal(oauth,1);
  await assert.rejects(fetcher({codexSourcePreference:'app'},deps), {status:'unavailable'});assert.equal(oauth,1);
});

test('Grok explicit RPC failure stops, web skips RPC, both keep OIDC subject identity',async()=>{
  const token=`e30.${Buffer.from(JSON.stringify({iss:'https://auth.x.ai',sub:'one'})).toString('base64url')}.sig`;
  const fetcher=limitProviderEntry('grok').fetchLimits;let rpc=0,web=0;
  const billing={creditUsagePercent:10,currentPeriod:{start:'2026-11-03T00:00:00Z',end:'2026-11-10T00:00:00Z'}};
  const deps={env:{},grokHome:'/private/tmp/source-grok-fixture',readFileSync:()=>JSON.stringify({'https://auth.x.ai::fixture':{key:token}}),
    fetchRpcBilling:async()=>{rpc++;return billing;},fetchWebGrpcBilling:async()=>{web++;return [{kind:'billing',usedPercent:10}];}};
  const a=await fetcher({grokSourcePreference:'rpc'},deps);const b=await fetcher({grokSourcePreference:'web'},deps);
  assert.equal(a.status,'ok');assert.equal(b.status,'ok');assert.equal(a.accountKey,b.accountKey);assert.equal(rpc,1);assert.equal(web,1);
  const failed=await fetcher({grokSourcePreference:'rpc'},{...deps,fetchRpcBilling:async()=>{throw Error('offline');}});
  assert.equal(failed.status,'unavailable');assert.equal(web,1);
});


function documentFixture() {
  const nodes=[];
  return { nodes, createTextNode:textContent=>({textContent}), createElement(tag) {
    const node={tag,children:[],dataset:{},textContent:'',value:'',disabled:false,append(...children){this.children.push(...children);},setAttribute(key,value){this[key]=value;},addEventListener(event,fn){this[event]=fn;}};
    nodes.push(node);return node;
  }};
}
test('renderer select saves through validated settings and reads canonical preference back; failed save restores the accepted option',async()=>{
  const {createConnectionCard}=require('../../src/electron/renderer/limits/connectionPresentation');
  const {translate}=require('../../src/electron/renderer/i18n');
  const entry=limitConnectionSourcesForRenderer().find(x=>x.id==='ollama');
  const document=documentFixture();let persisted={};let reject=false;
  const onSelect=async patch=>{
    if(reject) throw Error('disk unavailable');
    const normalized={};normalizeAccountPatch(patch,normalized);
    persisted=finalAccountSettings(normalized,persisted);
    return accountFieldProjection(persisted,{}).ollamaSourcePreference;
  };
  const render=()=>createConnectionCard({document,t:(key,params)=>translate('zh-TW',key,params),sources:entry.sources,provider:{},label:'Ollama',selection:entry.sourceSelection,preference:persisted.ollamaSourcePreference,onSelect});
  render();const select=document.nodes.find(x=>x.tag==='select');
  assert.equal(select['aria-label'], `${translate('zh-TW','settings.limits.connection.title')} · Ollama`);
  assert.deepEqual(select.children.map(x=>x.value),['auto','api','web']);
  assert.equal(select.value,'auto');select.value='web';await select.change();
  assert.equal(persisted.ollamaSourcePreference,'web');assert.equal(limitsAccountConfig(persisted,{env:{}}).ollamaSourcePreference,'web');
  assert.ok(document.nodes.some(x=>x.textContent===translate('zh-TW','settings.limits.sources.selected',{source:translate('zh-TW',entry.sources.find(x=>x.id==='web').labelKey)})));
  render();assert.equal(document.nodes.filter(x=>x.tag==='select').at(-1).value,'web');
  reject=true;select.value='api';await select.change();
  assert.equal(select.value,'web');assert.equal(select.disabled,false);assert.equal(persisted.ollamaSourcePreference,'web');
  assert.ok(document.nodes.some(x=>x.role==='status' && x.textContent===translate('zh-TW','settings.limits.sources.saveFailed')));
  const unsupported=documentFixture();
  createConnectionCard({document:unsupported,t:key=>key,sources:limitProviderEntry('claude').sources,provider:{},label:'Claude',onSelect});
  assert.ok(!unsupported.nodes.some(x=>x.tag==='select'));
});

test('Ollama slot API draft bypasses the stored web preference and cannot be vouched for by a Cookie',async()=>{
  let settings={ollamaSourcePreference:'web',ollamaCookie:'session=old'};let calls=0;
  const service=createAccountSlotService({getSettings:()=>settings,env:{OLLAMA_API_KEY:'unrelated'},write:async patch=>{settings={...settings,...patch};},probeDeps:()=>({fetch:async(url,init)=>{
    calls++;assert.ok(String(url).endsWith('/balance'));assert.equal(init.headers.Authorization,'Bearer rejected-key');assert.equal(init.headers.Cookie,undefined);return {ok:false,status:401};
  }})});
  const result=await service.add('ollama',{ollamaApiKey:'rejected-key'});
  assert.equal(result.saved,false);assert.equal(calls,1);assert.equal(settings.ollamaCookie,'session=old');assert.equal(settings.ollamaSourcePreference,'web');
});

test('Cline real discovery, saved and environment keys stay separate under source filtering',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-cline-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'settings'));
  fs.writeFileSync(path.join(dir,'settings/providers.json'),JSON.stringify({providers:{cline:{settings:{auth:{accessToken:'workos:local',accountId:'user-local'}}}}}));
  const seen=[];
  const fetch=async(url,init)=>{
    const token=init.headers.Authorization;seen.push(token);
    return response(String(url).endsWith('/me')?{data:{id:token.includes('saved')?'user-saved':'user-env'}}:String(url).includes('usage-limits')?{success:true,data:{limits:[{type:'weekly',percentUsed:10}]}}:{});
  };
  const options={clineAccountSlots:[{id:'saved',values:{clineApiKey:'key-saved'}}]};
  const deps={env:{CLINE_DATA_DIR:dir,CLINE_API_KEY:'key-env'},fetch};
  const service=createAccountSlotService({getSettings:()=>options,env:deps.env,probeDeps:()=>deps});
  const slots=service.list('cline').accounts;
  assert.deepEqual(slots.find(slot=>slot.source==='discovered').collectionSources,['local']);
  assert.deepEqual(slots.find(slot=>slot.id==='saved').collectionSources,['api']);
  assert.deepEqual(slots.find(slot=>slot.source==='environment').collectionSources,['api']);
  const local=await LIMIT_PROVIDER_FETCHERS.cline({...options,clineSourcePreference:'local'},deps);
  assert.ok(local.some(x=>x.status==='ok' && x.source==='oauth'));
  assert.ok(seen.every(x=>x==='Bearer workos:local'));
  seen.length=0;
  const api=await LIMIT_PROVIDER_FETCHERS.cline({...options,clineSourcePreference:'api'},deps);
  assert.equal(api.filter(x=>x.status==='ok').length,2);
  assert.ok(seen.includes('Bearer key-saved'));assert.ok(seen.includes('Bearer key-env'));assert.ok(!seen.includes('Bearer workos:local'));
});

test('Codex actual RPC candidate dispatch never spawns the opposite selected executable',async()=>{
  const fetcher=limitProviderEntry('codex').fetchLimits;
  for (const [selection,command] of [['app','codex'],['cli','/Applications/Codex.app/Contents/Resources/codex']]) {
    await assert.rejects(fetcher({codexSourcePreference:selection},{env:{},codexCommand:command,readFileSync:()=>{throw Error('no auth');},spawn:()=>assert.fail('opposite executable must not run')}),{status:'notConfigured'});
  }
});

test('source selection DTO projects only public selector fields', () => {
  const declaration = limitProviderEntry('cursor').sourceSelection;
  declaration.privateResolver = 'main-only';
  try {
    const selection = limitConnectionSourcesForRenderer().find(entry => entry.id === 'cursor').sourceSelection;
    assert.deepEqual(Object.keys(selection).sort(), ['autoDescriptionKey', 'autoLabelKey', 'key', 'sources']);
    assert.equal(selection.privateResolver, undefined);
  } finally {
    delete declaration.privateResolver;
  }
});
