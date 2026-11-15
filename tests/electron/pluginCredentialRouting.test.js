'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {runtimeFixture}=require('../helpers/trustedPlugin');
const tick=()=>new Promise(setImmediate);
async function fixture(t){
  const source=fs.mkdtempSync(path.join(os.tmpdir(),'tm-credential-routing-'));
  t.after(()=>fs.rmSync(source,{recursive:true,force:true}));
  fs.cpSync(path.resolve(__dirname,'../fixtures/trusted-plugin'),source,{recursive:true});
  const file=path.join(source,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file));
  manifest.limits=['one','two'].map(id=>({id,name:id,credentials:{fields:[{id:'token',label:'Token',required:true}]}}));fs.writeFileSync(file,JSON.stringify(manifest));
  let request;
  const f=await runtimeFixture(t,{sourceDirectory:source,fetchImpl:async(...args)=>{request=args;if(String(args[0]).endsWith('/slow'))return new Promise((resolve,reject)=>args[1].signal.addEventListener('abort',()=>reject(Error('abort'))));return new Response('fixture response');}});
  await f.install();await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:true});
  f.send(f.main,'home');await tick();
  let serial=0;
  async function backend(method,args){
    const child=f.children.at(-1),id=++serial;child.emit('message',{type:'host-call',id,method,args});
    for(let n=0;n<40;n++){const reply=child.messages.find(row=>row.type==='host-reply'&&row.id===id);if(reply){if(reply.error)throw Error(reply.error);return reply.value;}await tick();}throw Error('no reply');
  }
  return{...f,backend,get request(){return request;}};
}
test('credential permission split, namespace identity, backend transport, disable retention and broken-code cleanup',async t=>{
  const f=await fixture(t);
  const host=(method,args)=>f.invoke('plugins:host','trusted-fixture',method,args);
  const saved=await host('credentials.update',{moduleId:'one',pluginId:'other-plugin',expectedRevision:0,patch:{token:'fixture-value'}});
  assert.equal(saved.configured,true);assert.equal(JSON.stringify(saved).includes('fixture-value'),false);
  assert.deepEqual(await f.backend('credentials.read',{moduleId:'one'}),{token:'fixture-value'});
  await assert.rejects(async()=>host('credentials.read',{moduleId:'one'}),/Backend-only/);
  await assert.rejects(async()=>host('network.request',{moduleId:'one'}),/Backend-only/);
  await assert.rejects(async()=>host('credentials.status',{moduleId:'missing'}),/Undeclared/);
  assert.equal((await host('credentials.status',{moduleId:'two'})).configured,false);
  const response=await f.backend('network.request',{moduleId:'one',requestId:'probe',url:'https://fixture.example/quota',headers:{Authorization:'Bearer fixture-value'}});
  assert.equal(response.body,'fixture response');assert.equal(f.request[1].credentials,'omit');
  assert.equal(JSON.stringify(f.invoke('plugins:list')).includes('fixture-value'),false);
  const modules=f.invoke('plugins:list').limits.modules;
  assert.deepEqual(modules.find(module=>module.moduleId==='one').credentialState,{hasSaved:true,configured:true,verification:'unverified'});
  assert.deepEqual(modules.find(module=>module.moduleId==='two').credentialState,{hasSaved:false,configured:false,verification:'unverified'});

  f.children.at(-1).emit('message',{type:'host-call',id:986,method:'network.request',args:{moduleId:'one',requestId:'hide',url:'https://fixture.example/slow'}});
  await tick();const hiddenSignal=f.request[1].signal;f.send(f.main,'home',[]);await tick();
  assert.equal(hiddenSignal.aborted,true,'backend demand loss cancels host requests');
  f.send(f.main,'home');await tick();
  const requestId=987; f.children.at(-1).emit('message',{type:'host-call',id:requestId,method:'network.request',args:{moduleId:'one',requestId:'slow',url:'https://fixture.example/slow'}});
  await tick(); const signal=f.request[1].signal; assert.equal(signal.aborted,false);
  await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:false});
  assert.equal(signal.aborted,true,'disable cancels host transport before backend shutdown');
  await assert.rejects(async()=>host('credentials.status',{moduleId:'one'}),/disabled/);
  await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:true});
  assert.equal((await host('credentials.status',{moduleId:'one'})).configured,true);
  f.send(f.main,'home');await tick();
  f.children.at(-1).emit('message',{type:'host-call',id:988,method:'network.request',args:{moduleId:'one',requestId:'reload',url:'https://fixture.example/slow'}});
  await tick();const reloadSignal=f.request[1].signal;
  await f.invoke('plugins:reload');assert.equal(reloadSignal.aborted,true,'reload cancels requests even when the plugin stays active');
  assert.equal((await host('credentials.status',{moduleId:'one'})).configured,true);
  const begin=f.runtime.manager.beginMutation;
  f.runtime.manager.beginMutation=async()=>{throw Error('synthetic uninstall rejected');};
  await assert.rejects(f.invoke('plugins:uninstall','trusted-fixture',{keepData:true}),/synthetic uninstall rejected/);
  f.runtime.manager.beginMutation=begin;
  assert.equal((await host('credentials.status',{moduleId:'one'})).configured,true,'failed uninstall preserves credentials');
  fs.rmSync(path.join(f.dir,'plugins/trusted-fixture'),{recursive:true});await f.runtime.manager.reload();
  f.cancel();await assert.rejects(f.invoke('plugins:forgetCredentials','trusted-fixture'),/cancelled/);
  assert.equal(fs.readdirSync(path.join(f.dir,'plugin-credentials')).length,1,'cancelled cleanup preserves saved credentials for missing code');
  f.accept();await f.invoke('plugins:forgetCredentials','trusted-fixture');assert.ok(fs.readdirSync(path.join(f.dir,'plugin-credentials','trusted-fixture')).every(name=>Object.keys(JSON.parse(fs.readFileSync(path.join(f.dir,'plugin-credentials','trusted-fixture',name))).values).length===0));
});


test('unknown network methods cannot alias credential operations',async t=>{
 const f=await fixture(t);
 for(const suffix of ['status','read','update','clear','verify']) await assert.rejects(f.backend('network.abcd'+suffix,{moduleId:'one',expectedRevision:0,patch:{token:'synthetic'}}),/Unknown network operation/);
 assert.equal((await f.backend('credentials.status',{moduleId:'one'})).revision,0);
});


test('plugin-wide corrupt-record recovery cancels requests and clears sibling modules through real host routing',async t=>{
 const f=await fixture(t),host=(method,args)=>f.invoke('plugins:host','trusted-fixture',method,args);
 for(const moduleId of ['one','two'])await host('credentials.update',{moduleId,expectedRevision:0,patch:{token:'synthetic'}});
 fs.writeFileSync(path.join(f.dir,'plugin-credentials','trusted-fixture','one.json'),'{synthetic corrupt');
 f.children.at(-1).emit('message',{type:'host-call',id:991,method:'network.request',args:{moduleId:'one',requestId:'pending',url:'https://fixture.example/slow'}});
 await tick();const signal=f.request[1].signal;assert.equal(signal.aborted,false);
 f.accept();await f.invoke('plugins:forgetCredentials','trusted-fixture');
 assert.equal(signal.aborted,true);
 for(const moduleId of ['one','two']){const saved=await host('credentials.status',{moduleId});assert.equal(saved.configured,false);assert.equal(saved.revision,2);}
});
