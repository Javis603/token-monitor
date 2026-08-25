'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  parseChecksumManifest,
  platformKeyForPackage,
  resolveReleaseTagCommit,
  verifyManifestTargets,
  verifyVendoredTokscaleRelease
} = require('../../scripts/verify-vendored-tokscale-release');
const { loadManifest } = require('../../scripts/vendoredTokscale');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fixture() {
  const payloads = {
    'tokscale-darwin-arm64': Buffer.from('darwin binary'),
    'tokscale-linux-x64-musl': Buffer.from('linux musl binary')
  };
  const manifest = {
    mode: 'override',
    releaseRepo: 'Javis603/tokscale',
    releaseTag: 'token-monitor-12345678',
    commit: '1234567890abcdef1234567890abcdef12345678',
    baseVersion: '4.13.0',
    platforms: {
      'darwin-arm64': {
        package: '@tokscale/cli-darwin-arm64',
        asset: 'tokscale-darwin-arm64',
        sha256: sha256(payloads['tokscale-darwin-arm64'])
      },
      'linux-x64-musl': {
        package: '@tokscale/cli-linux-x64-musl',
        asset: 'tokscale-linux-x64-musl',
        sha256: sha256(payloads['tokscale-linux-x64-musl'])
      }
    }
  };
  const optionalDependencies = {
    '@tokscale/cli-darwin-arm64': '4.13.0',
    '@tokscale/cli-linux-x64-musl': '4.13.0'
  };
  const checksums = Buffer.from(Object.entries(payloads)
    .map(([asset, buffer]) => `${sha256(buffer)}  ${asset}`)
    .join('\n') + '\n');
  const release = {
    tag_name: manifest.releaseTag,
    target_commitish: manifest.commit,
    draft: false,
    prerelease: false,
    assets: [
      ...Object.entries(payloads).map(([name, buffer]) => ({ name, digest: `sha256:${sha256(buffer)}` })),
      { name: 'SHA256SUMS', digest: `sha256:${sha256(checksums)}` }
    ]
  };
  return { manifest, optionalDependencies, payloads: { ...payloads, SHA256SUMS: checksums }, release };
}

test('real vendor manifest derives complete target coverage from @tokscale/cli', () => {
  const optionalDependencies = require('@tokscale/cli/package.json').optionalDependencies;
  const entries = verifyManifestTargets(loadManifest(), optionalDependencies);
  assert.equal(entries.length, Object.keys(optionalDependencies).length);
  assert.equal(entries.length, 9);
});

test('native package names map to runtime platform keys without a duplicate target list', () => {
  assert.equal(platformKeyForPackage('@tokscale/cli-linux-arm64-gnu'), 'linux-arm64');
  assert.equal(platformKeyForPackage('@tokscale/cli-linux-arm64-musl'), 'linux-arm64-musl');
  assert.equal(platformKeyForPackage('@tokscale/cli-win32-x64-msvc'), 'win32-x64');
  assert.equal(platformKeyForPackage('@tokscale/cli-android-arm64'), 'android-arm64');
});

test('manifest completeness rejects a missing upstream optionalDependency target', () => {
  const value = fixture();
  delete value.manifest.platforms['linux-x64-musl'];
  assert.throws(
    () => verifyManifestTargets(value.manifest, value.optionalDependencies),
    /missing upstream native target linux-x64-musl/
  );
});

test('manifest completeness rejects targets no longer declared by upstream npm', () => {
  const value = fixture();
  delete value.optionalDependencies['@tokscale/cli-linux-x64-musl'];
  assert.throws(
    () => verifyManifestTargets(value.manifest, value.optionalDependencies),
    /targets absent from @tokscale\/cli optionalDependencies: linux-x64-musl/
  );
});

test('release verification downloads and hashes every native asset', async () => {
  const value = fixture();
  const downloads = [];
  const result = await verifyVendoredTokscaleRelease({
    manifest: value.manifest,
    optionalDependencies: value.optionalDependencies,
    release: value.release,
    tagCommit: value.manifest.commit,
    download: async (_manifest, entry) => {
      downloads.push(entry.asset);
      return value.payloads[entry.asset];
    },
    log: () => {}
  });
  assert.deepEqual(result, { status: 'verified', targets: 2 });
  assert.deepEqual(downloads, ['SHA256SUMS', 'tokscale-darwin-arm64', 'tokscale-linux-x64-musl']);
});

