#!/usr/bin/env node
'use strict';

// Verifies the complete immutable Release contract behind the vendor manifest.
// The per-platform CI matrix executes binaries on Token Monitor's four real
// packaging targets; this gate instead downloads every upstream npm-native
// target, including cross-platform assets that cannot execute on one runner.

const { downloadAsset, verifySha256 } = require('./ensure-vendored-tokscale');
const { loadManifest, manifestMode } = require('./vendoredTokscale');

const API_TIMEOUT_MS = 30 * 1000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_TAG_DEPTH = 8;

function platformKeyForPackage(packageName) {
  const match = String(packageName || '').match(
    /^@tokscale\/cli-(android|darwin|linux|win32)-(arm64|x64)(?:-(gnu|musl|msvc))?$/
  );
  if (!match) throw new Error(`Unsupported Tokscale native package name: ${packageName}`);
  const [, platform, arch, libc] = match;
  if (platform === 'linux') {
    if (libc === 'gnu') return `${platform}-${arch}`;
    if (libc === 'musl') return `${platform}-${arch}-musl`;
    throw new Error(`Linux Tokscale package must declare gnu or musl: ${packageName}`);
  }
  if (platform === 'win32') {
    if (libc !== 'msvc') throw new Error(`Windows Tokscale package must declare msvc: ${packageName}`);
    return `${platform}-${arch}`;
  }
  if (libc) throw new Error(`${platform} Tokscale package must not declare ${libc}: ${packageName}`);
  return `${platform}-${arch}`;
}

function assetNameForPlatformKey(key) {
  return `tokscale-${key}${String(key).startsWith('win32-') ? '.exe' : ''}`;
}

function verifyManifestTargets(manifest, optionalDependencies) {
  const dependencies = optionalDependencies && typeof optionalDependencies === 'object'
    ? optionalDependencies
    : {};
  const packages = Object.keys(dependencies).filter((name) => name.startsWith('@tokscale/cli-')).sort();
  if (packages.length === 0) throw new Error('@tokscale/cli declares no native optionalDependencies');
  if (!manifest?.platforms || typeof manifest.platforms !== 'object') {
    throw new Error('Vendor manifest has no platforms map');
  }

  const expectedKeys = new Set();
  const seenAssets = new Set();
  const entries = packages.map((packageName) => {
    const packageVersion = dependencies[packageName];
    if (packageVersion !== manifest.baseVersion) {
      throw new Error(
        `${packageName} optionalDependency is ${packageVersion}, expected manifest baseVersion ${manifest.baseVersion}`
      );
    }
    const key = platformKeyForPackage(packageName);
    if (expectedKeys.has(key)) throw new Error(`Multiple Tokscale packages resolve to platform ${key}`);
    expectedKeys.add(key);
    const entry = manifest.platforms[key];
    if (!entry) throw new Error(`Vendor manifest is missing upstream native target ${key} (${packageName})`);
    if (entry.package !== packageName) {
      throw new Error(`Vendor manifest ${key} uses ${entry.package}, expected ${packageName}`);
    }
    const expectedAsset = assetNameForPlatformKey(key);
    if (entry.asset !== expectedAsset) {
      throw new Error(`Vendor manifest ${key} uses asset ${entry.asset}, expected ${expectedAsset}`);
    }
    if (!SHA256_PATTERN.test(String(entry.sha256 || ''))) {
      throw new Error(`Vendor manifest ${key} has an invalid SHA-256`);
    }
    if (seenAssets.has(entry.asset)) throw new Error(`Vendor manifest repeats asset ${entry.asset}`);
    seenAssets.add(entry.asset);
    return { key, ...entry };
  });

  const extras = Object.keys(manifest.platforms).filter((key) => !expectedKeys.has(key));
  if (extras.length > 0) {
    throw new Error(`Vendor manifest has targets absent from @tokscale/cli optionalDependencies: ${extras.sort().join(', ')}`);
  }
  return entries;
}

async function fetchGithubJson(url, label, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN || '' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'token-monitor-vendor-verifier',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`${label} failed: ${response.status} ${url}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchReleaseMetadata(manifest, options = {}) {
  const url = `https://api.github.com/repos/${manifest.releaseRepo}/releases/tags/${encodeURIComponent(manifest.releaseTag)}`;
  return fetchGithubJson(url, 'GitHub Release lookup', options);
}

