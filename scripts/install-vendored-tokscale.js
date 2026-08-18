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
const { loadManifest, resolveManifestEntry, resolveTargetBinPath } = require('./vendoredTokscale');

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
