'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  expectedWindowsArtifacts,
  prepareUnsignedWindowsArtifacts,
  patchLatestYamlForSignedFile,
  applySignedWindowsArtifacts
} = require('../../scripts/signpath-windows-artifacts');

const VERSION = '0.30.0';
const INSTALLER = `Token-Monitor-Setup-${VERSION}.exe`;
const PORTABLE = `Token-Monitor-${VERSION}.exe`;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SAMPLE_YAML = [
  `version: ${VERSION}`,
  'files:',
  `  - url: ${INSTALLER}`,
  '    sha512: unsigned-hash==',
  '    size: 111111',
  '    blockMapSize: 2222',
  `path: ${INSTALLER}`,
  'sha512: unsigned-hash==',
  "releaseDate: '2026-07-18T00:00:00.000Z'",
  ''
].join('\n');

function openingTagAttributes(xml, tagName) {
  const tags = [];
  const tagPattern = new RegExp(`<${tagName}\\b([^>]*)>`, 'g');
  for (const tagMatch of xml.matchAll(tagPattern)) {
    const attributes = {};
    for (const attributeMatch of tagMatch[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
      attributes[attributeMatch[1]] = attributeMatch[2];
    }
    tags.push(attributes);
  }
  return tags;
}

test('SignPath configuration restricts every signed PE to the release product metadata', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const xml = fs.readFileSync(
    path.join(PROJECT_ROOT, '.github', 'signpath', 'artifact-configuration.xml'),
    'utf8'
  );

  assert.deepEqual(openingTagAttributes(xml, 'parameter'), [
    { name: 'version', required: 'true' }
  ]);
  assert.deepEqual(openingTagAttributes(xml, 'pe-file'), [
    {
      path: 'installer/Token-Monitor-Setup-${version}.exe',
      'product-name': pkg.productName,
      'product-version': '${version}'
    },
    {
      path: 'portable/Token-Monitor-${version}.exe',
      'product-name': pkg.productName,
      'product-version': '${version}'
    }
  ]);
});

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-signpath-'));
  const distDir = path.join(root, 'dist');
  const inputDir = path.join(root, 'input');
  const signedDir = path.join(root, 'signed');
  const packageJsonPath = path.join(root, 'package.json');
  fs.mkdirSync(distDir);
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify({
      version: VERSION,
      build: {
        nsis: { artifactName: 'Token-Monitor-Setup-${version}.${ext}' },
        portable: { artifactName: 'Token-Monitor-${version}.${ext}' }
      }
    })
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, distDir, inputDir, signedDir, packageJsonPath };
}

function writeUnsignedArtifacts(fixture) {
  fs.writeFileSync(path.join(fixture.distDir, INSTALLER), 'unsigned-installer');
  fs.writeFileSync(path.join(fixture.distDir, PORTABLE), 'unsigned-portable');
  fs.writeFileSync(path.join(fixture.distDir, `${INSTALLER}.blockmap`), 'stale-blockmap');
  fs.writeFileSync(path.join(fixture.distDir, 'latest.yml'), SAMPLE_YAML);
}

function writeSignedArtifacts(fixture) {
  fs.mkdirSync(path.join(fixture.signedDir, 'installer'), { recursive: true });
  fs.mkdirSync(path.join(fixture.signedDir, 'portable'), { recursive: true });
  fs.writeFileSync(path.join(fixture.signedDir, 'installer', INSTALLER), 'signed-installer-bytes');
  fs.writeFileSync(path.join(fixture.signedDir, 'portable', PORTABLE), 'signed-portable-bytes');
}

test('expectedWindowsArtifacts resolves the public installer and portable names from package.json', (t) => {
  const fixture = makeFixture(t);
  assert.deepEqual(expectedWindowsArtifacts(fixture.packageJsonPath), {
    version: VERSION,
    installer: INSTALLER,
    portable: PORTABLE
  });
});

