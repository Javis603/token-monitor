'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const { normalizeManifest } = require('../../shared/plugins/manifest');
const { localize } = require('../../shared/plugins/localized');
const { missingGrant, riskSummary } = require('../../shared/plugins/permissions');
// Room for the full Worker code allowance plus the encoded Rich assets.
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
const { MAX_CODE_BYTES, MAX_MANIFEST_BYTES, assertHostCompatibility } = require('./contracts');
const { assetPath } = require('../../shared/plugins/webUi');
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function contentDigest({ rawManifest, code, assets }) {
  // Hash installed content independently of archive whitespace, key ordering,
  // or base64 representation. Keep raw manifest fields, including extensions.
  const content = ['tmplugin-content-v1', rawManifest, code,
    Object.entries(assets).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, bytes]) => [name, bytes.toString('base64')])];
  return digest(JSON.stringify(content, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value));
}
function readBounded(file, limit) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(`file exceeds ${limit} bytes or is not a regular file`);
    const buffer = Buffer.alloc(limit + 1);
    let count = 0, read;
    while (count <= limit && (read = fs.readSync(fd, buffer, count, buffer.length - count, null))) count += read;
    if (count > limit) throw new Error(`file exceeds ${limit} bytes`);
    return buffer.subarray(0, count);
  } finally { fs.closeSync(fd); }
}
function entryName(name) {
  if (typeof name !== 'string' || !name.endsWith('.js') || name.length > 120) return false;
  return name.split('/').every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part) && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function parsePackage(bytes, { checkCompatibility = true } = {}) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > MAX_PACKAGE_BYTES) throw new Error(`plugin package exceeds ${MAX_PACKAGE_BYTES / 1024 / 1024} MB`);
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('plugin package must contain valid UTF-8 JSON'); }
  if (!data || data.format !== 1 || !data.manifest || Array.isArray(data.manifest)) throw new Error('unsupported plugin package format');
  if (Object.keys(data).some(key => !['format', 'manifest', 'code', 'assets'].includes(key))) throw new Error('unknown package fields');
  if (Buffer.byteLength(JSON.stringify(data.manifest)) > MAX_MANIFEST_BYTES) throw new Error('manifest exceeds 256 KB');
  let result;
  try { result = normalizeManifest(data.manifest); } catch { throw new Error('invalid plugin manifest'); }
  if (!result.ok || result.errors.length) throw new Error(`invalid plugin manifest: ${result.errors.join('; ')}`);
  if (checkCompatibility) assertHostCompatibility(data.manifest);
  if (!semver.valid(result.manifest.version)) throw new Error('invalid plugin version');
  if (result.manifest.main) {
    if (!entryName(result.manifest.main)) throw new Error('entry must be a portable, contained .js path');
    if (typeof data.code !== 'string' || Buffer.byteLength(data.code) > MAX_CODE_BYTES) throw new Error(`entry code must be text under ${MAX_CODE_BYTES / 1024 / 1024} MB`);
  } else if (data.code !== undefined && data.code !== null) throw new Error('package has code but manifest has no main');
  const assets = validateAssets(data.assets, result.manifest);
  return { assets, bytes: Buffer.from(bytes), hash: digest(bytes), manifest: result.manifest, rawManifest: data.manifest, code: data.code ?? null };
}
function packageDirectory(dir, options) {
  const root = fs.realpathSync(dir);
  const inside = name => {
    const file = fs.realpathSync(path.join(root, name));
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('plugin file escapes its directory');
    return file;
  };
  const manifest = JSON.parse(readBounded(inside('manifest.json'), MAX_MANIFEST_BYTES).toString('utf8'));
  if (manifest.main && !entryName(manifest.main)) throw new Error('invalid entry path');
  const code = manifest.main ? new TextDecoder('utf-8', { fatal: true }).decode(readBounded(inside(manifest.main), MAX_CODE_BYTES)) : null;
  const validated = normalizeManifest(manifest);
  if (!validated.ok || validated.errors.length) throw new Error('invalid plugin manifest');
  let assetBytes = 0;
  const assets = Object.fromEntries((validated.manifest.webUi?.assets || []).map(name => {
    if (!assetPath(name)) throw new Error('invalid asset path');
    const bytes = readBounded(inside(name), 512 * 1024); assetBytes += bytes.length;
    if (assetBytes > 1024 * 1024) throw new Error('asset budget exceeded');
    return [name, bytes.toString('base64')];
  }));
  return parsePackage(Buffer.from(JSON.stringify({ format: 1, manifest, code, ...(Object.keys(assets).length ? { assets } : {}) })), options);
}
function validateAssets(raw, manifest) {
  const expected = manifest.webUi?.assets || [];
  if (raw !== undefined && (!raw || Array.isArray(raw) || typeof raw !== 'object')) throw new Error('invalid assets');
  const entries = Object.entries(raw || {});
  if (entries.length !== expected.length) throw new Error('asset list mismatch');
  // A package must unpack identically on case-sensitive and insensitive hosts.
  // Include files outside assets and file/directory prefixes in the same check.
  const paths = ['manifest.json', ...(manifest.main ? [manifest.main] : []), ...entries.map(([name]) => name)]
    .map(name => name.toLowerCase());
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    if (paths[i] === paths[j] || paths[i].startsWith(paths[j] + '/') || paths[j].startsWith(paths[i] + '/')) {
      throw new Error('conflicting package paths');
    }
  }
  let total = 0;
  const result = {};
  for (const [name, encoded] of entries) {
    if (!expected.includes(name) || !assetPath(name) || name === manifest.main || name === 'manifest.json' || typeof encoded !== 'string') throw new Error('undeclared or conflicting asset');
    const bytes = Buffer.from(encoded, 'base64');
    total += bytes.length;
    if (bytes.toString('base64') !== encoded || bytes.length > 512 * 1024 || total > 1024 * 1024) throw new Error('invalid asset encoding or budget');
    result[name] = bytes;
  }
  return result;
}
function unpackPackage(pkg, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(pkg.rawManifest), { flag: 'wx', mode: 0o600 });
  for (const [name, bytes] of Object.entries(pkg.assets || {})) {
    const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  }
  if (pkg.manifest.main) {
    const file = path.join(dir, pkg.manifest.main);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, pkg.code, { flag: 'wx', mode: 0o600 });
  }
}
function describePackage(pkg, { locale = 'en', grant } = {}) {
  const m = pkg.manifest;
  return { id: m.id, version: m.version, name: localize(m.name, locale), description: localize(m.description, locale), author: m.author,
    identityIcon: m.identityIcon, icon: m.views[0]?.icon || 'dot',
    permissions: [...m.permissions], hosts: [...m.network.hosts], missing: missingGrant(m, grant), risk: riskSummary(m), hasCode: Boolean(m.main), sha256: pkg.hash };
}
module.exports = { MAX_PACKAGE_BYTES, ID_RE, digest, contentDigest, readBounded, parsePackage, packageDirectory, unpackPackage, describePackage };
