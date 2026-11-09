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
  if(process.platform!=='win32') {
    assert.equal(fs.statSync(f.directory).mode&0o777,0o700);
    for(const id of fs.readdirSync(f.directory)) {
      assert.equal(fs.statSync(path.join(f.directory,id)).mode&0o777,0o700);
      for(const file of fs.readdirSync(path.join(f.directory,id)))assert.equal(fs.statSync(path.join(f.directory,id,file)).mode&0o777,0o600);
    }
  }
  s.clear('fixture','one',schema,{expectedRevision:1}); assert.equal(s.status('fixture','two',schema).configured,true);
  s.forget('fixture'); assert.equal(s.status('fixture--other','one',schema).configured,true); assert.equal(fs.readdirSync(path.join(f.directory,'fixture')).length,2);assert.deepEqual(s.read('fixture','two',schema),{});
  assert.throws(()=>s.status('../other','one',schema));
});
test('corrupt files and symlinks fail closed without returning secret-bearing causes',t=>{
  const f=fixture(t),s=f.service;
  s.update('fixture','one',schema,{expectedRevision:0,patch:{token:'synthetic'}});
  const file=path.join(f.directory,'fixture','one.json'); fs.writeFileSync(file,'bad synthetic content');
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
test('plugin-wide forget fences retained editors across replacement credentials and restart',t=>{
 const f=fixture(t),s=f.service;
 s.update('fixture','one',schema,{expectedRevision:0,patch:{token:'first'}});
 s.forget('fixture');const cleared=s.status('fixture','one',schema);assert.equal(cleared.configured,false);assert.equal(cleared.revision,2);
 const replacement=s.update('fixture','one',schema,{expectedRevision:cleared.revision,patch:{token:'replacement'}});assert.equal(replacement.revision,3);
 const restarted=createPluginCredentials({directory:f.directory});
 assert.throws(()=>restarted.update('fixture','one',schema,{expectedRevision:1,patch:{token:'stale'}}),/credentials-conflict/);
 assert.deepEqual(restarted.read('fixture','one',schema),{token:'replacement'});
});


test('forget clears corrupt and sibling records, notifies once, and fences editors after recovery/restart',t=>{
 const f=fixture(t),s=f.service;
 for(const moduleId of ['one','two'])s.update('fixture',moduleId,schema,{expectedRevision:0,patch:{token:'synthetic'}});
 s.update('fixture--other','one',schema,{expectedRevision:0,patch:{token:'unrelated'}});
 const names=fs.readdirSync(path.join(f.directory,'fixture')).sort();
 fs.writeFileSync(path.join(f.directory,'fixture',names[0]),'{corrupt synthetic');
 const before=f.events.length;s.forget('fixture');assert.equal(f.events.length,before+1);assert.deepEqual(f.events.at(-1),['fixture',undefined,'clear']);
 for(const moduleId of ['one','two']){
  const status=s.status('fixture',moduleId,schema);assert.equal(status.configured,false);assert.equal(status.revision,2);
  s.update('fixture',moduleId,schema,{expectedRevision:status.revision,patch:{token:'replacement'}});
  const restarted=createPluginCredentials({directory:f.directory});
  assert.throws(()=>restarted.update('fixture',moduleId,schema,{expectedRevision:1,patch:{token:'stale'}}),/credentials-conflict/);
 }
 assert.equal(s.read('fixture--other','one',schema).token,'unrelated');
});
test('forget attempts all namespaced records and invalidates work before reporting IO failure',t=>{
 const f=fixture(t),s=f.service;
 for(const moduleId of ['one','two'])s.update('fixture',moduleId,schema,{expectedRevision:0,patch:{token:'synthetic'}});
 const names=fs.readdirSync(path.join(f.directory,'fixture')).sort(),rename=fs.renameSync;
 t.mock.method(fs,'renameSync',(from,to)=>{if(to===path.join(f.directory,'fixture',names[0]))throw Error('synthetic rename failure');return rename(from,to);});
 const before=f.events.length;assert.throws(()=>s.forget('fixture'),/^Error: credentials-storage-unavailable$/);
 assert.equal(f.events.length,before+1);assert.deepEqual(f.events.at(-1),['fixture',undefined,'clear']);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory,'fixture',names[1]))).values,{});
});