test('expectedWindowsArtifacts rejects unsafe output names and output-parameter versions', (t) => {
  const fixture = makeFixture(t);
  const pkg = JSON.parse(fs.readFileSync(fixture.packageJsonPath, 'utf8'));
  pkg.version = '0.30.0\nportable=malicious.exe';
  fs.writeFileSync(fixture.packageJsonPath, JSON.stringify(pkg));
  assert.throws(() => expectedWindowsArtifacts(fixture.packageJsonPath), /Unsupported package version/);

  pkg.version = VERSION;
  pkg.build.portable.artifactName = '..\\Token-Monitor-${version}.${ext}';
  fs.writeFileSync(fixture.packageJsonPath, JSON.stringify(pkg));
  assert.throws(() => expectedWindowsArtifacts(fixture.packageJsonPath), /Unsupported Windows artifactName/);
});

test('prepareUnsignedWindowsArtifacts creates a strict two-directory signing input', (t) => {
  const fixture = makeFixture(t);
  writeUnsignedArtifacts(fixture);
  fs.mkdirSync(fixture.inputDir);
  fs.writeFileSync(path.join(fixture.inputDir, 'stale.exe'), 'stale');

  const result = prepareUnsignedWindowsArtifacts(fixture);

  assert.equal(result.relativePaths.installer, `installer/${INSTALLER}`);
  assert.equal(result.relativePaths.portable, `portable/${PORTABLE}`);
  assert.deepEqual(fs.readdirSync(fixture.inputDir).sort(), ['installer', 'portable']);
  assert.equal(
    fs.readFileSync(path.join(fixture.inputDir, 'installer', INSTALLER), 'utf8'),
    'unsigned-installer'
  );
  assert.equal(
    fs.readFileSync(path.join(fixture.inputDir, 'portable', PORTABLE), 'utf8'),
    'unsigned-portable'
  );
});

test('prepareUnsignedWindowsArtifacts fails when an expected build is absent', (t) => {
  const fixture = makeFixture(t);
  fs.writeFileSync(path.join(fixture.distDir, INSTALLER), 'unsigned-installer');

  assert.throws(() => prepareUnsignedWindowsArtifacts(fixture), /Top-level Windows artifacts must be exactly/);
});

test('prepareUnsignedWindowsArtifacts rejects an extra top-level executable that final upload would publish', (t) => {
  const fixture = makeFixture(t);
  writeUnsignedArtifacts(fixture);
  fs.writeFileSync(path.join(fixture.distDir, 'unexpected-helper.exe'), 'unsigned-extra');

  assert.throws(() => prepareUnsignedWindowsArtifacts(fixture), /unexpected-helper\.exe/);
});

test('patchLatestYamlForSignedFile updates sha512/size and removes stale blockMapSize', () => {
  const { text, matched, complete } = patchLatestYamlForSignedFile(SAMPLE_YAML, {
    fileName: INSTALLER,
    sha512: 'signed-hash==',
    size: 222222
  });

  assert.equal(matched, true);
  assert.equal(complete, true);
  assert.match(text, new RegExp(`- url: ${INSTALLER.replaceAll('.', '\\.')}`));
  assert.match(text, /sha512: signed-hash==/);
  assert.match(text, /size: 222222/);
  assert.doesNotMatch(text, /blockMapSize/);
  assert.equal((text.match(/signed-hash==/g) || []).length, 2);
});

test('patchLatestYamlForSignedFile leaves unrelated updater metadata unchanged', () => {
  const { text, matched, complete } = patchLatestYamlForSignedFile(SAMPLE_YAML, {
    fileName: PORTABLE,
    sha512: 'signed-hash==',
    size: 222222
  });
  assert.equal(matched, false);
  assert.equal(complete, false);
  assert.equal(text, SAMPLE_YAML);
});

test('patchLatestYamlForSignedFile reports an incomplete matching entry instead of silently shipping it', () => {
  const malformed = SAMPLE_YAML.replace('    size: 111111\n', '');
  const { matched, complete } = patchLatestYamlForSignedFile(malformed, {
    fileName: INSTALLER,
    sha512: 'signed-hash==',
    size: 222222
  });
  assert.equal(matched, true);
  assert.equal(complete, false);
});