test('release verification ignores non-authoritative target_commitish metadata', async () => {
  const value = fixture();
  value.release.target_commitish = 'main';
  const result = await verifyVendoredTokscaleRelease({
    manifest: value.manifest,
    optionalDependencies: value.optionalDependencies,
    release: value.release,
    tagCommit: value.manifest.commit,
    download: async (_manifest, entry) => value.payloads[entry.asset],
    log: () => {}
  });
  assert.deepEqual(result, { status: 'verified', targets: 2 });
});

test('release verification rejects a tag that resolves elsewhere regardless of target_commitish', async () => {
  const value = fixture();
  await assert.rejects(
    verifyVendoredTokscaleRelease({
      manifest: value.manifest,
      optionalDependencies: value.optionalDependencies,
      release: value.release,
      tagCommit: 'f'.repeat(40),
      download: async () => { throw new Error('must not download'); },
      log: () => {}
    }),
    /Release tag resolves to f{40}, expected source commit/
  );
});

test('tag resolution peels an annotated tag to its commit', async () => {
  const value = fixture();
  const tagObjectSha = 'a'.repeat(40);
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.includes('/git/ref/tags/')) {
      return { ok: true, json: async () => ({ object: { type: 'tag', sha: tagObjectSha } }) };
    }
    if (url.endsWith(`/git/tags/${tagObjectSha}`)) {
      return { ok: true, json: async () => ({ object: { type: 'commit', sha: value.manifest.commit } }) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  assert.equal(await resolveReleaseTagCommit(value.manifest, { fetchImpl }), value.manifest.commit);
  assert.equal(requested.length, 2);
});

test('release verification rejects a missing asset before downloading', async () => {
  const value = fixture();
  value.release.assets = value.release.assets.filter((asset) => asset.name !== 'tokscale-linux-x64-musl');
  await assert.rejects(
    verifyVendoredTokscaleRelease({
      manifest: value.manifest,
      optionalDependencies: value.optionalDependencies,
      release: value.release,
      tagCommit: value.manifest.commit,
      download: async () => { throw new Error('must not download'); },
      log: () => {}
    }),
    /Release assets differ/
  );
});

test('release verification rejects checksum-list drift', async () => {
  const value = fixture();
  value.payloads.SHA256SUMS = Buffer.from(
    `${'0'.repeat(64)}  tokscale-darwin-arm64\n` +
    `${value.manifest.platforms['linux-x64-musl'].sha256}  tokscale-linux-x64-musl\n`
  );
  await assert.rejects(
    verifyVendoredTokscaleRelease({
      manifest: value.manifest,
      optionalDependencies: value.optionalDependencies,
      release: value.release,
      tagCommit: value.manifest.commit,
      download: async (_manifest, entry) => value.payloads[entry.asset],
      log: () => {}
    }),
    /SHA256SUMS for tokscale-darwin-arm64/
  );
});

test('release verification hashes downloaded bytes instead of trusting metadata', async () => {
  const value = fixture();
  value.payloads['tokscale-linux-x64-musl'] = Buffer.from('tampered bytes');
  await assert.rejects(
    verifyVendoredTokscaleRelease({
      manifest: value.manifest,
      optionalDependencies: value.optionalDependencies,
      release: value.release,
      tagCommit: value.manifest.commit,
      download: async (_manifest, entry) => value.payloads[entry.asset],
      log: () => {}
    }),
    /sha256 mismatch/
  );
});

test('checksum parser rejects duplicate and path-bearing entries', () => {
  const digest = 'a'.repeat(64);
  assert.throws(() => parseChecksumManifest(Buffer.from(`${digest}  asset\n${digest}  asset\n`)), /repeats asset/);
  assert.throws(() => parseChecksumManifest(Buffer.from(`${digest}  dist/asset\n`)), /Invalid SHA256SUMS line/);
});
