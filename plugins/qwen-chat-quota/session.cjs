'use strict';
// Read-only LevelDB reader, limited to the Qwen Chat authentication keys.
// Format references: google/leveldb doc/{log,table}_format.md; google/snappy.
const fs = require('node:fs');
const path = require('node:path');
const MAX = 32 * 1024 * 1024;
const PREFIX = Buffer.from('_https://chat.qwen.ai\0\x01');
const KEYS = new Set(['qwen_access_token_state','token','at_expire_time','qwen_token_logged_out_marker']);
function varint(b, cursor) {
  let n=0, scale=1;
  for(let i=0;i<8;i++) {if(cursor.p>=b.length) throw Error('Truncated value'); const x=b[cursor.p++]; n+=(x&127)*scale; if(!Number.isSafeInteger(n)) throw Error('Invalid integer'); if(!(x&128)) return n; scale*=128;}
  throw Error('Invalid integer');
}
function slice(b,c,n) {if(n<0||c.p+n>b.length)throw Error('Truncated value');const s=b.subarray(c.p,c.p+n);c.p+=n;return s;}
function string(b,c) {return slice(b,c,varint(b,c));}
function checksum(b) {let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0x82f63b78:0);}c=(c^0xffffffff)>>>0;return (((c>>>15)|(c<<17))+0xa282ead8)>>>0;}
function decodeSnappy(b) {
  const c={p:0},size=varint(b,c);if(size>MAX)throw Error('Block too large');
  const out=Buffer.alloc(size);let p=0;
  while(c.p<b.length) {
    const tag=b[c.p++],type=tag&3;let len,offset;
    if(type===0) {
      len=tag>>>2;
      if(len>=60) {const bytes=len-59;len=0;for(let j=0;j<bytes;j++)len+=slice(b,c,1)[0]*2**(8*j);}
      len++;if(p+len>size)throw Error('Invalid literal');slice(b,c,len).copy(out,p);p+=len;
    } else {
      if(type===1) {len=4+((tag>>>2)&7);offset=((tag&224)<<3)+slice(b,c,1)[0];}
      else {len=1+(tag>>>2);offset=type===2?slice(b,c,2).readUInt16LE():slice(b,c,4).readUInt32LE();}
      if(!offset||offset>p||p+len>size)throw Error('Invalid copy');
      for(let j=0;j<len;j++){out[p]=out[p-offset];p++;}
    }
  }
  if(p!==size)throw Error('Incomplete block');return out;
}
function* records(b) {
  let fragments=null;
  for(let start=0;start<b.length;start+=32768) {
    const end=Math.min(start+32768,b.length);let p=start;
    while(p+7<=end) {
      const crc=b.readUInt32LE(p),len=b.readUInt16LE(p+4),type=b[p+6];
      if(!crc&&!len&&!type)break;
      if(p+7+len>end) {if(end===b.length)return;throw Error('Invalid record length');}
      const body=b.subarray(p+7,p+7+len);
      if(checksum(b.subarray(p+6,p+7+len))!==crc)throw Error('Invalid record checksum');
      if(type===1) {fragments=null;yield body;}
      else if(type===2)fragments=[body];
      else if(type===3&&fragments)fragments.push(body);
      else if(type===4&&fragments) {fragments.push(body);yield Buffer.concat(fragments);fragments=null;}
      else throw Error('Invalid record type');
      p+=7+len;
    }
  }
}
function* batchEntries(b) {
  if(b.length<12)throw Error('Invalid batch');
  let seq=b.readBigUInt64LE();const count=b.readUInt32LE(8),c={p:12};
  if(count>1000000)throw Error('Batch too large');
  for(let i=0;i<count;i++,seq++) {const type=slice(b,c,1)[0];if(type!==0&&type!==1)throw Error('Invalid operation');const k=string(b,c),v=type?string(b,c):null;yield {k,v,seq};}
  if(c.p!==b.length)throw Error('Invalid batch length');
}
function handle(b,c) {return {offset:varint(b,c),size:varint(b,c)};}
function readBlock(b,h) {
  if(h.offset<0||h.size>MAX||h.offset+h.size+5>b.length)throw Error('Invalid block handle');
  const x=b.subarray(h.offset,h.offset+h.size+1),type=x[x.length-1];
  if(checksum(x)!==b.readUInt32LE(h.offset+h.size+1))throw Error('Invalid block checksum');
  if(type===0)return x.subarray(0,-1);if(type===1)return decodeSnappy(x.subarray(0,-1));throw Error('Unsupported compression');
}
function* blockEntries(b) {
  if(b.length<4)throw Error('Invalid block');
  const restarts=b.readUInt32LE(b.length-4),end=b.length-4-restarts*4;
  if(end<0)throw Error('Invalid restarts');
  const c={p:0};let previous=Buffer.alloc(0);
  while(c.p<end) {const shared=varint(b,c),len=varint(b,c),valueLen=varint(b,c);if(shared>previous.length||c.p+len+valueLen>end)throw Error('Invalid entry');const k=Buffer.concat([previous.subarray(0,shared),slice(b,c,len)]),v=slice(b,c,valueLen);yield {k,v};previous=k;}
  if(c.p!==end)throw Error('Invalid block end');
}
function* tableEntries(b) {
  if(b.length<48||b.readBigUInt64LE(b.length-8)!==0xdb4775248b80fb57n)throw Error('Invalid table');
  const c={p:b.length-48};handle(b,c);const index=readBlock(b,handle(b,c));
  for(const entry of blockEntries(index))for(const {k,v} of blockEntries(readBlock(b,handle(entry.v,{p:0})))) {
    if(k.length<8)throw Error('Invalid internal key');const tag=k.readBigUInt64LE(k.length-8),type=Number(tag&255n);
    if(type!==0&&type!==1)throw Error('Invalid internal type');yield {k:k.subarray(0,-8),v:type?v:null,seq:tag>>8n};
  }
}
function filesForManifest(dir,read) {
  const file=read('CURRENT').toString('ascii').trim();if(!/^MANIFEST-\d+$/.test(file))throw Error('Invalid current manifest');
  const tables=new Set(),baseline=new Set();let log=0,prev=0;
  for(const b of records(read(file))) {
    const c={p:0};while(c.p<b.length) {
      const tag=varint(b,c);
      if(tag===1)string(b,c);
      else if(tag===2){log=varint(b,c);baseline.add(tag);}
      else if(tag===3||tag===4){varint(b,c);baseline.add(tag);}
      else if(tag===9)prev=varint(b,c);
      else if(tag===5){varint(b,c);string(b,c);}
      else if(tag===6){varint(b,c);tables.delete(varint(b,c));}
      else if(tag===7){varint(b,c);tables.add(varint(b,c));varint(b,c);string(b,c);string(b,c);}
      else throw Error('Unsupported manifest');
    }
  }
  if(baseline.size!==3)throw Error('Incomplete manifest baseline');
  const names=fs.readdirSync(dir).filter(n=>/^(\d+)\.(ldb|log)$/.test(n));
  for(const number of tables)if(!names.some(n=>n.endsWith('.ldb')&&Number(n.split('.')[0])===number))throw Error('Missing live table');
  for(const number of [log,prev].filter(Boolean))if(!names.some(n=>n.endsWith('.log')&&Number(n.split('.')[0])===number))throw Error('Missing recovery log');
  return names.filter(n=>n.endsWith('.ldb')?tables.has(Number(n.split('.')[0])):Number(n.split('.')[0])>=log||Number(n.split('.')[0])===prev);
}
function decodeString(b) {if(!b||!b.length)return '';if(b[0]===1)return b.subarray(1).toString('latin1');if(b[0]===0&&b.length%2===1)return b.subarray(1).toString('utf16le');throw Error('Invalid Chromium string');}
function readSession(dir) {
  if(!fs.existsSync(dir))return null;
  try {
    let total=0;
    const read=name=>{const p=path.join(dir,name),stat=fs.statSync(p);if(!stat.isFile()||stat.size>MAX||(total+=stat.size)>MAX*2)throw Error('Profile too large');return fs.readFileSync(p);};
    const files=filesForManifest(dir,read);
    const latest=new Map();
    for(const file of files) {
      const b=read(file),entries=file.endsWith('.ldb')?tableEntries(b):(function*(){for(const rec of records(b))yield*batchEntries(rec);})();
      for(const {k,v,seq} of entries) {
        if(k.length<=PREFIX.length||!k.subarray(0,PREFIX.length).equals(PREFIX))continue;
        const name=k.subarray(PREFIX.length).toString('ascii');if(!KEYS.has(name))continue;
        if(!latest.has(name)||seq>latest.get(name).seq)latest.set(name,{seq,v});
      }
    }
    const get=name=>decodeString(latest.get(name)?.v);
    if(get('qwen_token_logged_out_marker'))return null;
    const stateText=get('qwen_access_token_state');
    if(stateText) {const state=JSON.parse(stateText);if(state.version!==1||typeof state.token!=='string'||!state.token||!Number.isFinite(state.expiresAt))throw Error('Invalid session');return {token:state.token,expiresAt:state.expiresAt};}
    // A deleted modern session must not resurrect the old legacy token.
    if(latest.has('qwen_access_token_state'))return null;
    const token=get('token'),expiresAt=Number(get('at_expire_time'));
    return token&&Number.isFinite(expiresAt)&&expiresAt>0?{token,expiresAt}:null;
  } catch {throw Error('Qwen profile is temporarily unavailable or incompatible');}
}
module.exports={readSession,decodeSnappy};
