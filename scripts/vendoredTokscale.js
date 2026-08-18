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

// The npm-installed platform package's own package.json version — the same
// field collector.js's locateBundledBinary() reports as the "bundled"
// version, and tokscaleUpdater.js's semver comparison uses as its baseline.
// The vendor override must only ever apply on top of the exact version it
// was built against: if package.json disagrees, some other change already
// bumped the tokscale dependency, and overwriting its binary anyway would
// silently ship stale vendor bytes under a newer version label — which also
// blinds the in-app updater, since it trusts this same field.
function resolveInstalledPackageVersion(entry) {
  const binDir = resolvePackageBinDir(entry.package);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(binDir, 'package.json'), 'utf8'));
  return pkgJson.version;
}

module.exports = {
  loadManifest,
  platformKey,
  binaryName,
  resolvePackageBinDir,
  resolveManifestEntry,
  resolveTargetBinPath,
  resolveInstalledPackageVersion
};
