'use strict';

// Shared by ensure-vendored-tokscale.js and the verification scripts so they
// can never resolve a different binary path than each other.

const fs = require('node:fs');
const path = require('node:path');

function loadManifest() {
  const manifestPath = path.join(__dirname, 'vendor', 'tokscale.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

// "override" (the default when the field is absent, for manifests written
// before this toggle existed) applies the pinned fork build below and runs
// the vendored-binary verification gates against it. "upstream" makes every
// consumer of this manifest a no-op — no download, no verification — so the
// plain npm-installed tokscale is authoritative. This is a data flip, not an
// infrastructure change: the override fields stay in the manifest either way.
function manifestMode(manifest) {
  return manifest.mode === 'upstream' ? 'upstream' : 'override';
}

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function runtimePlatformKey() {
  if (process.platform !== 'linux') return platformKey();
  try {
    const glibcVersion = process.report?.getReport()?.header?.glibcVersionRuntime;
    if (!glibcVersion) return `${process.platform}-${process.arch}-musl`;
  } catch (_) {}
  return platformKey();
}

function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'tokscale.exe' : 'tokscale';
}

function resolvePackageBinDir(packageName) {
  const pkgJsonPath = require.resolve(`${packageName}/package.json`, { paths: [process.cwd()] });
  return path.dirname(pkgJsonPath);
}

function resolveManifestEntry(manifest, requestedKey = null) {
  const key = requestedKey || platformKey();
  const entry = manifest.platforms[key];
  if (!entry) {
    throw new Error(`No vendored tokscale binary recorded for platform ${key} in scripts/vendor/tokscale.json`);
  }
  return { key, entry };
}

function resolveOptionalManifestEntry(manifest, requestedKey = null) {
  const key = requestedKey || runtimePlatformKey();
  return { key, entry: manifest.platforms[key] || null };
}

function resolveTargetBinPath(entry, targetPlatform = process.platform) {
  const binDir = resolvePackageBinDir(entry.package);
  return path.join(binDir, 'bin', binaryName(targetPlatform));
}

// The npm-installed platform package's own package.json version — the same
// field collector.js's locateBundledBinary() reports as the "bundled" version,
// and tokscaleUpdater.js's semver comparison uses as its baseline.
// The vendor override must only ever apply on top of the exact version it was
// built against: if package.json disagrees, some other change already bumped
// the tokscale dependency, and overwriting its binary anyway would silently
// ship stale vendor bytes under a newer version label.
function resolveInstalledPackageVersion(entry) {
  const binDir = resolvePackageBinDir(entry.package);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(binDir, 'package.json'), 'utf8'));
  return pkgJson.version;
}

module.exports = {
  loadManifest,
  manifestMode,
  platformKey,
  runtimePlatformKey,
  binaryName,
  resolvePackageBinDir,
  resolveManifestEntry,
  resolveOptionalManifestEntry,
  resolveTargetBinPath,
  resolveInstalledPackageVersion
};
