'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeIdentityIcon } = require('../../src/shared/plugins/identityIcon');
const { parsePackage, unpackPackage, packageDirectory, describePackage } = require('../../src/electron/plugins/package');
function chunk(type, bytes = Buffer.alloc(0)) {
  const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); out.write(type, 4); bytes.copy(out, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, out.length - 4)) {
    crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
function png(width = 2, height = 2, extra = []) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...extra, chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND')]);
}
const uri = bytes => 'data:image/png;base64,' + bytes.toString('base64');
test('identity PNG accepts bounded static artwork and preserves exact bytes', () => {
  assert.equal(normalizeIdentityIcon(undefined), '');
  for (const [w,h] of [[1,1],[128,128],[256,256],[32,64]]) assert.equal(normalizeIdentityIcon(uri(png(w,h))), uri(png(w,h)));
});
test('identity rejects URLs, markup, animation, unsupported PNG chunks and oversized dimensions', () => {
  for (const value of ['https://example.test/icon.png', 'data:image/svg+xml,<svg/>', {}, uri(png(257)), uri(png(2,2,[chunk('acTL',Buffer.alloc(8))])), uri(png(2,2,[chunk('iCCP',Buffer.alloc(8))])), uri(png(2,2,[chunk('sRGB',Buffer.alloc(8))])), 'data:image/png;base64,'+'a'.repeat(90000)]) assert.throws(()=>normalizeIdentityIcon(value));
});
test('identity rejects corrupted checksums, trailing bytes and truncated images', () => {
  const bytes = png(); const corrupted = Buffer.from(bytes); corrupted[29] ^= 1;
  for (const b of [corrupted,bytes.subarray(0,-1),Buffer.concat([bytes,Buffer.from('extra')])]) assert.throws(()=>normalizeIdentityIcon(uri(b)));
});
test('package preview and installed roundtrip retain identity without any external asset path', () => {
  const icon = uri(png());
  const manifest = {id:'icon-demo',version:'1.0.0',tmApi:1,name:'Icon demo',identityIcon:icon,skins:[{id:'plain',name:'Plain',colors:{accent:'#123456'}}]};
  const pkg = parsePackage(Buffer.from(JSON.stringify({format:2,files:{},manifest})));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tm-icon-'));
  try {
    unpackPackage(pkg,dir);
    assert.equal(packageDirectory(dir).manifest.identityIcon,icon);
    assert.equal(describePackage(pkg).identityIcon,icon);
    assert.throws(()=>parsePackage(Buffer.from(JSON.stringify({format:2,files:{},manifest:{...manifest,identityIcon:'https://example.test/icon.png'}}))), /identityIcon/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('catalog identity follows the same validator and existing index budget', () => {
  const { parseIndex } = require('../../src/electron/plugins/catalogSources');
  const icon = uri(png());
  const entry = {id:'icon-demo',name:'Demo',identityIcon:icon,versions:[{version:'1.0.0',sha256:'a'.repeat(64),url:'https://example.test/demo.tmplugin'}]};
  const index = value => Buffer.from(JSON.stringify({format:1,title:'Demo',plugins:[value]}));
  assert.equal(parseIndex(index(entry)).plugins[0].identityIcon,icon);
  assert.throws(()=>parseIndex(index({...entry,identityIcon:'https://example.test/track.png'})), /identityIcon/);
  assert.throws(()=>parseIndex(Buffer.alloc(1024*1024+1)), /exceeds/);
});
