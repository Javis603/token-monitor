'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeManifest, filePath, ID_RE } = require('../../shared/plugins/manifest');
const { localize } = require('../../shared/plugins/localized');
const { pluginTypes } = require('./types');
const { MAX_MANIFEST_BYTES, assertHostCompatibility } = require('./contracts');
// Packaging/IO bounds, not runtime capabilities. Dependencies must be bundled.
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
function contentDigest({ rawManifest, files }) {
  return digest(canonical(['tmplugin-content-v2', rawManifest, Object.keys(files).sort().map(name => [name, files[name].toString('base64')])]));
}
function readBounded(file, limit) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(`file exceeds ${limit} bytes or is not a regular file`);
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0, read;
    while (count <= limit && (read = fs.readSync(fd, buffer, count, buffer.length - count, null))) count += read;
    if (count > stat.size || count > limit) throw new Error(`file exceeds ${limit} bytes`);
    return buffer.subarray(0, count);
  } finally { fs.closeSync(fd); }
}

function parsePackage(bytes, { checkCompatibility = true } = {}) {
  bytes = Buffer.from(bytes);
  if (bytes.length > MAX_PACKAGE_BYTES) throw new Error('plugin package exceeds 64 MiB');
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('plugin package must contain valid UTF-8 JSON'); }
  if (!data || data.format !== 2) throw new Error('incompatible-plugin-package: format 2 is required');
  if (Object.keys(data).some(key => !['format', 'manifest', 'files'].includes(key))) throw new Error('unknown package fields');
  if (Buffer.byteLength(JSON.stringify(data.manifest) || '') > MAX_MANIFEST_BYTES) throw new Error('manifest exceeds 256 KiB');
  const result = normalizeManifest(data.manifest);
  if (!result.ok) throw new Error(`invalid plugin manifest: ${result.errors.join('; ')}`);
  if (checkCompatibility) assertHostCompatibility(data.manifest);
  if (!data.files || typeof data.files !== 'object' || Array.isArray(data.files)) throw new Error('invalid package files');
  const entries = Object.entries(data.files), expected = result.manifest.files;
  if (entries.length !== expected.length) throw new Error('package file list mismatch');
  const paths = ['manifest.json', ...entries.map(([name]) => name.toLowerCase())];
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    if (paths[i] === paths[j] || paths[i].startsWith(paths[j] + '/') || paths[j].startsWith(paths[i] + '/')) throw new Error('conflicting package paths');
  }
  const files = Object.create(null);
  for (const [name, encoded] of entries) {
    if (!filePath(name) || !expected.includes(name) || typeof encoded !== 'string') throw new Error('invalid package file');
    const value = Buffer.from(encoded, 'base64');
    if (value.toString('base64') !== encoded) throw new Error('invalid file encoding');
    files[name] = value;
  }
  return { bytes, hash: digest(bytes), manifest: result.manifest, rawManifest: data.manifest, files };
}
function packageDirectory(dir, options) {
  const directory = fs.lstatSync(dir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('plugin directory must not be a symbolic link');
  const root = fs.realpathSync(dir);
  const read = (name, limit) => {
    if (!filePath(name)) throw new Error('invalid package path');
    let current = root;
    const parts = name.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const entry = fs.lstatSync(current);
      if (entry.isSymbolicLink() || (i < parts.length - 1 ? !entry.isDirectory() : !entry.isFile())) throw new Error('plugin paths must be regular files and directories without symbolic links');
    }
    const resolved = fs.realpathSync(path.join(root, name));
    if (!resolved.startsWith(root + path.sep)) throw new Error('plugin file escapes its directory');
    return readBounded(resolved, limit);
  };
  const manifest = JSON.parse(read('manifest.json', MAX_MANIFEST_BYTES).toString('utf8'));
  const result = normalizeManifest(manifest);
  if (!result.ok) throw new Error(result.errors.join('; '));
  let total = 0;
  const files = Object.fromEntries(result.manifest.files.map(name => {
    const bytes = read(name, MAX_PACKAGE_BYTES - total); total += bytes.length;
    return [name, bytes.toString('base64')];
  }));
  return parsePackage(Buffer.from(JSON.stringify({ format: 2, manifest, files })), options);
}
function unpackPackage(pkg, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(pkg.rawManifest), { flag: 'wx', mode: 0o600 });
  for (const [name, bytes] of Object.entries(pkg.files)) {
    const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  }
}
function describePackage(pkg, { locale = 'en' } = {}) {
  const m = pkg.manifest;
  return { id: m.id, version: m.version, name: localize(m.name, locale), description: localize(m.description, locale), author: m.author,
    views: m.views.map(view => ({ ref: `${m.id}/${view.id}`, title: localize(view.title, locale), surfaces: view.surfaces, defaultSurfaces: view.defaultSurfaces, targets: view.targets, mode: view.mode })),
    types: pluginTypes(m), identityIcon: m.identityIcon, icon: m.views[0]?.icon || 'dot',
    trustedCode: true, hasCode: Boolean(m.ui || m.backend), hasBackend: Boolean(m.backend), sha256: pkg.hash };
}
module.exports = { MAX_PACKAGE_BYTES, ID_RE, digest, contentDigest, readBounded, parsePackage, packageDirectory, unpackPackage, describePackage };
