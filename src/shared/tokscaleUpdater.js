'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const semver = require('semver');
const tar = require('tar');
const { sharedDataDir } = require('./config');
const { decideResolver, locateBundledBinary, readDownloadedPointer } = require('./collector');
const { tokscalePackageNameForPlatform, tokscalePlatformKey } = require('./tokscalePlatform');

const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 10 * 1000;
const DOWNLOAD_TIMEOUT_MS = 90 * 1000;
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

function tokscaleDir() {
  return path.join(sharedDataDir(), 'tokscale');
}

function currentJsonPath() {
  return path.join(tokscaleDir(), 'current.json');
}

function binaryName() {
  return process.platform === 'win32' ? 'tokscale.exe' : 'tokscale';
}

function parseIntegrity(integrity) {
  const entry = String(integrity || '').split(/\s+/).find((part) => part.startsWith('sha512-'));
  if (!entry) return null;
  const expected = Buffer.from(entry.slice('sha512-'.length), 'base64');
  return expected.length === 64 ? expected : null;
}

function verifyIntegrity(buffer, integrity) {
  const expected = parseIntegrity(integrity);
  if (!expected) return false;
  const actual = crypto.createHash('sha512').update(buffer).digest();
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function validatePackageJsonIdentity(pkg, expected) {
  if (!pkg || pkg.name !== expected.packageName) {
    throw new Error(`Downloaded package name mismatch: expected ${expected.packageName}`);
  }
  if (pkg.version !== expected.version) {
    throw new Error(`Downloaded package version mismatch: expected ${expected.version}`);
  }
  if (Array.isArray(pkg.os) && pkg.os.length > 0 && !pkg.os.includes(expected.platform)) {
    throw new Error(`Downloaded package os mismatch: expected ${expected.platform}`);
  }
  if (Array.isArray(pkg.cpu) && pkg.cpu.length > 0 && !pkg.cpu.includes(expected.arch)) {
    throw new Error(`Downloaded package cpu mismatch: expected ${expected.arch}`);
  }
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

async function readJsonFile(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function validatePackageDir(packageDir, metadata) {
  const pkg = await readJsonFile(path.join(packageDir, 'package.json'));
  validatePackageJsonIdentity(pkg, {
    packageName: metadata.packageName,
    version: metadata.version,
    platform: process.platform,
    arch: process.arch
  });
  const binPath = path.join(packageDir, 'bin', binaryName());
  const stat = await fsp.lstat(binPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Downloaded binary is not a regular file');
  return binPath;
}

async function withTimeout(ms, task) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}) {
  return withTimeout(options.timeoutMs || METADATA_TIMEOUT_MS, async (signal) => {
    const response = await fetch(url, { headers: options.headers || {}, signal });
    if (!response.ok) throw new Error(`Registry ${response.status}`);
    return response.json();
  });
}

async function fetchLatestMetadata(appVersion = '0.0.0') {
  const packageName = tokscalePackageNameForPlatform();
  if (!packageName) return { supported: false };
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
  const metadata = await fetchJson(url, {
    headers: { 'user-agent': `token-monitor/${appVersion}` }
  });
  const version = String(metadata?.version || '');
  const tarball = String(metadata?.dist?.tarball || '');
  const integrity = String(metadata?.dist?.integrity || '');
  if (!semver.valid(version) || !tarball || !parseIntegrity(integrity)) {
    throw new Error('Registry response missing valid tokscale package metadata');
  }
  return { supported: true, packageName, version, tarball, integrity };
}

async function downloadTarball(url) {
  return withTimeout(DOWNLOAD_TIMEOUT_MS, async (signal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Download ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_TARBALL_BYTES) throw new Error('Download too large');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_TARBALL_BYTES) throw new Error('Download too large');
    return buffer;
  });
}

async function extractTarball(buffer, stagingDir) {
  await fsp.mkdir(stagingDir, { recursive: true });
  const archivePath = path.join(stagingDir, 'package.tgz');
  await fsp.writeFile(archivePath, buffer);
  await tar.x({
    file: archivePath,
    cwd: stagingDir,
    preservePaths: false,
    filter: (_filePath, entry) => entry.type !== 'SymbolicLink' && entry.type !== 'Link'
  });
}

