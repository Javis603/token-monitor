'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const rootPackage = require('../../package.json');
const {
  referencedArtifactNames,
  verifyUpdaterArtifactNames
} = require('../../scripts/verify-updater-artifact-names');

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
