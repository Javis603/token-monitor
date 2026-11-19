'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createPluginNetwork}=require('../../src/electron/plugins/network');
const args={moduleId:'quota',requestId:'probe',url:'https://example.test/quota',headers:{Authorization:'Bearer synthetic'}};
test('backend transport uses injected route and author URL/headers with private-cookie policy',async()=>{
  let received; const service=createPluginNetwork({active:()=>true,fetchImpl:async(...values)=>{received=values;return new Response('{"remaining":80}',{status:200,headers:{'content-type':'application/json'}});}});
  const response=await service.request('fixture',args);
  assert.equal(response.status,200); assert.equal(JSON.parse(response.body).remaining,80);
  assert.equal(received[0],args.url); assert.equal(received[1].headers.Authorization,args.headers.Authorization);
  assert.equal(received[1].credentials,'omit');assert.equal(received[1].redirect,'error');assert.equal(received[1].cache,'no-store');
});
test('invalid destinations/options fail before transport and request errors are sanitized',async()=>{
  let calls=0; const s=createPluginNetwork({active:()=>true,fetchImpl:async()=>{calls++;throw Error('synthetic-token must not escape');}});
  for(const patch of [{url:'file:///tmp/a'},{url:'https://u:p@example.test'},{headers:{Host:'bad'}},{headers:{a:'x\r\ny'}},{timeoutMs:30001},{method:'TRACE'},{body:'x'}]) await assert.rejects(s.request('fixture',{...args,...patch}));
  assert.equal(calls,0);await assert.rejects(s.request('fixture',args),/^Error: network-request-failed$/);
});
test('timeout, explicit cancellation, module clear and disable abort only owned requests',async()=>{
  const started=[];let active=true;
  const s=createPluginNetwork({active:()=>active,fetchImpl:async(_url,init)=>new Promise((resolve,reject)=>{started.push(init.signal);init.signal.addEventListener('abort',()=>reject(Error('aborted')));})});
  const one=s.request('fixture',args); const two=s.request('fixture',{...args,moduleId:'two'});
  s.cancelPlugin('fixture','quota');await assert.rejects(one,/cancelled/);assert.equal(started[1].aborted,false);
  s.cancel('fixture','quota','two'); assert.equal(started[1].aborted,false);
  active=false;s.cancelInactive();await assert.rejects(two,/cancelled/);
  active=true;await assert.rejects(s.request('fixture',{...args,timeoutMs:5}),/cancelled/);
  const last=s.request('fixture',args);s.dispose();await assert.rejects(last,/cancelled/);
});
test('response body cap aborts the transport',async()=>{
  let signal;const s=createPluginNetwork({active:()=>true,fetchImpl:async(_url,init)=>{signal=init.signal;return new Response('x'.repeat(1048577));}});
  await assert.rejects(s.request('fixture',args),/cancelled/);assert.equal(signal.aborted,true);
});
test('a cancelled request releases its scoped ID; late completion cannot remove a replacement',async()=>{
  const pending=[];const s=createPluginNetwork({active:()=>true,fetchImpl:()=>new Promise(resolve=>pending.push(resolve))});
  const old=s.request('fixture',args);s.cancel('fixture','quota','probe');
  const replacement=s.request('fixture',args);
  pending[0](new Response('old'));await assert.rejects(old,/cancelled/);
  await assert.rejects(s.request('fixture',args),/conflict/);
  s.cancel('fixture','quota','probe');pending[1](new Response('late'));
  await assert.rejects(replacement,/cancelled/);s.dispose();
});
