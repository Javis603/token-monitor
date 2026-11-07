'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeIdentityIcon } = require('../../src/shared/plugins/identityIcon');
const { normalizePresentation } = require('../../src/shared/plugins/presentation');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const vendors = require('../../src/shared/vendorPresentation');
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`;
const uri = text => 'data:image/svg+xml;base64,' + Buffer.from(text).toString('base64');
const art = uri(svg('<path fill="#abc" d="M2 2h20v20H2z"/><circle fill="#112233" cx="12" cy="12" r="3"/>'));

test('static SVG preserves multicolor geometry and supports mask metadata', () => {
  for (const body of ['<g transform="translate(1, 2) rotate(30)" opacity="0.8"><path fill="currentColor" d="M0 0L20 20" stroke="white" stroke-linecap="round"/></g>', '<rect x="1" y="2" width="20" height="21" rx="2"/>', '<polygon points="0,0 24,0 12,24"/>']) assert.equal(normalizeIdentityIcon(uri(svg(body))), uri(svg(body)));
  assert.deepEqual(normalizePresentation({icon:{data:art,mode:'mask'}}), {icon:{data:art,mode:'mask'}});
});
test('SVG rejects executable, linked, styled, embedded and ambiguous XML content', () => {
  for (const body of ['<script>alert(1)</script>', '<path onload="alert(1)"/>', '<foreignObject/>', '<image href="https://example.test/x"/>', '<use href="#x"/>', '<style>path{fill:red}</style>', '<path style="fill:red"/>', '<animate/>', '<path fill="url(#paint)"/>', '<path fill="url(https://example.test)"/>', '<path fill="red"/>', '<path d="M0 0" d="M1 1"/>', '<g><path/></svg>', '<svg/>', '&lt;path/&gt;', '<!-- comment -->', '<path/><!DOCTYPE x>', '<path xmlns:x="https://example.test"/>', '<path fill="#12345"/>', '<g transform="translate(1);url(x)"/>', '<path/>' .repeat(257), '<g>'.repeat(17) + '</g>'.repeat(17)]) assert.throws(() => normalizeIdentityIcon(uri(svg(body))), undefined, body);
  for (const text of ['<!DOCTYPE svg [<!ENTITY x "x">]>'+svg('<path/>'), svg('<path/>')+'<svg/>', svg('<path/>').replace('0 0 24 24','0 0 0 24'), svg('<path/>').replace('viewBox','width="257" viewBox'), svg('<path/>')+'x', '<svg viewBox="0 0 24 24"/>']) assert.throws(() => normalizeIdentityIcon(uri(text)));
  assert.throws(() => normalizeIdentityIcon('data:image/svg+xml;base64,'+Buffer.from([255,254]).toString('base64')));
  assert.throws(() => normalizeIdentityIcon(uri(svg('<path d="M0 0'+' L1 1'.repeat(14000)+'"/>'))));
});
test('presentation references use authoritative native mark and palette catalogs', () => {
  for (const native of vendors.MARK_IDS) {
    assert.deepEqual(normalizePresentation({icon:{native}}), {icon:{native}});
    assert.ok(fs.existsSync(path.resolve(__dirname,'../../assets/icons',vendors.ROW_ICON_MASKS[native]+'.svg')));
  }
  for (const palette of vendors.VENDOR_IDS) assert.deepEqual(normalizePresentation({color:{palette}}), {color:{palette}});
  assert.deepEqual(normalizePresentation({color:{hex:'#AbCdEf'}}), {color:{hex:'#abcdef'}});
  for (const value of [null, [], {bad:1}, {icon:{}}, {icon:{native:'unknown'}}, {icon:{native:'codex',data:art}}, {icon:{data:art,mode:'html'}}, {icon:{data:'https://example.test/a.svg'}}, {color:{}}, {color:{palette:'unknown'}}, {color:{palette:'codex',hex:'#123456'}}, {color:{hex:'red'}}, {color:{hex:'var(--token)'}}]) assert.throws(() => normalizePresentation(value));
});
test('manifest/package/catalog carry independent plugin defaults and module overrides without author code', () => {
  const presentation = {icon:{native:'codex'},color:{palette:'codex'}};
  const manifest = {tmApi:1,id:'visual-demo',name:'Visual demo',version:'1.0.0',backend:'backend.cjs',files:['backend.cjs'],identityIcon:art,presentation,limits:[{id:'one',name:'Same name'},{id:'two',name:'Same name',presentation:{icon:{data:art,mode:'mask'},color:{hex:'#123456'}}}]};
  const normalized = normalizeManifest(manifest); assert.equal(normalized.ok,true,JSON.stringify(normalized.errors));
  assert.deepEqual(normalized.manifest.presentation,presentation);
  const {createPluginLimits}=require('../../src/electron/plugins/limits');
  const service=createPluginLimits({manager:{list:()=>({plugins:[{...normalized.manifest,status:'active',revision:'r1'}]})},getSettings:()=>({}),changed:()=>{}});
  const rows=service.catalog();
  assert.deepEqual(rows[0].presentation,presentation);
  assert.equal(rows[1].presentation.color.hex,'#123456');
  assert.notEqual(rows[0].id,rows[1].id);
  const {parsePackage,describePackage}=require('../../src/electron/plugins/package');
  const preview=describePackage(parsePackage(Buffer.from(JSON.stringify({format:2,manifest,files:{'backend.cjs':Buffer.from('module.exports={};').toString('base64')}}))));
  assert.deepEqual(preview.presentation,presentation); assert.equal(preview.identityIcon,art);
  const {parseIndex}=require('../../src/electron/plugins/catalogSources');
  const index={format:1,title:'Visuals',plugins:[{id:manifest.id,name:manifest.name,presentation,identityIcon:art,versions:[{version:'1.0.0',sha256:'a'.repeat(64),url:'https://example.test/a.tmplugin'}]}]};
  assert.deepEqual(parseIndex(Buffer.from(JSON.stringify(index))).plugins[0].presentation,presentation);
  assert.equal(normalizeManifest({...manifest,presentation:{icon:{native:'unknown'}}}).ok,false);
  assert.equal(normalizeManifest({...manifest,limits:[{id:'one',name:'One',presentation:{color:{hex:'red'}}}]}).ok,false);
  service.dispose();
});
