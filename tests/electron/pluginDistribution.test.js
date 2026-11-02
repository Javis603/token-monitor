'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildDistribution, stageDistribution, packageChangelog, CHANGELOG_FILES } = require('../../scripts/official-plugin-distribution.cjs');
const { parsePackage, digest } = require('../../src/electron/plugins/package');
const { parseIndex } = require('../../src/electron/plugins/catalogSources');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-official-dist-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'dist'), plugin = path.join(source, 'plugins/quota-alerts');
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.cpSync(path.resolve(__dirname, '../../plugins/quota-alerts'), plugin, { recursive: true });
  let sequence = 0;
  function build(version = '0.1.0') {
    const file = path.join(plugin, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
    manifest.version = version; fs.writeFileSync(file, JSON.stringify(manifest));
    for (const [locale, name] of Object.entries(CHANGELOG_FILES)) {
      const changelog = path.join(plugin, name), text = fs.readFileSync(changelog, 'utf8');
      if (!text.includes(`## ${version}\n`)) fs.writeFileSync(changelog, `## ${version}\n\n${locale}: fixture update.\n\n${text}`);
    }
    const output = path.join(root, `build-${sequence++}`);
    const index = buildDistribution(output, { root: source, repository: 'example/token-monitor' });
    return { output, index, file: path.join(output, `quota-alerts-${version}.tmplugin`) };
  }
  return { root, source, plugin, target, build, index: () => JSON.parse(fs.readFileSync(path.join(target, 'catalog.json'))) };
}

test('build uses the actual manifest, package parser, automation label and all localized packaged notes', t => {
  const f = fixture(t), built = f.build(), entry = built.index.plugins[0], version = entry.versions[0];
  assert.equal(built.index.plugins.length, 1);
  const bytes = fs.readFileSync(built.file), pkg = parsePackage(bytes, { checkCompatibility: false });
  parseIndex(fs.readFileSync(path.join(built.output, 'catalog.json')));
  assert.equal(version.sha256, digest(bytes));
  assert.equal(version.engines.tokenMonitor, pkg.rawManifest.engines.tokenMonitor);
  assert.deepEqual(version.types, ['automation']);
  assert.equal(version.url, 'https://raw.githubusercontent.com/example/token-monitor/dist/quota-alerts-0.1.0.tmplugin');
  for (const [locale, filename] of Object.entries(CHANGELOG_FILES)) {
    assert.ok(pkg.files[filename].toString().includes(version.changelog[locale]));
    assert.equal(entry.readmePaths[locale], `plugins/quota-alerts/${filename.replace('CHANGELOG', 'README')}`);
  }
  assert.throws(() => buildDistribution(built.output, { root: f.source }), /Refusing to overwrite/);
});

test('initial staging and an identical rerun preserve exact package and index bytes', t => {
  const f = fixture(t), built = f.build();
  stageDistribution(built.output, f.target);
  const before = fs.readFileSync(path.join(f.target, 'catalog.json'));
  const bytes = fs.readFileSync(path.join(f.target, 'quota-alerts-0.1.0.tmplugin'));
  stageDistribution(built.output, f.target);
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'catalog.json')), before);
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'quota-alerts-0.1.0.tmplugin')), bytes);
});

test('new versions retain published packages and their original release notes', t => {
  const f = fixture(t), first = f.build(); stageDistribution(first.output, f.target);
  const old = f.index().plugins[0].versions[0], oldBytes = fs.readFileSync(first.file);
  const next = f.build('0.2.0'); stageDistribution(next.output, f.target);
  const versions = f.index().plugins[0].versions;
  assert.deepEqual(versions.map(v => v.version), ['0.2.0', '0.1.0']);
  assert.deepEqual(versions[1], old);
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'quota-alerts-0.1.0.tmplugin')), oldBytes);
});

