'use strict';

// Ensures the npm-installed tokscale platform binary is replaced by the
// pinned downstream build recorded in vendor/tokscale.json. This is explicit
// rather than an npm lifecycle hook so install, lint, and test stay offline.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const {
  loadManifest,
  resolveManifestEntry,
  resolveOptionalManifestEntry,
  resolveTargetBinPath,
  resolveInstalledPackageVersion
} = require('./vendoredTokscale');

const MAX_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;

async function downloadAsset(manifest, entry, fetchImpl = fetch) {
  const url = `https://github.com/${manifest.releaseRepo}/releases/download/${manifest.releaseTag}/${entry.asset}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
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

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath, fsImpl = fs) {
  return sha256(fsImpl.readFileSync(filePath));
}

function verifySha256(buffer, expected) {
  const actual = sha256(buffer);
  if (actual !== expected) {
    throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}

function smokeTest(binPath, spawn = spawnSync) {
  const result = spawn(binPath, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw new Error(`Binary failed to execute: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Binary exited ${result.status}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function targetPlatformForKey(key) {
  return String(key).startsWith('win32-') ? 'win32' : String(key).split('-')[0];
}

async function ensureVendoredTokscale({
  manifest = loadManifest(),
  requestedKey = null,
  download = (currentManifest, entry) => downloadAsset(currentManifest, entry),
  fsImpl = fs,
  resolveTarget = resolveTargetBinPath,
  resolveVersion = resolveInstalledPackageVersion,
  resolveOptional = resolveOptionalManifestEntry,
  smoke = smokeTest,
  log = console.log
} = {}) {
  const resolved = requestedKey
    ? resolveManifestEntry(manifest, requestedKey)
    : resolveOptional(manifest);
  const { key, entry } = resolved;

  if (!entry) {
    log(`No vendored tokscale asset for ${key}; keeping the npm binary and using runtime capability filtering.`);
    return { status: 'fallback', key };
  }

  log(`Ensuring vendored tokscale (${manifest.releaseTag}, source ${manifest.commit.slice(0, 12)}) for ${key}...`);

  // An explicitly requested target can be a real cross-arch/cross-OS build
  // (e.g. packaging darwin-x64 for local testing on an Apple Silicon host):
  // the platform is genuinely vendored, but npm's optionalDependencies never
  // installed that platform's package on this host in the first place. That
  // is a materially different condition from an unknown platform key (which
  // resolveManifestEntry already rejected above) — degrade the same way an
  // unsupported host does, rather than crashing a build that never had this
  // binary to begin with.
  let targetBinPath;
  try {
    targetBinPath = resolveTarget(entry, targetPlatformForKey(key));
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      log(`${entry.package} is not installed for ${key} on this host (likely a cross-arch/cross-OS build) — packaging will proceed without the pinned binary for this target.`);
      return { status: 'unavailable', key };
    }
    throw error;
  }
  if (!fsImpl.existsSync(targetBinPath)) {
    throw new Error(`Expected npm-installed binary not found at ${targetBinPath} — did npm ci run first?`);
  }

  const installedVersion = resolveVersion(entry);
  if (installedVersion !== manifest.baseVersion) {
    throw new Error(
      `Installed ${entry.package} is ${installedVersion}, but this vendor override was built against ` +
        `${manifest.baseVersion}. The tokscale dependency has moved — update vendor/tokscale.json to a new ` +
        `pinned build, or remove the vendor ensure step if the installed version already includes DSH support.`
    );
  }

  if (sha256File(targetBinPath, fsImpl) === entry.sha256) {
    log(`Vendored tokscale already matches ${entry.sha256.slice(0, 12)} at ${targetBinPath}; no download needed.`);
    return { status: 'matched', key, targetBinPath };
  }

  const buffer = await download(manifest, entry);
  verifySha256(buffer, entry.sha256);

  // Unique per invocation: ensure now runs from several real entry points
  // (start, agent, every packaging script), so two processes racing to
  // ensure the same stale binary must not share one staging file — the
  // final fs.renameSync is what actually needs to be atomic, and since both
  // processes verify the identical pinned checksum first, whichever renames
  // last is still correct.
  const tempPath = `${targetBinPath}.vendor-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fsImpl.writeFileSync(tempPath, buffer);
    if (process.platform !== 'win32') fsImpl.chmodSync(tempPath, 0o755);
    const version = smoke(tempPath);
    fsImpl.renameSync(tempPath, targetBinPath);
    log(`Vendored tokscale ensured at ${targetBinPath} (${version})`);
    return { status: 'installed', key, targetBinPath, version };
  } finally {
    try { fsImpl.rmSync(tempPath, { force: true }); } catch (_) {}
  }
}

async function main() {
  const platformArg = process.argv.slice(2).find((arg) => arg.startsWith('--platform='));
  const requestedKey = platformArg ? platformArg.slice('--platform='.length) : null;
  return ensureVendoredTokscale({ requestedKey });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ensure-vendored-tokscale failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  MAX_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  downloadAsset,
  ensureVendoredTokscale,
  main,
  sha256,
  sha256File,
  smokeTest,
  verifySha256
};
