'use strict';

// Shared by install-vendored-tokscale.js and verify-vendored-tokscale.js so
// the two scripts can never resolve a different binary path than each other.

const fs = require('node:fs');
const path = require('node:path');

function loadManifest() {
  const manifestPath = path.join(__dirname, '..', 'vendor', 'tokscale.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function binaryName() {
  return process.platform === 'win32' ? 'tokscale.exe' : 'tokscale';
}

function resolvePackageBinDir(packageName) {
  const pkgJsonPath = require.resolve(`${packageName}/package.json`, { paths: [process.cwd()] });
  return path.dirname(pkgJsonPath);
}

function resolveManifestEntry(manifest) {
  const key = platformKey();
  const entry = manifest.platforms[key];
  if (!entry) {
    throw new Error(`No vendored tokscale binary recorded for platform ${key} in vendor/tokscale.json`);
  }
  return { key, entry };
}

function resolveTargetBinPath(entry) {
  const binDir = resolvePackageBinDir(entry.package);
  return path.join(binDir, 'bin', binaryName());
}

module.exports = { loadManifest, platformKey, binaryName, resolvePackageBinDir, resolveManifestEntry, resolveTargetBinPath };
