'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const { pageSnapshot, assetPath } = require('../../src/shared/plugins/webUi');
const { packageDirectory, unpackPackage, parsePackage } = require('../../src/electron/plugins/package');
const { boundsFor, themeContext, CSP } = require('../../src/electron/plugins/webUi');
const manifest = () => ({ id: 'web-demo', name: 'Demo', version: '1.0.0', tmApi: 1, permissions: ['ui.web', 'tm.pages'], webUi: { version: 1, assets: ['ui/index.html', 'ui/page.js'], documents: [{ id: 'models', entry: 'ui/index.html', target: 'model', slot: 'replace' }] } });
test('web interface is explicit permissioned and named, not a DOM selector', () => {
  assert.deepEqual(normalizeManifest(manifest()).errors, []);
  for (const edit of [m => m.permissions.pop(), m => m.webUi.documents[0].target = '#models', m => m.webUi.assets.push('../a.js'), m => m.webUi.documents.push(m.webUi.documents[0])]) { const m = manifest(); edit(m); assert.ok(normalizeManifest(m).errors.length); }
  for (const p of ['../x.html','/tmp/a.js','a\\b.js','https://a/b.js','a/CON.js','index.html.','a/%2e%2e/a.js']) assert.equal(assetPath(p), false, p);
});
test('packaged assets survive installation and hashes cover bytes; undeclared/escaping assets fail', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'tm-web-package-')); t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'ui')); fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest())); fs.writeFileSync(path.join(dir,'ui/index.html'),'<script src="page.js"></script>'); fs.writeFileSync(path.join(dir,'ui/page.js'),'console.log(1)');
  const pkg = packageDirectory(dir); const dest = path.join(dir,'installed'); unpackPackage(pkg,dest); assert.equal(packageDirectory(dest).hash,pkg.hash);
  const raw = JSON.parse(pkg.bytes); raw.assets['ui/page.js'] = Buffer.from('console.log(2)').toString('base64'); assert.notEqual(parsePackage(JSON.stringify(raw)).hash,pkg.hash);
  raw.assets['secret.js']=''; assert.throws(() => parsePackage(JSON.stringify(raw)),/mismatch/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-web-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'page.js');
  fs.writeFileSync(target, 'console.log(3)');
  const link = path.join(dir, 'ui/page.js');
  fs.unlinkSync(link);
  fs.symlinkSync(target, link, 'file');
  assert.equal(fs.readFileSync(link, 'utf8'), 'console.log(3)', 'the escape fixture must resolve on every platform');
  assert.throws(() => packageDirectory(dir), /escapes/);
});
test('page bridge drops internal identities, credentials and unknown fields', () => {
  const value = pageSnapshot({ target:'device', period:'today', token:'secret', rows:[{label:'Laptop',tokens:5,costUsd:1,deviceId:'secret',credentials:{key:'secret'}}] });
  assert.deepEqual(value.rows,[{key:'0',label:'Laptop',tokens:5,costUsd:1}]); assert.ok(!JSON.stringify(value).includes('secret'));
});
test('view bounds stay inside host content at zoom and reject invalid dimensions', () => {
  assert.deepEqual(boundsFor({x:10,y:10,width:400,height:300},[380,200],1.5),{x:15,y:15,width:365,height:185});
  assert.equal(boundsFor({x:0,y:0,width:NaN,height:100},[380,200]),null);
  assert.deepEqual(themeContext({colors:{text:'url(file:///x)'},font:'anything'}).colors,{});
  assert.equal(themeContext({font:'serif'}).font,'serif');
  assert.equal(themeContext({font:'serif; background:url(file:///x)'}).font,'system-ui');
  assert.match(CSP,/connect-src 'none'/); assert.match(CSP,/sandbox allow-scripts/);
});

test('surface documents need rendering grant, bind declared views and have one document per variant', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/plugins/examples/surface-studio/manifest.json')));
  assert.deepEqual(normalizeManifest(m).errors, []);
  for (const change of [
    v => { v.permissions = v.permissions.filter(p => p !== 'ui.web'); },
    v => { v.webUi.documents[0].view = 'missing'; },
    v => { v.webUi.documents[0].slot = 'before'; },
    v => { v.webUi.documents[0].variant = 'compact'; },
    v => { v.views[0].surfaces = ['edgeDock']; },
    v => { v.webUi.documents.push({ ...v.webUi.documents[0], id: 'duplicate' }); }
  ]) { const copy = structuredClone(m); change(copy); assert.ok(normalizeManifest(copy).errors.length); }
  const old = manifest(); assert.deepEqual(normalizeManifest(old).errors, []);
});

test('per-document retention is optional, bounded and package-stable', () => {
  for (const retainMs of [0, 1, 30000, 120000, 300000, 86400000, 2147483648, Number.MAX_SAFE_INTEGER, 'until-evicted']) {
    const m = manifest(); m.webUi.documents[0].retainMs = retainMs;
    const result = normalizeManifest(m); assert.deepEqual(result.errors, []);
    assert.equal(result.manifest.webUi.documents[0].retainMs, retainMs);
  }
  for (const retainMs of [-1, Number.MAX_SAFE_INTEGER + 1, 1.5, '30000', 'forever', null, Infinity]) {
    const m = manifest(); m.webUi.documents[0].retainMs = retainMs;
    assert.ok(normalizeManifest(m).errors.length, String(retainMs));
  }
});


test('Home/page documents require matching declared views; settings needs no display view', () => {
  for (const target of ['home', 'page', 'settings']) {
    const m = manifest(); m.permissions = ['ui.web'];
    m.views = target === 'settings' ? [] : [{ id: 'canvas', title: 'Canvas', surfaces: [target], layout: { type: 'text', text: 'Fallback' } }];
    m.webUi.documents = [{ id: 'body', entry: 'ui/index.html', target, slot: 'replace', ...(target === 'settings' ? {} : { view: 'canvas' }) }];
    assert.deepEqual(normalizeManifest(m).errors, [], target);
    for (const mutate of [copy => { copy.webUi.documents[0].slot = 'before'; }, copy => { copy.webUi.documents[0].variant = 'compact'; }, copy => { copy.webUi.documents[0].view = 'foreign'; }, copy => { copy.webUi.documents.push({ ...copy.webUi.documents[0], id: 'duplicate' }); }, copy => { copy.permissions = []; }]) {
      const copy = structuredClone(m); mutate(copy); assert.ok(normalizeManifest(copy).errors.length, target);
    }
  }
});
