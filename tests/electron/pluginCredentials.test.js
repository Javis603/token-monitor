'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createPluginCredentials } = require('../../src/electron/plugins/credentials');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const { normalizeCredentials } = require('../../src/shared/plugins/credentials');
const schema = normalizeCredentials({fields:[{id:'token',label:'Token',required:true},{id:'cookies',label:'Cookies',control:'textarea'}]});
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tm-manual-credentials-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const events=[], directory=path.join(dir,'plugin-credentials');
  const service=createPluginCredentials({directory,changed:(...args)=>events.push(args)});
  return {dir,directory,service,events};
}
test('credential schema is bounded, localized, secret-only and rejects old connection manifests',()=>{
  const base={tmApi:1,id:'quota-fixture',name:'Fixture',version:'1.0.0',backend:'a.cjs',files:['a.cjs']};
  assert.equal(normalizeManifest({...base,limits:[{id:'quota',name:'Quota',credentials:{fields:[{id:'sessionBearer',label:{en:'Token','zh-TW':'憑證'},required:true}]}}]}).ok,true);
  for(const credentials of [{fields:[]},{fields:[{id:'token',label:'T',control:'select'}]},{fields:[{id:'token',label:'T',default:'no'}]},{fields:[{id:'token',label:'T',required:'true'}]},{fields:[{id:'token',label:'T'},{id:'token',label:'Again'}]}]) assert.throws(()=>normalizeCredentials(credentials));
  assert.equal(normalizeManifest({...base,limits:[{id:'quota',name:'Quota',connection:'openai'}]}).ok,false);
});
test('partial updates distinguish omitted, explicit empty, zero revision and conflicts; status never returns values',t=>{
  const {service:s}=fixture(t);
  const initial=s.status('fixture','one',schema); assert.equal(initial.revision,0); assert.equal(initial.configured,false);
  const first=s.update('fixture','one',schema,{expectedRevision:0,patch:{token:'synthetic-token',cookies:'a=b\nc=d'}});
  assert.equal(first.configured,true); assert.deepEqual(first.fields,{token:true,cookies:true}); assert.equal(JSON.stringify(first).includes('synthetic-token'),false);
  assert.throws(()=>s.update('fixture','one',schema,{expectedRevision:0,patch:{token:'stale'}}),/credentials-conflict/);
  assert.throws(()=>s.update('fixture','one',schema,{expectedRevision:1,patch:{token:''}}),/credentials-invalid-value/);
  assert.throws(()=>s.update('fixture','one',schema,{expectedRevision:1,patch:{undeclared:'no'}}),/credentials-invalid-patch/);
  const next=s.update('fixture','one',schema,{expectedRevision:1,patch:{cookies:''}});
  assert.equal(next.fields.cookies,false); assert.deepEqual(s.read('fixture','one',schema),{token:'synthetic-token'});
  assert.equal(s.clear('fixture','one',schema,{expectedRevision:next.revision}).configured,false);
  assert.deepEqual(s.read('fixture','one',schema),{});
  assert.throws(()=>s.update('fixture','one',schema,{expectedRevision:0,patch:{token:'stale-initial'}}),/credentials-conflict/);
});
test('private atomic JSON survives restart, isolates modules and overlapping IDs, and cleans without installed code',t=>{
  const f=fixture(t),s=f.service;
  for(const [id,moduleId] of [['fixture','one'],['fixture','two'],['fixture--other','one']]) s.update(id,moduleId,schema,{expectedRevision:0,patch:{token:`synthetic-${id}-${moduleId}`}});
  const restarted=createPluginCredentials({directory:f.directory});
  assert.equal(restarted.status('fixture','one',schema).configured,true);
  if(process.platform!=='win32') for(const file of fs.readdirSync(f.directory)) assert.equal(fs.statSync(path.join(f.directory,file)).mode&0o777,0o600);
  s.clear('fixture','one',schema,{expectedRevision:1}); assert.equal(s.status('fixture','two',schema).configured,true);
  s.forget('fixture'); assert.equal(s.status('fixture--other','one',schema).configured,true); assert.equal(fs.readdirSync(f.directory).length,1);
  assert.throws(()=>s.status('../other','one',schema));
});
test('corrupt files and symlinks fail closed without returning secret-bearing causes',t=>{
  const f=fixture(t),s=f.service;
  s.update('fixture','one',schema,{expectedRevision:0,patch:{token:'synthetic'}});
  const file=path.join(f.directory,fs.readdirSync(f.directory)[0]); fs.writeFileSync(file,'bad synthetic content');
  assert.throws(()=>s.status('fixture','one',schema),/^Error: credentials-storage-unavailable$/);
  fs.unlinkSync(file); fs.symlinkSync(path.join(f.dir,'missing'),file);
  assert.throws(()=>s.update('fixture','one',schema,{expectedRevision:0,patch:{token:'replacement'}}),/credentials-storage-unavailable/);
});
test('failed atomic replacement preserves prior values and revision, and missing storage still notifies clear',t=>{
  const f=fixture(t),s=f.service;
  s.update('fixture','one',schema,{expectedRevision:0,patch:{token:'prior'}});
  t.mock.method(fs,'renameSync',()=>{throw Error('failed synthetic rename');});
  assert.throws(()=>s.update('fixture','one',schema,{expectedRevision:1,patch:{token:'replacement'}}),/^Error: credentials-storage-unavailable$/);
  fs.renameSync.mock.restore();
  assert.deepEqual(s.read('fixture','one',schema),{token:'prior'});assert.equal(s.status('fixture','one',schema).revision,1);
  fs.rmSync(f.directory,{recursive:true});s.forget('fixture');assert.deepEqual(f.events.at(-1),['fixture',undefined,'clear']);
});
test('partial saved credentials remain incomplete, revision-bound reads reject replacement values',t=>{
  const {service:s}=fixture(t);const first=s.update('fixture','one',schema,{expectedRevision:0,patch:{cookies:'synthetic=partial'}});
  assert.equal(first.configured,false);assert.equal(first.fields.cookies,true);assert.equal(first.fields.token,false);
  assert.throws(()=>s.read('fixture','one',schema,{expectedRevision:0}),/credentials-conflict/);
  assert.deepEqual(s.read('fixture','one',schema,{expectedRevision:1}),{cookies:'synthetic=partial'});
});