async function smokeTestBinary(binPath) {
  return new Promise((resolve) => {
    const child = spawn(binPath, ['--version'], { windowsHide: true });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve(false);
    }, 5000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function writeCurrentJsonAtomic(value) {
  await fsp.mkdir(tokscaleDir(), { recursive: true });
  const filePath = currentJsonPath();
  const tempPath = `${filePath}.tmp`;
  const handle = await fsp.open(tempPath, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tempPath, filePath);
}

async function cleanupStaleStaging(now = Date.now()) {
  let entries;
  try {
    entries = await fsp.readdir(tokscaleDir(), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('.staging-')).map(async (entry) => {
    const dir = path.join(tokscaleDir(), entry.name);
    const stat = await fsp.stat(dir);
    if (now - stat.mtimeMs > STAGING_MAX_AGE_MS) await fsp.rm(dir, { recursive: true, force: true });
  }));
}

function getTokscaleStatus() {
  const packageName = tokscalePackageNameForPlatform();
  if (!packageName) return { supported: false };
  const bundled = locateBundledBinary();
  const downloaded = readDownloadedPointer();
  const active = decideResolver({ downloaded, bundled, shim: null });
  return {
    supported: true,
    packageName,
    current: active ? {
      source: active.source,
      version: active.version,
      path: active.path,
      installedAt: active.installedAt || null
    } : null,
    bundled: bundled ? { version: bundled.version, path: bundled.path } : null,
    downloaded: downloaded ? {
      version: downloaded.version,
      path: downloaded.path,
      installedAt: downloaded.installedAt || null,
      integrity: downloaded.integrity || ''
    } : null
  };
}

async function checkNpmForNewer(appVersion) {
  const status = getTokscaleStatus();
  if (!status.supported) return { supported: false };
  const metadata = await fetchLatestMetadata(appVersion);
  const currentVersion = status.current?.version || status.bundled?.version || '0.0.0';
  const newer = semver.valid(currentVersion) ? semver.gt(metadata.version, currentVersion) : true;
  return {
    supported: true,
    newer,
    npm: { version: metadata.version },
    current: status.current,
    bundled: status.bundled,
    downloaded: status.downloaded,
    checkedAt: new Date().toISOString(),
    metadata
  };
}

async function downloadFromNpm(metadata) {
  if (!metadata?.supported) return { supported: false };
  const stagingDir = path.join(tokscaleDir(), `.staging-${crypto.randomBytes(8).toString('hex')}`);
  await fsp.mkdir(tokscaleDir(), { recursive: true });
  try {
    let buffer;
    try {
      buffer = await downloadTarball(metadata.tarball);
    } catch (_) {
      buffer = await downloadTarball(metadata.tarball);
    }
    if (!verifyIntegrity(buffer, metadata.integrity)) throw new Error('Integrity check failed');
    await extractTarball(buffer, stagingDir);
    const stagingPackage = path.join(stagingDir, 'package');
    const stagingBin = await validatePackageDir(stagingPackage, metadata);
    if (process.platform !== 'win32') await fsp.chmod(stagingBin, 0o755);
    if (!await smokeTestBinary(stagingBin)) throw new Error('Downloaded binary failed to run');

    const target = path.join(tokscaleDir(), metadata.version);
    if (await exists(target)) {
      try {
        const existingBin = await validatePackageDir(target, metadata);
        if (!await smokeTestBinary(existingBin)) throw new Error('Existing binary failed smoke test');
      } catch (_) {
        await fsp.rm(target, { recursive: true, force: true });
        await fsp.rename(stagingPackage, target);
      }
    } else {
      await fsp.rename(stagingPackage, target);
    }

    const finalBin = path.join(target, 'bin', binaryName());
    await writeCurrentJsonAtomic({
      version: metadata.version,
      path: finalBin,
      platform: tokscalePlatformKey(),
      installedAt: new Date().toISOString(),
      integrity: metadata.integrity
    });
    return { supported: true, downloaded: true, version: metadata.version, status: getTokscaleStatus() };
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function resetToBundled() {
  await fsp.rm(currentJsonPath(), { force: true });
  return getTokscaleStatus();
}

module.exports = {
  checkNpmForNewer,
  cleanupStaleStaging,
  currentJsonPath,
  downloadFromNpm,
  fetchLatestMetadata,
  getTokscaleStatus,
  parseIntegrity,
  resetToBundled,
  smokeTestBinary,
  validatePackageJsonIdentity,
  validatePackageDir,
  verifyIntegrity
};
