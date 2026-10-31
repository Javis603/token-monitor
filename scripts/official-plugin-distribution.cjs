'use strict';
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');
const { packageDirectory, parsePackage, digest, readBounded, MAX_PACKAGE_BYTES } = require('../src/electron/plugins/package');
const { parseIndex } = require('../src/electron/plugins/catalogSources');
const { pluginTypes } = require('../src/electron/plugins/types');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS = Object.freeze(['quota-alerts']);
const REPOSITORY = 'Javis603/token-monitor';
const CHANGELOG_FILES = Object.freeze({ en: 'CHANGELOG.md', 'zh-CN': 'CHANGELOG.zh-CN.md', 'zh-TW': 'CHANGELOG.zh-TW.md',
  ko: 'CHANGELOG.ko.md', ja: 'CHANGELOG.ja.md', 'pt-BR': 'CHANGELOG.pt-BR.md' });

function packageChangelog(files, version) {
  return Object.fromEntries(Object.entries(CHANGELOG_FILES).map(([locale, filename]) => {
    if (!files[filename]) throw Error(`Missing packaged ${filename}`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(files[filename]);
    const sections = [...text.matchAll(/^## (.+)\r?$/gm)];
    const matching = sections.filter(section => section[1].trim() === version);
    if (matching.length !== 1) throw Error(`${filename}: needs exactly one section for ${version}`);
    const section = matching[0], next = sections[sections.indexOf(section) + 1];
    const notes = text.slice(section.index + section[0].length, next?.index ?? text.length).trim();
    if (!notes || notes.length > 2000) throw Error(`${filename}: release notes must contain 1–2000 characters`);
    return [locale, notes];
  }));
}

function readCatalog(file) {
  const bytes = readBounded(file, 1024 * 1024);
  parseIndex(bytes);
  return JSON.parse(bytes);
}

function buildDistribution(output, { root = ROOT, repository = REPOSITORY } = {}) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw Error('Invalid repository');
  const base = `https://raw.githubusercontent.com/${repository}/dist/`;
  const artifacts = PLUGINS.map(id => {
    // The target App can be newer than the version still carried by this checkout.
    const pkg = packageDirectory(path.join(root, 'plugins', id), { checkCompatibility: false });
    const m = pkg.rawManifest;
    if (m.id !== id || !m.engines?.tokenMonitor) throw Error(`${id}: explicit identity and App compatibility range are required`);
    const filename = `${id}-${m.version}.tmplugin`;
    const readmePaths = Object.fromEntries(Object.entries(CHANGELOG_FILES).map(([locale, name]) => {
      const readme = name.replace('CHANGELOG', 'README');
      if (!pkg.files[readme]) throw Error(`${id}: missing packaged ${readme}`);
      return [locale, `plugins/${id}/${readme}`];
    }));
    return { filename, bytes: pkg.bytes, entry: { id, name: m.name, description: m.description, author: m.author,
      identityIcon: m.identityIcon, repository: `https://github.com/${repository}`, readmePaths,
      versions: [{ version: m.version, url: base + filename, sha256: pkg.hash, engines: m.engines,
        types: pluginTypes(pkg.manifest), changelog: packageChangelog(pkg.files, m.version) }] } };
  });
  const index = { format: 1, title: 'Token Monitor', plugins: artifacts.map(item => item.entry) };
  const catalog = Buffer.from(JSON.stringify(index, null, 2) + '\n');
  parseIndex(catalog);
  for (const filename of ['catalog.json', ...artifacts.map(item => item.filename)]) {
    if (fs.existsSync(path.join(output, filename))) throw Error(`Refusing to overwrite ${filename}; use a fresh build directory`);
  }
  fs.mkdirSync(output, { recursive: true });
  for (const { filename, bytes } of artifacts) fs.writeFileSync(path.join(output, filename), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'catalog.json'), catalog, { flag: 'wx' });
  return index;
}

// Stage files locally. Only the workflow's final push publishes this directory.
function stageDistribution(source, target) {
  const index = readCatalog(path.join(source, 'catalog.json'));
  const previousFile = path.join(target, 'catalog.json');
  const previous = fs.existsSync(previousFile) ? readCatalog(previousFile) : { plugins: [] };
  const copies = [];
  for (const plugin of index.plugins) {
    const old = previous.plugins.find(entry => entry.id === plugin.id);
    for (const version of old?.versions || []) {
      const filename = `${plugin.id}-${version.version}.tmplugin`;
      const bytes = readBounded(path.join(target, filename), MAX_PACKAGE_BYTES);
      if (digest(bytes) !== version.sha256) throw Error(`${filename}: published package hash mismatch`);
    }
    for (const version of plugin.versions) {
      const filename = `${plugin.id}-${version.version}.tmplugin`;
      const bytes = readBounded(path.join(source, filename), MAX_PACKAGE_BYTES);
      if (digest(bytes) !== version.sha256) throw Error(`${filename}: package hash mismatch`);
      const pkg = parsePackage(bytes, { checkCompatibility: false });
      if (pkg.manifest.id !== plugin.id || pkg.manifest.version !== version.version || pkg.rawManifest.engines?.tokenMonitor !== version.engines?.tokenMonitor) {
        throw Error(`${filename}: catalog and package metadata differ`);
      }
      const published = old?.versions.find(entry => entry.version === version.version);
      if (published && published.sha256 !== version.sha256) throw Error(`${filename}: published versions are immutable; bump the plugin version`);
      const file = path.join(target, filename);
      if (fs.existsSync(file)) {
        if (!readBounded(file, MAX_PACKAGE_BYTES).equals(bytes)) throw Error(`${filename}: refusing to overwrite a published package`);
      } else copies.push({ file, bytes });
    }
    const retained = [...plugin.versions, ...(old?.versions || []).filter(version => !plugin.versions.some(current => current.version === version.version))]
      .sort((a, b) => semver.rcompare(a.version, b.version)).slice(0, 32);
    for (const version of plugin.versions) {
      if (!retained.some(entry => entry.version === version.version)) {
        throw Error(`${plugin.id}@${version.version}: outside the newest 32 catalog versions; refusing an undiscoverable release`);
      }
    }
    plugin.versions = retained;
  }
  const bytes = Buffer.from(JSON.stringify(index, null, 2) + '\n');
  // Validate the retained history against the same limits the App enforces.
  parseIndex(bytes);
  fs.mkdirSync(target, { recursive: true });
  for (const { file, bytes } of copies) fs.writeFileSync(file, bytes, { flag: 'wx' });
  fs.writeFileSync(previousFile, bytes);
  return index;
}

if (require.main === module) {
  const [operation, source, target, ...extra] = process.argv.slice(2);
  if (operation === 'build' && source && !target) buildDistribution(path.resolve(source), { repository: process.env.PLUGIN_REPOSITORY || REPOSITORY });
  else if (operation === 'stage' && source && target && !extra.length) stageDistribution(path.resolve(source), path.resolve(target));
  else throw Error('Usage: official-plugin-distribution.cjs build <output> | stage <build> <distribution-directory>');
}
module.exports = { buildDistribution, stageDistribution, packageChangelog, CHANGELOG_FILES };
