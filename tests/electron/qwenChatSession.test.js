'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readSession, decodeSnappy} = require('../../plugins/qwen-chat-quota/session.cjs');
const vi = n => {const a=[];do {a.push((n%128)|(n>127?128:0));n=Math.floor(n/128);}while(n);return Buffer.from(a);};
const str = s => Buffer.concat([vi(s.length),s]);
const key = name => Buffer.from('_https://chat.qwen.ai\0\x01'+name);
const value = s => Buffer.concat([Buffer.from([1]),Buffer.from(s)]);
function crc(b) {let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0x82f63b78:0);}c=(c^0xffffffff)>>>0;return (((c>>>15)|(c<<17))+0xa282ead8)>>>0;}
function batch(seq, ops) {const h=Buffer.alloc(12);h.writeBigUInt64LE(BigInt(seq));h.writeUInt32LE(ops.length,8);return Buffer.concat([h,...ops.map(([k,v])=>Buffer.concat([Buffer.from([v===null?0:1]),str(key(k)),...(v===null?[]:[str(value(v))])]))]);}
function record(type,b) {const h=Buffer.alloc(7);h.writeUInt32LE(crc(Buffer.concat([Buffer.from([type]),b])));h.writeUInt16LE(b.length,4);h[6]=type;return Buffer.concat([h,b]);}
const session = (token='test-session')=>JSON.stringify({version:1,stateId:'state',token,expiresAt:Date.now()+3600000,updatedAt:Date.now(),sourceId:'test'});
function temp(t) {const p=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-quota-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function manifest(dir,tables,log=1) {
 const names=tables??fs.readdirSync(dir).filter(n=>n.endsWith('.ldb')).map(n=>Number(n.split('.')[0]));
 const edit=Buffer.concat([vi(2),vi(log),vi(3),vi(100),vi(4),vi(100),...names.map(n=>Buffer.concat([vi(7),vi(0),vi(n),vi(0),str(Buffer.alloc(0)),str(Buffer.alloc(0))]))]);
 fs.writeFileSync(path.join(dir,'CURRENT'),'MANIFEST-000001\n');fs.writeFileSync(path.join(dir,'MANIFEST-000001'),record(1,edit));
 const activeLog=path.join(dir,String(log).padStart(6,'0')+'.log');if(log&&!fs.existsSync(activeLog))fs.writeFileSync(activeLog,Buffer.alloc(0));
}
function block(entries) {return Buffer.concat([...entries.map(([k,v])=>Buffer.concat([vi(0),vi(k.length),vi(v.length),k,v])),Buffer.from([0,0,0,0,1,0,0,0])]);}
function literal(b) {return Buffer.concat([vi(b.length),Buffer.from([0xf0,b.length-1]),b]);}
function table(seq,k,v) {
 const ik=Buffer.concat([key(k),Buffer.alloc(8)]);ik.writeBigUInt64LE((BigInt(seq)<<8n)|1n,ik.length-8);
 const raw=block([[ik,value(v)]]),data=literal(raw);
 const wrap=b=>{const h=Buffer.alloc(5);h[0]=1;h.writeUInt32LE(crc(Buffer.concat([b,h.subarray(0,1)])),1);return Buffer.concat([b,h]);};
 const index=literal(block([[ik,Buffer.concat([vi(0),vi(data.length)])]]));
 const footer=Buffer.alloc(48);const handles=Buffer.concat([vi(0),vi(0),vi(data.length+5),vi(index.length)]);handles.copy(footer);footer.writeBigUInt64LE(0xdb4775248b80fb57n,40);
 return Buffer.concat([wrap(data),wrap(index),footer]);
}
function fixtureSession(dir) {manifest(dir);return readSession(dir);}
test('reads the newest session without returning unrelated local storage',t=>{const dir=temp(t);fs.writeFileSync(path.join(dir,'000001.log'),record(1,batch(1,[['unrelated','ignore'],['qwen_access_token_state',session()]])));assert.equal(fixtureSession(dir).token,'test-session');});
test('a newer deletion prevents reuse of an old session',t=>{const dir=temp(t);fs.writeFileSync(path.join(dir,'000001.log'),Buffer.concat([record(1,batch(1,[['qwen_access_token_state',session()]])),record(1,batch(2,[['qwen_access_token_state',null]]))]));assert.equal(fixtureSession(dir),null);});
test('logout marker prevents session reuse',t=>{const dir=temp(t);fs.writeFileSync(path.join(dir,'000001.log'),record(1,batch(1,[['qwen_access_token_state',session()],['qwen_token_logged_out_marker','loggedout']])));assert.equal(fixtureSession(dir),null);});
test('reads Snappy-compressed SSTable and prefers a newer log rotation',t=>{const dir=temp(t);fs.writeFileSync(path.join(dir,'000001.ldb'),table(1,'qwen_access_token_state',session('old')));assert.equal(fixtureSession(dir).token,'old');fs.writeFileSync(path.join(dir,'000002.log'),record(1,batch(2,[['qwen_access_token_state',session('new')]])));assert.equal(fixtureSession(dir).token,'new');});
test('handles a batch fragmented across 32KB log blocks',t=>{const dir=temp(t), b=batch(1,[['padding','x'.repeat(33000)],['qwen_access_token_state',session()]]);fs.writeFileSync(path.join(dir,'000001.log'),Buffer.concat([record(2,b.subarray(0,32761)),record(4,b.subarray(32761))]));assert.equal(fixtureSession(dir).token,'test-session');});
test('corrupt records fail closed with no stale credential fallback',t=>{const dir=temp(t), b=record(1,batch(1,[['qwen_access_token_state',session()]]));b[b.length-1]^=1;fs.writeFileSync(path.join(dir,'000001.log'),b);assert.throws(()=>fixtureSession(dir),/profile/i);});
test('Snappy supports overlapping copies and rejects invalid offsets',()=>{assert.equal(decodeSnappy(Buffer.from([7,8,120,97,98,14,2,0])).toString(),'xababab');assert.throws(()=>decodeSnappy(Buffer.from([4,1,0])));});
test('missing profile and absent authentication return null',t=>{assert.equal(readSession(path.join(temp(t),'absent')),null);});
test('uses only live manifest tables and ignores a retired session',t=>{const dir=temp(t);fs.writeFileSync(path.join(dir,'000001.ldb'),table(10,'qwen_access_token_state',session('retired')));manifest(dir,[]);assert.equal(readSession(dir),null);});
test('an existing profile without CURRENT fails closed',t=>{const dir=temp(t);fs.writeFileSync(path.join(dir,'000001.log'),record(1,batch(1,[['qwen_access_token_state',session()]])));assert.throws(()=>readSession(dir),/profile/i);});
test('a missing live manifest table cannot resurrect an older credential',t=>{const dir=temp(t);fs.writeFileSync(path.join(dir,'000001.ldb'),table(1,'qwen_access_token_state',session('old')));manifest(dir,[1,2]);assert.throws(()=>readSession(dir),/profile/i);});
test('a missing recovery log cannot resurrect an old table credential',t=>{const dir=temp(t);fs.writeFileSync(path.join(dir,'000001.ldb'),table(1,'qwen_access_token_state',session('old')));manifest(dir,[1],2);fs.unlinkSync(path.join(dir,'000002.log'));assert.throws(()=>readSession(dir),/profile/i);});
test('an empty or truncated initial manifest cannot scan obsolete logs',t=>{for(const b of [Buffer.alloc(0),Buffer.from([1,2,3])]){const dir=temp(t);manifest(dir,[]);fs.writeFileSync(path.join(dir,'MANIFEST-000001'),b);fs.writeFileSync(path.join(dir,'000001.log'),record(1,batch(1,[['qwen_access_token_state',session('old')]])));assert.throws(()=>readSession(dir),/profile/i);}});
