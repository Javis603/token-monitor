'use strict';

// Ensures the npm-installed tokscale platform binary is replaced by the
// pinned downstream build recorded in scripts/vendor/tokscale.json. This is
// explicit rather than an npm lifecycle hook so install, lint, and test stay
// offline.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const {
  loadManifest,
  manifestMode,
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
  // Strict by default: an explicit --platform target that is genuinely
  // vendored but whose npm optional package isn't installed on this host
  // (a real cross-arch build) still fails closed, same as every other
  // packaging/distribution command — "ensure the pinned binary" must mean
  // that, not "ensure it if convenient". The one legitimate exception is a
  // source-only structural CI build that never ships its output (the
  // mac-widget workflow's x64 leg, cross-built on an arm64 runner purely to
  // verify app structure) — that caller opts in explicitly.
  allowMissingTargetPackage = false,
  download = (currentManifest, entry) => downloadAsset(currentManifest, entry),
  fsImpl = fs,
  resolveTarget = resolveTargetBinPath,
  resolveVersion = resolveInstalledPackageVersion,
  resolveOptional = resolveOptionalManifestEntry,
  smoke = smokeTest,
  log = console.log
} = {}) {
  const isUpstream = manifestMode(manifest) === 'upstream';

  const resolved = requestedKey
    ? resolveManifestEntry(manifest, requestedKey)
    : resolveOptional(manifest);
  const { key, entry } = resolved;

  if (!entry) {
    log(`No vendored tokscale asset for ${key}; keeping the npm binary and using runtime capability filtering.`);
    return { status: 'fallback', key };
  }

  // Package-target existence is a packaging precondition, not a vendor-override
  // concern: whether the npm optional package for `key` is actually installed
  // on this host matters the same way whether or not a downstream binary gets
  // swapped in afterward, since a missing package means there is nothing to
  // ship for this target either way. Resolving it before the mode check keeps
  // the cross-arch fail-closed guarantee (and its explicit
  // --allow-missing-target-package escape hatch) in effect under "upstream"
  // too — mode only ever decides binary provenance, never whether this
  // packaging preflight runs.
  let targetBinPath;
  try {
    targetBinPath = resolveTarget(entry, targetPlatformForKey(key));
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      if (!allowMissingTargetPackage) {
        throw new Error(
          `${entry.package} is not installed for ${key} on this host — a real cross-arch/cross-OS build needs ` +
            `that npm optional package present (run npm ci on a matching host, or on the ${key} target directly). ` +
            'If this is deliberately a source-only structural build that never ships its output, pass ' +
            '--allow-missing-target-package to accept packaging without the pinned binary.',
          { cause: error }
        );
      }
      log(`${entry.package} is not installed for ${key} on this host (cross-arch/cross-OS build, explicitly allowed) — packaging will proceed without the pinned binary for this target.`);
      return { status: 'unavailable', key };
    }
    throw error;
  }
  if (!fsImpl.existsSync(targetBinPath)) {
    throw new Error(`Expected npm-installed binary not found at ${targetBinPath} — did npm ci run first?`);
  }

  if (isUpstream) {
    log(`scripts/vendor/tokscale.json mode is "upstream" — no downstream override is active; the npm-installed tokscale at ${targetBinPath} is authoritative. Nothing to replace.`);
    return { status: 'upstream', key, targetBinPath };
  }

  log(`Ensuring vendored tokscale (${manifest.releaseTag}, source ${manifest.commit.slice(0, 12)}) for ${key}...`);

  const installedVersion = resolveVersion(entry);
  if (installedVersion !== manifest.baseVersion) {
    throw new Error(
      `Installed ${entry.package} is ${installedVersion}, but this vendor override was built against ` +
        `${manifest.baseVersion}. The tokscale dependency has moved — update scripts/vendor/tokscale.json to a ` +
        'new pinned build, or set its "mode" to "upstream" if the installed version already includes the pinned source commit.'
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
  const args = process.argv.slice(2);
  const platformArg = args.find((arg) => arg.startsWith('--platform='));
  const requestedKey = platformArg ? platformArg.slice('--platform='.length) : null;
  const allowMissingTargetPackage = args.includes('--allow-missing-target-package');
  return ensureVendoredTokscale({ requestedKey, allowMissingTargetPackage });
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