async function resolveReleaseTagCommit(manifest, options = {}) {
  const refUrl = `https://api.github.com/repos/${manifest.releaseRepo}/git/ref/tags/${encodeURIComponent(manifest.releaseTag)}`;
  const ref = await fetchGithubJson(refUrl, 'GitHub tag ref lookup', options);
  let object = ref?.object;
  const seenTags = new Set();

  for (let depth = 0; depth <= MAX_TAG_DEPTH; depth += 1) {
    const type = String(object?.type || '');
    const sha = String(object?.sha || '');
    if (!GIT_SHA_PATTERN.test(sha)) throw new Error(`GitHub tag ref returned an invalid object SHA: ${sha || 'missing'}`);
    if (type === 'commit') return sha;
    if (type !== 'tag') throw new Error(`GitHub tag ref resolves to unsupported object type: ${type || 'missing'}`);
    if (seenTags.has(sha)) throw new Error(`GitHub tag ref contains a tag cycle at ${sha}`);
    if (depth === MAX_TAG_DEPTH) throw new Error(`GitHub tag ref exceeds ${MAX_TAG_DEPTH} annotated tag levels`);
    seenTags.add(sha);

    const tagUrl = `https://api.github.com/repos/${manifest.releaseRepo}/git/tags/${sha}`;
    const tag = await fetchGithubJson(tagUrl, 'GitHub annotated tag lookup', options);
    object = tag?.object;
  }
  throw new Error('GitHub tag ref could not be resolved to a commit');
}

function parseChecksumManifest(buffer) {
  const checksums = new Map();
  for (const line of Buffer.from(buffer).toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([0-9a-f]{64})\s+[ *]?([^/\\]+)$/);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    const [, digest, asset] = match;
    if (checksums.has(asset)) throw new Error(`SHA256SUMS repeats asset ${asset}`);
    checksums.set(asset, digest);
  }
  return checksums;
}

function verifyReleaseMetadata(manifest, entries, release) {
  if (release?.tag_name !== manifest.releaseTag) {
    throw new Error(`Release tag is ${release?.tag_name || 'missing'}, expected ${manifest.releaseTag}`);
  }
  if (release?.target_commitish !== manifest.commit) {
    throw new Error(
      `Release target is ${release?.target_commitish || 'missing'}, expected source commit ${manifest.commit}`
    );
  }
  if (release.draft || release.prerelease) throw new Error('Vendor Release must be published and non-prerelease');

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const byName = new Map();
  for (const asset of assets) {
    const name = String(asset?.name || '');
    if (!name) throw new Error('Release contains an unnamed asset');
    if (byName.has(name)) throw new Error(`Release repeats asset ${name}`);
    byName.set(name, asset);
  }
  const expectedNames = [...entries.map((entry) => entry.asset), 'SHA256SUMS'].sort();
  const actualNames = [...byName.keys()].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`Release assets differ: expected ${expectedNames.join(', ')}, got ${actualNames.join(', ')}`);
  }
  for (const entry of entries) {
    const digest = String(byName.get(entry.asset)?.digest || '');
    if (digest !== `sha256:${entry.sha256}`) {
      throw new Error(`GitHub digest for ${entry.asset} is ${digest || 'missing'}, expected sha256:${entry.sha256}`);
    }
  }
}

async function verifyVendoredTokscaleRelease({
  manifest = loadManifest(),
  optionalDependencies = require('@tokscale/cli/package.json').optionalDependencies,
  release = null,
  tagCommit = null,
  fetchImpl = fetch,
  token = process.env.GITHUB_TOKEN || '',
  download = (currentManifest, entry) => downloadAsset(currentManifest, entry, fetchImpl),
  log = console.log
} = {}) {
  const entries = verifyManifestTargets(manifest, optionalDependencies);
  if (manifestMode(manifest) === 'upstream') {
    log(`Vendor mode is upstream; verified ${entries.length} manifest target mappings without downloading an inactive Release.`);
    return { status: 'upstream', targets: entries.length };
  }

  const metadata = release || await fetchReleaseMetadata(manifest, { fetchImpl, token });
  verifyReleaseMetadata(manifest, entries, metadata);
  const resolvedTagCommit = tagCommit || await resolveReleaseTagCommit(manifest, { fetchImpl, token });
  if (resolvedTagCommit !== manifest.commit) {
    throw new Error(`Release tag resolves to ${resolvedTagCommit}, expected source commit ${manifest.commit}`);
  }
  const checksumBuffer = await download(manifest, { asset: 'SHA256SUMS' });
  const checksums = parseChecksumManifest(checksumBuffer);
  if (checksums.size !== entries.length) {
    throw new Error(`SHA256SUMS has ${checksums.size} entries, expected ${entries.length}`);
  }

  for (const entry of entries) {
    const listed = checksums.get(entry.asset);
    if (listed !== entry.sha256) {
      throw new Error(`SHA256SUMS for ${entry.asset} is ${listed || 'missing'}, expected ${entry.sha256}`);
    }
    const buffer = await download(manifest, entry);
    verifySha256(buffer, entry.sha256);
    log(`Verified ${entry.key}: ${entry.asset} (${buffer.length} bytes)`);
  }
  log(`Verified vendor Release ${manifest.releaseTag}: tag commit ${manifest.commit} and all ${entries.length} native assets.`);
  return { status: 'verified', targets: entries.length };
}

if (require.main === module) {
  verifyVendoredTokscaleRelease().catch((error) => {
    console.error(`verify-vendored-tokscale-release failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  assetNameForPlatformKey,
  fetchReleaseMetadata,
  parseChecksumManifest,
  platformKeyForPackage,
  resolveReleaseTagCommit,
  verifyManifestTargets,
  verifyReleaseMetadata,
  verifyVendoredTokscaleRelease
};
