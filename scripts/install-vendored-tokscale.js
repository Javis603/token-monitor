'use strict';

// Overwrites the npm-installed tokscale platform binary with the pinned
// downstream build recorded in vendor/tokscale.json. Bridges DSH support
// merged upstream (junhoyeo/tokscale@<commit>) but not yet in a tagged
// tokscale npm release — see vendor/tokscale.json's "reason" field.
//
// Must run after `npm ci` and before any platform packaging step, since
// electron-builder/dist:* bundle whatever bytes are on disk under
// node_modules/@tokscale/**/bin/ at the time they run. Follow with
// verify-vendored-tokscale.js, which is the release gate that actually
// proves the swapped binary parses DSH correctly.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { loadManifest, resolveManifestEntry, resolveTargetBinPath, resolveInstalledPackageVersion } = require('./vendoredTokscale');

const MAX_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;

async function downloadAsset(manifest, entry) {
  const url = `https://github.com/${manifest.releaseRepo}/releases/download/${manifest.releaseTag}/${entry.asset}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_BYTES) throw new Error(`Asset too large: ${contentLength} bytes`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new Error(`Asset too large: ${buffer.length} bytes`);
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

function verifySha256(buffer, expected) {
  const actual = crypto.createHash('sha256').update(buffer).digest('hex');
  if (actual !== expected) {
    throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}

function smokeTest(binPath) {
  const result = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw new Error(`Binary failed to execute: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Binary exited ${result.status}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function main() {
  const manifest = loadManifest();
  const { key, entry } = resolveManifestEntry(manifest);
  console.log(`Installing vendored tokscale (${manifest.releaseTag}, source ${manifest.commit.slice(0, 12)}) for ${key}...`);

  const targetBinPath = resolveTargetBinPath(entry);
  if (!fs.existsSync(targetBinPath)) {
    throw new Error(`Expected npm-installed binary not found at ${targetBinPath} — did npm ci run first?`);
  }

  // Refuse to overwrite a binary from a different npm-installed version than
  // this override was built against. collector.js's locateBundledBinary()
  // and tokscaleUpdater.js's update check both trust the platform package's
  // package.json version as truth — silently overwriting its binary while
  // that version has moved would ship stale vendor bytes under a newer
  // version label, and the in-app updater would never notice the mismatch.
  // A version drift here means the tokscale dependency was already bumped
  // and this override needs to be updated or removed, not applied blindly.
  const installedVersion = resolveInstalledPackageVersion(entry);
  if (installedVersion !== manifest.baseVersion) {
    throw new Error(
      `Installed ${entry.package} is ${installedVersion}, but this vendor override was built against ` +
        `${manifest.baseVersion}. The tokscale dependency has moved — update vendor/tokscale.json to a new ` +
        `pinned build, or remove the vendor install step if the installed version already includes DSH support.`
    );
  }

  const buffer = await downloadAsset(manifest, entry);
  verifySha256(buffer, entry.sha256);

  const tempPath = `${targetBinPath}.vendor-tmp`;
  fs.writeFileSync(tempPath, buffer);
  if (process.platform !== 'win32') fs.chmodSync(tempPath, 0o755);
  fs.renameSync(tempPath, targetBinPath);

  const version = smokeTest(targetBinPath);
  console.log(`Vendored tokscale installed at ${targetBinPath} (${version})`);
}

main().catch((error) => {
  console.error(`install-vendored-tokscale failed: ${error.message}`);
  process.exit(1);
});
