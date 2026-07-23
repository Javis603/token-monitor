'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MacUpdater } = require('electron-updater');

const rootPackage = require('../../package.json');
const {
  referencedArtifactNames,
  verifyUpdaterArtifactNames
} = require('../../scripts/verify-updater-artifact-names');
const { mergeMacUpdaterMetadata } = require('../../scripts/merge-mac-updater-metadata');

function macUpdaterMetadata(version, arch) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: Token-Monitor-${version}-${arch}.zip`,
    `    sha512: ${arch}-zip-hash`,
    '    size: 100',
    `  - url: Token-Monitor-${version}-${arch}.dmg`,
    `    sha512: ${arch}-dmg-hash`,
    '    size: 200',
    `path: Token-Monitor-${version}-${arch}.zip`,
    `sha512: ${arch}-zip-hash`,
    "releaseDate: '2026-07-21T00:00:00.000Z'",
    ''
  ].join('\n');
}

test('release artifact templates use GitHub-safe names', () => {
  const patterns = [
    rootPackage.build.mac.artifactName,
    rootPackage.build.linux.artifactName,
    rootPackage.build.nsis.artifactName,
    rootPackage.build.portable.artifactName
  ];
  assert.deepEqual(patterns, [
    'Token-Monitor-${version}-${arch}.${ext}',
    'Token-Monitor-${version}.${ext}',
    'Token-Monitor-Setup-${version}.${ext}',
    'Token-Monitor-${version}.${ext}'
  ]);
  for (const pattern of patterns) assert.doesNotMatch(pattern, /\s/);
});

test('mac release scripts build native Apple Silicon and Intel artifacts', () => {
  assert.deepEqual(rootPackage.build.mac.target, ['dmg', 'zip']);
  assert.match(rootPackage.scripts['dist:mac'], /--arm64/);
  assert.match(rootPackage.scripts['dist:mac:x64'], /--x64/);

  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /os: macos-15\s+target: mac\s+arch: arm64/);
  assert.match(workflow, /os: macos-15-intel\s+target: mac\s+arch: x64/);
  assert.match(workflow, /artifacts\/token-monitor-mac-arm64\/latest-mac\.yml \\\s+artifacts\/token-monitor-mac-x64\/latest-mac\.yml/);
  assert.doesNotMatch(workflow, /latest-mac-(?:arm64|x64)\.yml/);

  const releaseTemplate = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'RELEASE_TEMPLATE.md'), 'utf8');
  const intelBullets = releaseTemplate.split('\n').filter((line) => line.startsWith('- **macOS Intel**'));
  const intelDmg = `Token-Monitor-${rootPackage.version}-x64.dmg`;
  assert.equal(intelBullets.length, 2);
  assert.ok(intelBullets.every((line) => line.split(intelDmg).length === 3));
  assert.ok(intelBullets.every((line) => line.includes(`/download/v${rootPackage.version}/`)));
});

test('release icons use source assets without the legacy generator', () => {
  const projectRoot = path.join(__dirname, '..', '..');
  const iconSources = new Set([
    rootPackage.build.mac.icon,
    rootPackage.build.win.icon,
    rootPackage.build.linux.icon
  ]);

  for (const iconSource of iconSources) {
    assert.ok(fs.existsSync(path.join(projectRoot, iconSource)), `missing release icon source: ${iconSource}`);
  }
  assert.equal(rootPackage.scripts.icons, undefined);
  assert.equal(rootPackage.devDependencies['electron-icon-builder'], undefined);
});

test('extracts updater artifact names from url and path fields', () => {
  const names = referencedArtifactNames([
    'files:',
    '  - url: Token-Monitor-0.25.0-arm64.zip',
    'path: "Token-Monitor-0.25.0-arm64.zip"',
    "  - url: 'https://example.com/Token-Monitor-0.25.0-arm64.dmg'"
  ].join('\n'));
  assert.deepEqual(names, [
    'Token-Monitor-0.25.0-arm64.zip',
    'Token-Monitor-0.25.0-arm64.dmg'
  ]);
});

test('fails when updater metadata references an asset that will not be uploaded', (t) => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-release-'));
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(distDir, 'latest-mac.yml'), [
    'version: 0.25.0',
    'files:',
    '  - url: Token-Monitor-0.25.0-arm64.zip',
    'path: Token-Monitor-0.25.0-arm64.zip'
  ].join('\n'));

  assert.throws(
    () => verifyUpdaterArtifactNames(distDir),
    /latest-mac\.yml -> Token-Monitor-0\.25\.0-arm64\.zip/
  );

  fs.writeFileSync(path.join(distDir, 'Token-Monitor-0.25.0-arm64.zip'), 'artifact');
  assert.deepEqual(verifyUpdaterArtifactNames(distDir), {
    metadataFiles: ['latest-mac.yml']
  });
});

test('merges arm64 and x64 mac updater files into one architecture-aware feed', (t) => {
  const version = '0.33.0';
  const merged = mergeMacUpdaterMetadata(
    macUpdaterMetadata(version, 'arm64'),
    macUpdaterMetadata(version, 'x64')
  );
  assert.deepEqual(referencedArtifactNames(merged), [
    `Token-Monitor-${version}-arm64.zip`,
    `Token-Monitor-${version}-arm64.dmg`,
    `Token-Monitor-${version}-x64.zip`,
    `Token-Monitor-${version}-x64.dmg`
  ]);
  assert.match(merged, new RegExp(`^path: Token-Monitor-${version}-arm64\\.zip$`, 'm'));

  const files = referencedArtifactNames(merged).map((fileName) => ({
    url: new URL(`https://release.invalid/${fileName}`),
    info: { url: fileName }
  }));
  assert.deepEqual(
    MacUpdater.filterFilesForArch(files, true).map((file) => path.basename(file.url.pathname)),
    [`Token-Monitor-${version}-arm64.zip`, `Token-Monitor-${version}-arm64.dmg`]
  );
  assert.deepEqual(
    MacUpdater.filterFilesForArch(files, false).map((file) => path.basename(file.url.pathname)),
    [`Token-Monitor-${version}-x64.zip`, `Token-Monitor-${version}-x64.dmg`]
  );

  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-mac-release-'));
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(distDir, 'latest-mac.yml'), merged);
  for (const fileName of referencedArtifactNames(merged)) {
    fs.writeFileSync(path.join(distDir, fileName), 'artifact');
  }
  assert.deepEqual(verifyUpdaterArtifactNames(distDir), {
    metadataFiles: ['latest-mac.yml']
  });
});