test('applySignedWindowsArtifacts replaces both exes and repairs installer update metadata', async (t) => {
  const fixture = makeFixture(t);
  writeUnsignedArtifacts(fixture);
  writeSignedArtifacts(fixture);

  const result = await applySignedWindowsArtifacts(fixture);

  assert.equal(fs.readFileSync(path.join(fixture.distDir, INSTALLER), 'utf8'), 'signed-installer-bytes');
  assert.equal(fs.readFileSync(path.join(fixture.distDir, PORTABLE), 'utf8'), 'signed-portable-bytes');
  assert.equal(result.size, Buffer.byteLength('signed-installer-bytes'));
  assert.deepEqual(result.patchedYmlFiles, ['latest.yml']);

  const blockmap = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(fixture.distDir, `${INSTALLER}.blockmap`))).toString()
  );
  assert.equal(blockmap.version, '2');
  assert.equal(blockmap.files[0].name, 'file');

  const patchedYaml = fs.readFileSync(path.join(fixture.distDir, 'latest.yml'), 'utf8');
  assert.match(patchedYaml, new RegExp(`sha512: ${result.sha512.replace(/[+/=]/g, '\\$&')}`));
  assert.doesNotMatch(patchedYaml, /blockMapSize/);
  assert.doesNotMatch(patchedYaml, new RegExp(PORTABLE.replaceAll('.', '\\.')));
});

test('applySignedWindowsArtifacts rejects missing or extra signed executables before replacing output', async (t) => {
  const fixture = makeFixture(t);
  writeUnsignedArtifacts(fixture);
  writeSignedArtifacts(fixture);
  fs.writeFileSync(path.join(fixture.signedDir, 'unexpected.exe'), 'unexpected');

  await assert.rejects(() => applySignedWindowsArtifacts(fixture), /must contain exactly/);
  assert.equal(fs.readFileSync(path.join(fixture.distDir, INSTALLER), 'utf8'), 'unsigned-installer');
  assert.equal(fs.readFileSync(path.join(fixture.distDir, PORTABLE), 'utf8'), 'unsigned-portable');
});

test('applySignedWindowsArtifacts rejects a missing or extra top-level release executable', async (t) => {
  const fixture = makeFixture(t);
  writeUnsignedArtifacts(fixture);
  writeSignedArtifacts(fixture);
  fs.rmSync(path.join(fixture.distDir, PORTABLE));

  await assert.rejects(() => applySignedWindowsArtifacts(fixture), /Top-level Windows artifacts must be exactly/);
  assert.equal(fs.readFileSync(path.join(fixture.distDir, INSTALLER), 'utf8'), 'unsigned-installer');

  fs.writeFileSync(path.join(fixture.distDir, PORTABLE), 'unsigned-portable');
  fs.writeFileSync(path.join(fixture.distDir, 'unexpected-helper.exe'), 'unsigned-extra');
  await assert.rejects(() => applySignedWindowsArtifacts(fixture), /unexpected-helper\.exe/);
  assert.equal(fs.readFileSync(path.join(fixture.distDir, INSTALLER), 'utf8'), 'unsigned-installer');
});

test('applySignedWindowsArtifacts refuses stale updater metadata', async (t) => {
  const fixture = makeFixture(t);
  writeUnsignedArtifacts(fixture);
  writeSignedArtifacts(fixture);
  fs.writeFileSync(path.join(fixture.distDir, 'latest.yml'), 'version: 0.30.0\n');

  await assert.rejects(() => applySignedWindowsArtifacts(fixture), /not referenced by any updater metadata/);
});

test('applySignedWindowsArtifacts refuses incomplete updater metadata', async (t) => {
  const fixture = makeFixture(t);
  writeUnsignedArtifacts(fixture);
  writeSignedArtifacts(fixture);
  fs.writeFileSync(path.join(fixture.distDir, 'latest.yml'), SAMPLE_YAML.replace('    size: 111111\n', ''));

  await assert.rejects(() => applySignedWindowsArtifacts(fixture), /incomplete updater entry/);
});