test('explicit forget repairs oversized/unknown-format records and unlinks only the namespaced symlink',t=>{
 const f=fixture(t),s=f.service;
 for(const moduleId of ['one','two','three'])s.update('fixture',moduleId,schema,{expectedRevision:0,patch:{token:'synthetic'}});
 const names=fs.readdirSync(path.join(f.directory,'fixture')).sort();
 fs.writeFileSync(path.join(f.directory,'fixture',names[0]),'x'.repeat(65537));
 fs.writeFileSync(path.join(f.directory,'fixture',names[1]),JSON.stringify({formatVersion:999,revision:8,values:{token:'synthetic'}}));
 const outside=path.join(f.dir,'outside.json');fs.writeFileSync(outside,'synthetic unrelated bytes');
 fs.unlinkSync(path.join(f.directory,'fixture',names[2]));fs.symlinkSync(outside,path.join(f.directory,'fixture',names[2]));
 s.forget('fixture');
 assert.equal(fs.readFileSync(outside,'utf8'),'synthetic unrelated bytes');
 for(const name of names){const record=JSON.parse(fs.readFileSync(path.join(f.directory,'fixture',name)));assert.deepEqual(record.values,{});assert.equal(fs.lstatSync(path.join(f.directory,'fixture',name)).isSymbolicLink(),false);}
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'fixture',names[1]))).revision,9);
});

test('readable plugin/module paths isolate ambiguous delimiters and leave old flat records untouched',t=>{
 const f=fixture(t),s=f.service;
 fs.mkdirSync(f.directory,{mode:0o700});
 const legacy=path.join(f.directory,`fixture--${'a'.repeat(64)}.json`),bytes=JSON.stringify({formatVersion:1,revision:9,values:{token:'synthetic legacy'}});
 fs.writeFileSync(legacy,bytes,{mode:0o600});
 assert.equal(s.status('fixture','one',schema).revision,0,'no old-format reader');
 for(const [id,moduleId] of [['fixture','one--two'],['fixture--one','two']]){
  s.update(id,moduleId,schema,{expectedRevision:0,patch:{token:'synthetic'}});
  assert.ok(fs.existsSync(path.join(f.directory,id,`${moduleId}.json`)));
 }
 s.forget('fixture');
 assert.equal(s.status('fixture--one','two',schema).configured,true);
 assert.equal(fs.readFileSync(legacy,'utf8'),bytes,'no migration or cleanup of old records');
});

test('credential namespaces reject traversal and Windows device names before creating files',t=>{
 const f=fixture(t);
 const base={tmApi:1,id:'quota-fixture',name:'Fixture',version:'1.0.0',backend:'a.cjs',files:['a.cjs']};
 for(const reserved of ['con','prn','aux','nul','com1','lpt9']) {
  for(const [id,moduleId] of [[reserved,'one'],['fixture',reserved]])assert.throws(()=>f.service.update(id,moduleId,schema,{expectedRevision:0,patch:{token:'synthetic'}}));
  for(const [id,moduleId] of [[reserved,'one'],['fixture',reserved]])assert.equal(normalizeManifest({...base,id,limits:[{id:moduleId,name:'Quota',credentials:{fields:[{id:'token',label:'Token'}]}}]}).ok,false);
 }
 for(const [id,moduleId] of [['../escape','one'],['fixture','../escape'],['fixture','a/b'],['fixture','a\\b']])assert.throws(()=>f.service.update(id,moduleId,schema,{expectedRevision:0,patch:{token:'synthetic'}}));
 assert.equal(fs.existsSync(f.directory),false);
 assert.equal(normalizeManifest({...base,limits:[{id:'con',name:'No credential files'}]}).ok,true,'unrelated quota IDs stay unchanged');
});

for(const level of ['root','plugin'])test(`credential ${level} symlink is never traversed by status, save or forget`,t=>{
 const f=fixture(t),outside=path.join(f.dir,'outside');fs.mkdirSync(outside,{mode:0o700});
 const bytes=JSON.stringify({formatVersion:1,revision:1,values:{token:'synthetic outside'}});
 fs.writeFileSync(path.join(outside,'one.json'),bytes,{mode:0o600});
 if(level==='plugin')fs.mkdirSync(f.directory,{mode:0o700});
 const link=level==='root'?f.directory:path.join(f.directory,'fixture');
 fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>f.service.status('fixture','one',schema),/^Error: credentials-storage-unavailable$/);
 assert.throws(()=>f.service.update('fixture','one',schema,{expectedRevision:0,patch:{token:'synthetic'}}),/^Error: credentials-storage-unavailable$/);
 assert.throws(()=>f.service.forget('fixture'),/^Error: credentials-storage-unavailable$/);
 assert.equal(fs.readFileSync(path.join(outside,'one.json'),'utf8'),bytes);
 assert.equal(fs.lstatSync(link).isSymbolicLink(),true);
});
