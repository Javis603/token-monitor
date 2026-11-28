'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {collect,activate,createBackend,profileDirectory}=require('../../plugins/qwen-chat-quota/backend.cjs');
const now=Date.now(), reset=now+86400000;
const good={httpCode:200,success:true,data:{status:'ACTIVE',remainingPercent:7,resetAt:reset,memberType:'plus'}};
const deps=extra=>({now:()=>now,readSession:()=>({token:'fixture-only',expiresAt:now+3600000}),fetch:async()=>Response.json(good),...extra});
test('reports the actual remaining weekly percentage and reset timestamp',async()=>{const r=await collect(deps());assert.equal(r.status,'ok');assert.equal(r.plan,'Plus');assert.equal(r.windows[0].usedPercent,93);assert.equal(r.windows[0].resetsAt,new Date(reset).toISOString());assert.equal(r.windows[0].kind,'weekly');});
test('zero remaining is valid and not mistaken for missing data',async()=>{const r=await collect(deps({fetch:async()=>Response.json({...good,data:{...good.data,remainingPercent:0}})}));assert.equal(r.status,'ok');assert.equal(r.windows[0].usedPercent,100);});
test('missing, malformed and out of range percentages cannot become 100% available',async()=>{for(const v of [undefined,null,'7',NaN,-1,101]){const r=await collect(deps({fetch:async()=>Response.json({...good,data:{...good.data,remainingPercent:v}})}));assert.equal(r.status,'unavailable');assert.deepEqual(r.windows,[]);}});
test('a missing or expired session never makes a network request',async()=>{for(const s of [null,{token:'fixture-only',expiresAt:now-1}]){const r=await collect(deps({readSession:()=>s,fetch:()=>{throw Error('must not call');}}));assert.equal(r.status,s?'unauthorized':'notConfigured');assert.deepEqual(r.windows,[]);}});
test('requests only the fixed official service with redirects disabled and timeout',async()=>{let called=false;await collect(deps({fetch:async(u,o)=>{called=true;assert.equal(new URL(u).origin,'https://sg-entitlement.qwen.com');assert.equal(new URL(u).pathname,'/api/entitlement/agent/usage');assert.equal(o.redirect,'error');assert.equal(o.headers.Authorization,'Bearer fixture-only');assert.ok(o.signal);assert.equal(o.method,'GET');return Response.json(good);}}));assert.ok(called);});
test('authentication and rate limit failures produce safe statuses',async()=>{for(const [http,status] of [[401,'unauthorized'],[403,'unauthorized'],[429,'rateLimited'],[500,'unavailable']]){const r=await collect(deps({fetch:async()=>new Response('fixture-secret',{status:http})}));assert.equal(r.status,status);assert.ok(!JSON.stringify(r).includes('fixture-secret'));}});
test('service login errors inside HTTP 200 are recognized',async()=>{const r=await collect(deps({fetch:async()=>Response.json({success:false,httpCode:401,errorCode:'NOT_LOGIN'})}));assert.equal(r.status,'unauthorized');});
test('network, non-JSON and profile failures are redacted',async()=>{for(const d of [{fetch:async()=>{throw Error('fixture-secret');}},{fetch:async()=>new Response('<html>fixture-secret</html>')},{readSession:()=>{throw Error('fixture-secret');}}]){const r=await collect(deps(d));assert.equal(r.status,'unavailable');assert.ok(!JSON.stringify(r).includes('fixture-secret'));}});
test('missing and elapsed reset dates fail closed',async()=>{for(const resetAt of [undefined,null,0,now-1,'tomorrow']){const r=await collect(deps({fetch:async()=>Response.json({...good,data:{...good.data,resetAt}})}));assert.equal(r.status,'unavailable');}});
test('large responses are rejected',async()=>{const r=await collect(deps({fetch:async()=>new Response('x'.repeat(131073),{headers:{'content-type':'application/json'}})}));assert.equal(r.status,'unavailable');});
test('backend implements the Token Monitor limits.collect interface',async()=>{const b=await activate({});await assert.rejects(()=>b.call('unknown',{}));await assert.rejects(()=>b.call('limits.collect',{moduleId:'unknown'}));});
test('native Token Monitor accepts notes for successful and failed readings',async()=>{const {normalizeNotes}=require('../../src/electron/plugins/quotaDetails');for(const d of [deps(),deps({readSession:()=>null}),deps({readSession:()=>({token:'fixture',expiresAt:now-1})}),deps({fetch:async()=>{throw Error('fixture');}})]){const r=await collect(d);assert.doesNotThrow(()=>normalizeNotes(r.notes));}});
test('production backend uses the injected host network transport',async()=>{
 let calls=0;
 const backend=createBackend({host:{async call(method,args){
  calls++;assert.equal(method,'network.request');assert.equal(args.moduleId,'subscription');assert.equal(args.requestId,'weekly-quota');assert.equal(args.timeoutMs,15000);assert.equal(args.method,'GET');
  assert.equal(new URL(args.url).origin,'https://sg-entitlement.qwen.com');assert.equal(args.headers.Authorization,'Bearer fixture-only');assert.equal(args.headers.Referer,undefined);
  return {status:200,headers:{'content-type':'application/json'},body:JSON.stringify(good)};
 }}},deps());
 const result=await backend.call('limits.collect',{moduleId:'subscription'});assert.equal(calls,1);assert.equal(result.status,'ok');assert.equal(result.windows[0].usedPercent,93);
});
test('profile location follows the platform app-data convention',()=>{
 const path=require('node:path');
 assert.equal(profileDirectory({platform:'win32',env:{APPDATA:'roaming'},home:'home'}),path.join('roaming','Qwen','Local Storage','leveldb'));
 assert.equal(profileDirectory({platform:'darwin',env:{},home:'home'}),path.join('home','Library','Application Support','Qwen','Local Storage','leveldb'));
 assert.equal(profileDirectory({platform:'linux',env:{XDG_CONFIG_HOME:'config'},home:'home'}),path.join('config','Qwen','Local Storage','leveldb'));
 assert.equal(profileDirectory({platform:'linux',env:{},home:'home'}),path.join('home','.config','Qwen','Local Storage','leveldb'));
});
test('package and quota reading validate against the real host contracts',async()=>{
 const path=require('node:path');
 const {packageDirectory,parsePackage}=require('../../src/electron/plugins/package');
 const {normalizeReading}=require('../../src/electron/plugins/limits');
 const pkg=packageDirectory(path.resolve(__dirname,'../../plugins/qwen-chat-quota'));
 assert.equal(parsePackage(pkg.bytes).manifest.id,'qwen-chat-quota');
 assert.deepEqual(pkg.manifest.limits.map(m=>m.id),['subscription']);
 const reading=normalizeReading(await collect(deps()),'plugin:qwen-chat-quota:subscription');
 assert.equal(reading.status,'ok');assert.equal(reading.windows[0].remainingPercent,7);assert.equal(reading.planLabel,'Plus');
});