test('the 33rd release keeps the newest 32 catalog versions and leaves evicted packages immutable', t => {
  const f = fixture(t), first = f.build(); stageDistribution(first.output, f.target);
  const original = fs.readFileSync(first.file);
  for (let version = 2; version <= 33; version++) {
    const built = f.build(`0.${version}.0`); stageDistribution(built.output, f.target);
  }
  const versions = f.index().plugins[0].versions;
  assert.equal(versions.length, 32);
  assert.equal(versions[0].version, '0.33.0');
  assert.equal(versions.at(-1).version, '0.2.0');
  parseIndex(fs.readFileSync(path.join(f.target, 'catalog.json')));
  const oldFile = path.join(f.target, 'quota-alerts-0.1.0.tmplugin');
  assert.deepEqual(fs.readFileSync(oldFile), original, 'old package remains downloadable');
  const before = f.index(), republished = f.build('0.1.0');
  assert.throws(() => stageDistribution(republished.output, f.target), /refusing to overwrite/);
  assert.deepEqual(f.index(), before);
  assert.deepEqual(fs.readFileSync(oldFile), original);
});

test('a release outside the retained history is rejected before writing packages or catalog', t => {
  const f = fixture(t);
  for (let version = 2; version <= 33; version++) {
    const built = f.build(`0.${version}.0`); stageDistribution(built.output, f.target);
  }
  const before = fs.readFileSync(path.join(f.target, 'catalog.json'));
  const files = fs.readdirSync(f.target).sort();
  const patch = f.build('0.1.1');
  assert.throws(() => stageDistribution(patch.output, f.target), /outside the newest 32 catalog versions/);
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'catalog.json')), before);
  assert.deepEqual(fs.readdirSync(f.target).sort(), files);
});

test('changed bytes under a published version fail before changing files or catalog', t => {
  const f = fixture(t), first = f.build(); stageDistribution(first.output, f.target);
  const before = fs.readFileSync(path.join(f.target, 'catalog.json'));
  fs.appendFileSync(path.join(f.plugin, 'ui.mjs'), '\n// fixture changed bytes\n');
  const changed = f.build();
  assert.throws(() => stageDistribution(changed.output, f.target), /immutable/);
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'catalog.json')), before);
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'quota-alerts-0.1.0.tmplugin')), fs.readFileSync(first.file));
});

test('tampered bytes and mismatched package identity cannot enter the distribution', t => {
  const f = fixture(t), built = f.build(), original = fs.readFileSync(built.file);
  fs.appendFileSync(built.file, 'tampered');
  assert.throws(() => stageDistribution(built.output, f.target), /hash mismatch/);
  assert.equal(fs.existsSync(f.target), false);
  const data = JSON.parse(original); data.manifest.version = '9.0.0';
  const bytes = Buffer.from(JSON.stringify(data)); fs.writeFileSync(built.file, bytes);
  built.index.plugins[0].versions[0].sha256 = digest(bytes);
  fs.writeFileSync(path.join(built.output, 'catalog.json'), JSON.stringify(built.index));
  assert.throws(() => stageDistribution(built.output, f.target), /metadata differ/);
  assert.equal(fs.existsSync(f.target), false);
});

test('missing or corrupt retained packages stop the next catalog update', t => {
  const f = fixture(t), first = f.build(); stageDistribution(first.output, f.target);
  const before = f.index(), next = f.build('0.2.0');
  const oldFile = path.join(f.target, 'quota-alerts-0.1.0.tmplugin');
  fs.writeFileSync(oldFile, 'corrupt history');
  assert.throws(() => stageDistribution(next.output, f.target), /published package hash mismatch/);
  fs.rmSync(oldFile);
  assert.throws(() => stageDistribution(next.output, f.target), /ENOENT/);
  assert.deepEqual(f.index(), before);
  assert.equal(fs.existsSync(path.join(f.target, 'quota-alerts-0.2.0.tmplugin')), false);
});

test('release notes select the packaged version and reject missing, duplicate or invalid summaries', () => {
  const files = Object.fromEntries(Object.values(CHANGELOG_FILES).map(name => [name, Buffer.from('## 0.2.0\nNew.\n\n## 0.1.0\nInitial.\n')]));
  assert.equal(packageChangelog(files, '0.1.0').en, 'Initial.');
  assert.equal(packageChangelog(files, '0.2.0').en, 'New.');
  files['CHANGELOG.md'] = Buffer.from('## 0.1.0\nA\n## 0.1.0\nB');
  assert.throws(() => packageChangelog(files, '0.1.0'), /exactly one/);
  files['CHANGELOG.md'] = Buffer.from('## 0.1.0\n');
  assert.throws(() => packageChangelog(files, '0.1.0'), /1–2000/);
  delete files['CHANGELOG.md'];
  assert.throws(() => packageChangelog(files, '0.1.0'), /Missing/);
});
