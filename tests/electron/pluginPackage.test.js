'use strict';

const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { packageDirectory, parsePackage, unpackPackage, contentDigest } = require('../../src/electron/plugins/package');
test('content fingerprints are invariant across process locale and file insertion order', () => {
  const code = `const {contentDigest}=require(${JSON.stringify(require.resolve('../../src/electron/plugins/package'))}); console.log(contentDigest({rawManifest:{id:'fixture'},files:{'z.js':Buffer.from('z'),'t.js':Buffer.from('t'),'A.js':Buffer.from('a'),'_a.js':Buffer.from('a')}}));`;
  const hashes = ['en_US.UTF-8', 'et_EE.UTF-8'].map(locale => {
    const result = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, LANG: locale, LC_ALL: locale }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  });
  assert.equal(hashes[0], hashes[1]);
  assert.equal(hashes[0], contentDigest({ rawManifest: {id:'fixture'}, files: {'_a.js':Buffer.from('a'),'A.js':Buffer.from('a'),'t.js':Buffer.from('t'),'z.js':Buffer.from('z')} }));
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-package-v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifest = { tmApi: 1, id: 'package-fixture', name: 'Fixture', version: '1.0.0', backend: 'backend.cjs', files: ['backend.cjs'] };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'backend.cjs'), '\ufeffexports.activate=()=>({});');
  return { dir, manifest };
}
test('plugin packaging preserves BOM/native bytes and canonical installed fingerprints', t => {
  const { dir, manifest } = fixture(t);
  manifest.files.push('binding.node');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'binding.node'), Buffer.from([0, 255, 1, 128]));
  const pkg = packageDirectory(dir), target = path.join(dir, 'unpacked');
  unpackPackage(pkg, target);
  assert.deepEqual(packageDirectory(target).files, pkg.files);
  assert.equal(contentDigest(packageDirectory(target)), contentDigest(pkg));
  fs.appendFileSync(path.join(target, 'backend.cjs'), '// changed');
  assert.notEqual(contentDigest(packageDirectory(target)), contentDigest(pkg));
});
test('package file aliases cannot bypass path collision checks', t => {
  const { dir } = fixture(t); const value = JSON.parse(packageDirectory(dir).bytes);
  for (const name of ['backend.cjs/child', 'BACKEND.cjs', '../escape']) {
    const copy = structuredClone(value); copy.manifest.files.push(name); copy.files[name] = '';
    assert.throws(() => parsePackage(Buffer.from(JSON.stringify(copy))));
  }
});
test('directory imports reject internal file symlinks rather than treating them as regular assets', { skip: process.platform === 'win32' }, t => {
  const { dir } = fixture(t);
  fs.renameSync(path.join(dir, 'backend.cjs'), path.join(dir, 'actual.cjs'));
  fs.symlinkSync('actual.cjs', path.join(dir, 'backend.cjs'));
  assert.throws(() => packageDirectory(dir), /symbolic links/);
});
test('directory imports reject linked path components and a linked package root', t => {
  const { dir, manifest } = fixture(t);
  const actual = path.join(dir, 'actual'); fs.mkdirSync(actual); fs.copyFileSync(path.join(dir, 'backend.cjs'), path.join(actual, 'backend.cjs'));
  fs.symlinkSync(actual, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  manifest.backend = 'linked/backend.cjs'; manifest.files = [manifest.backend];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => packageDirectory(dir), /symbolic links/);
  assert.throws(() => packageDirectory(path.join(dir, 'linked')), /symbolic link/);
});
