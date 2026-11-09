'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createCredentialValidation}=require('../../src/electron/plugins/credentialValidation');
function fixture(){let saved=1,code='a',finish,change=0;const service=createCredentialValidation({status:()=>({revision:saved,configured:true,fields:{token:true}}),revision:()=>code,validate:()=>new Promise(resolve=>{finish=resolve;}),changed:()=>change++});return{service,get finish(){return finish;},set saved(v){saved=v;},set code(v){code=v;},get change(){return change;}};}
const schema={validation:true};
test('explicit validation is revision-bound and never derives success from saved presence',async()=>{const f=fixture(),s=f.service;assert.equal(s.snapshot('fixture','one',schema).verification,'unverified');const task=s.verify('fixture','one',schema,{expectedRevision:1});assert.equal(s.snapshot('fixture','one',schema).verification,'verifying');await assert.rejects(s.verify('fixture','one',schema,{expectedRevision:1}),/pending/);f.finish({status:'valid'});assert.equal((await task).verification,'valid');f.saved=2;assert.equal(s.snapshot('fixture','one',schema).verification,'unverified');});
test('clear, update, disable/code revision and late results cannot confirm replacement credentials',async()=>{for(const mode of ['clear','update','code','disable']){const f=fixture(),s=f.service;const task=s.verify('fixture','one',schema,{expectedRevision:1});if(mode==='code')f.code='b';else if(mode==='disable')f.code=null;else{s.invalidate('fixture','one');if(mode==='update')f.saved=2;}f.finish({status:'valid'});assert.equal((await task).verification,'unverified',mode);}});
test('rejected/expired/unavailable states remain distinct and conflicts never start a request',async()=>{const f=fixture(),s=f.service;await assert.rejects(s.verify('fixture','one',schema,{expectedRevision:0}),/conflict/);assert.equal(f.finish,undefined);for(const status of ['rejected','expired','unavailable']){const task=s.verify('fixture','one',schema,{expectedRevision:1});f.finish({status});assert.equal((await task).verification,status);}s.dispose();});
test('current unauthorized quota can reject a connection, while stale quota cannot touch replacement credentials',async()=>{const f=fixture(),s=f.service;const task=s.verify('fixture','one',schema,{expectedRevision:1});f.finish({status:'valid'});await task;s.reject('fixture','one',schema,1);assert.equal(s.snapshot('fixture','one',schema).verification,'rejected');f.saved=2;s.invalidate('fixture','one');s.reject('fixture','one',schema,1);assert.equal(s.snapshot('fixture','one',schema).verification,'unverified');});


test('documented backend dispatcher reaches validation before rejecting unknown methods',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const doc=fs.readFileSync(path.resolve(__dirname,'../../docs/plugins/author-limits.md'),'utf8');
 const blocks=[...doc.matchAll(/```js\n([\s\S]*?)```/g)].map(match=>match[1]);
 const dispatcher=blocks.find(code=>code.startsWith('exports.activate'));
 const validator=blocks.find(code=>code.includes('async function validateCredentials'));
 assert.ok(dispatcher&&validator);
 const context=vm.createContext({exports:{},validationUrl:'https://fixture.example/auth'});vm.runInContext(dispatcher+'\n'+validator,context);
 const calls=[],backend=await context.exports.activate({host:{call:async(method,args)=>{
  calls.push({method,args});if(method==='credentials.read')return{sessionBearer:'synthetic'};
  if(method==='network.request')return{status:200};if(method==='credentials.status')return{configured:false};throw Error(method);
 }}});
 assert.equal((await backend.call('credentials.validate',{moduleId:'one',revision:7})).status,'valid');
 assert.equal(calls[0].args.expectedRevision,7);assert.equal(calls[1].args.moduleId,'one');
 assert.equal((await backend.call('limits.collect',{moduleId:'one'})).status,'notConfigured');
 await assert.rejects(backend.call('unknown',{moduleId:'one'}),/Unknown operation/);
 const distribution=fs.readFileSync(path.resolve(__dirname,'../../docs/plugins/distribution-design.md'),'utf8');
 const line=distribution.split('\n').find(line=>line.includes('`types` accepts'));
 for(const type of require('../../src/electron/plugins/types').normalizeTypes(['widget','page','appearance','automation','limits']))assert.ok(line.includes('`'+type+'`'),type);
});