test('rejects mismatched or mislabelled mac updater metadata', () => {
  assert.throws(
    () => mergeMacUpdaterMetadata(
      macUpdaterMetadata('0.33.0', 'arm64'),
      macUpdaterMetadata('0.33.1', 'x64')
    ),
    /versions differ/
  );
  assert.throws(
    () => mergeMacUpdaterMetadata(
      macUpdaterMetadata('0.33.0', 'x64'),
      macUpdaterMetadata('0.33.0', 'arm64')
    ),
    /expected only arm64 artifacts/
  );
});

test('rejects stale or missing top-level mac updater paths', () => {
  const version = '0.33.0';
  const arm64Metadata = macUpdaterMetadata(version, 'arm64');
  const x64Metadata = macUpdaterMetadata(version, 'x64');

  assert.throws(
    () => mergeMacUpdaterMetadata(
      arm64Metadata.replace(
        `path: Token-Monitor-${version}-arm64.zip`,
        `path: Token-Monitor-${version}-x64.zip`
      ),
      x64Metadata
    ),
    /arm64 metadata path Token-Monitor-0\.33\.0-x64\.zip does not reference an arm64 artifact/
  );
  assert.throws(
    () => mergeMacUpdaterMetadata(
      arm64Metadata.replace(
        `path: Token-Monitor-${version}-arm64.zip`,
        `path: Other-Monitor-${version}-arm64.zip`
      ),
      x64Metadata
    ),
    /arm64 metadata path Other-Monitor-0\.33\.0-arm64\.zip is not present in its files list/
  );
  assert.throws(
    () => mergeMacUpdaterMetadata(
      arm64Metadata.replace(
        `path: Token-Monitor-${version}-arm64.zip`,
        `path: Token-Monitor-${version}-arm64.dmg`
      ),
      x64Metadata
    ),
    /arm64 metadata path Token-Monitor-0\.33\.0-arm64\.dmg is not a zip artifact/
  );
  assert.throws(
    () => mergeMacUpdaterMetadata(
      arm64Metadata.replace(`path: Token-Monitor-${version}-arm64.zip\n`, ''),
      x64Metadata
    ),
    /arm64 metadata must have exactly one top-level path/
  );
});
