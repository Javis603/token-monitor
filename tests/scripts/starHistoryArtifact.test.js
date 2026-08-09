'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { validateArtifact } = require('../../scripts/validate-star-history-artifact');

const REPOSITORY = 'Javis603/token-monitor';
const RENDERER_COMMIT = 'bcddc9d532b10bac7e0187a741288bf9cab17616';
const harmlessXmlCheck = () => {};
const hasXmllint = spawnSync('xmllint', ['--version'], {
  encoding: 'utf8',
  windowsHide: true,
}).status === 0;

const snapshot = () => ({
  repository: REPOSITORY,
  renderer: {
    repository: 'star-history/star-history',
    commit: RENDERER_COMMIT,
  },
  stars: [
    { starredAt: '2026-08-01T12:00:00.000Z', count: 1 },
    { starredAt: '2026-08-03T12:00:00.000Z', count: 2 },
    { starredAt: '2026-08-09T00:00:00.000Z', count: 2 },
  ],
});

const svg = ({ extra = '' } = {}) => `<svg xmlns="http://www.w3.org/2000/svg">
  <text>Star History</text>
  <text>GitHub Stars</text>
  <text>${REPOSITORY}</text>
  <image width="22" height="22" x="316" y="12" clip-path="url(#clip-circle-title)" href="data:image/png;base64,QUJD"/>
  ${extra}
</svg>\n`;

const fixture = (changes = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'star-history-artifact-'));
  fs.writeFileSync(path.join(directory, 'star-history.svg'), changes.light ?? svg());
  fs.writeFileSync(path.join(directory, 'star-history-dark.svg'), changes.dark ?? svg());
  fs.writeFileSync(path.join(directory, 'stars.json'), `${JSON.stringify(changes.snapshot ?? snapshot())}\n`);
  if (changes.extraFile) fs.writeFileSync(path.join(directory, changes.extraFile), 'unexpected');
  return directory;
};

const validate = (directory) => validateArtifact(directory, {
  repository: REPOSITORY,
  rendererCommit: RENDERER_COMMIT,
}, { validateXml: harmlessXmlCheck });

test('accepts the exact generated file set and cumulative snapshot', () => {
  const directory = fixture();
  assert.deepEqual(validate(directory), { starCount: 2 });
});

test('rejects extra files before publication', () => {
  const directory = fixture({ extraFile: 'README.md' });
  assert.throws(() => validate(directory), /expected exactly/);
});

test('rejects repository or renderer substitution', () => {
  const wrongRepository = snapshot();
  wrongRepository.repository = 'attacker/repository';
  assert.throws(() => validate(fixture({ snapshot: wrongRepository })), /repository is attacker/);

  const wrongRenderer = snapshot();
  wrongRenderer.renderer.commit = '0'.repeat(40);
  assert.throws(() => validate(fixture({ snapshot: wrongRenderer })), /renderer commit/);
});

test('rejects identities and malformed cumulative history', () => {
  const identity = snapshot();
  identity.stars[0].login = 'private-user';
  assert.throws(() => validate(fixture({ snapshot: identity })), /unexpected fields/);

  const count = snapshot();
  count.stars[1].count = 7;
  assert.throws(() => validate(fixture({ snapshot: count })), /invalid cumulative count/);

  const staleAnchor = snapshot();
  staleAnchor.stars[2].starredAt = staleAnchor.stars[1].starredAt;
  assert.throws(() => validate(fixture({ snapshot: staleAnchor })), /anchor must advance time/);
});

test('rejects active SVG content and external resources', () => {
  assert.throws(
    () => validate(fixture({ light: svg({ extra: '<script>alert(1)</script>' }) })),
    /active content/,
  );
  assert.throws(
    () => validate(fixture({ dark: svg({ extra: '<image href="https://example.com/pixel.png"/>' }) })),
    /disallowed linked resource/,
  );
  assert.throws(
    () => validate(fixture({ light: svg({ extra: '<path onclick="alert(1)"/>' }) })),
    /event handler/,
  );
});

test('requires one embedded owner icon beside the chart title', () => {
  const withoutIcon = svg().replace(/ {2}<image[^>]+>\n/, '');
  assert.throws(
    () => validate(fixture({ light: withoutIcon })),
    /exactly one embedded owner title icon/,
  );

  const duplicateIcon = svg().replace('</svg>', '<image width="22" height="22" y="12" clip-path="url(#clip-circle-title)" href="data:image/png;base64,QUJD"/></svg>');
  assert.throws(
    () => validate(fixture({ dark: duplicateIcon })),
    /exactly one embedded owner title icon/,
  );
});

test('rejects rendered chart dots', () => {
  const withDot = svg({ extra: '<circle class="chart-tooltip-dot"/>' });
  assert.throws(
    () => validate(fixture({ dark: withDot })),
    /must not contain rendered chart dots/,
  );
});

test('rejects the renderer watermark while retaining the owner title icon', () => {
  const watermark = '<text>star-history.com</text><image width="20" height="20" href="data:image/png;base64,QUJD"/>';
  assert.throws(
    () => validate(fixture({ light: svg({ extra: watermark }) })),
    /must not contain the renderer watermark/,
  );
});

test('rejects a text-only renderer watermark through the XML policy', { skip: !hasXmllint }, () => {
  const watermark = '<text><tspan>star-history.com</tspan></text>';
  assert.throws(
    () => validateArtifact(fixture({ light: svg({ extra: watermark }) }), {
      repository: REPOSITORY,
      rendererCommit: RENDERER_COMMIT,
    }),
    /contains the renderer watermark/,
  );
});

test('rejects namespaced active elements through the real XML policy', { skip: !hasXmllint }, () => {
  const namespacedScript = '<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>';
  assert.throws(
    () => validateArtifact(fixture({ light: svg({ extra: namespacedScript }) }), {
      repository: REPOSITORY,
      rendererCommit: RENDERER_COMMIT,
    }),
    /active content/,
  );

  const namespacedForeignObject = '<x:foreignObject xmlns:x="http://www.w3.org/2000/svg"/>';
  assert.throws(
    () => validateArtifact(fixture({ dark: svg({ extra: namespacedForeignObject }) }), {
      repository: REPOSITORY,
      rendererCommit: RENDERER_COMMIT,
    }),
    /active content/,
  );
});

test('requires the SVG namespace through the real XML policy', { skip: !hasXmllint }, () => {
  const wrongNamespace = svg().replace('http://www.w3.org/2000/svg', 'urn:not-svg');
  assert.throws(
    () => validateArtifact(fixture({ light: wrongNamespace }), {
      repository: REPOSITORY,
      rendererCommit: RENDERER_COMMIT,
    }),
    /SVG namespace root/,
  );
});

test('allows only the official renderer data URI forms', () => {
  const allowed = svg({
    extra: '<style>@font-face{src:url(data:application/font-woff;charset=utf-8;base64,QUJD)}</style>',
  });
  assert.doesNotThrow(() => validate(fixture({ light: allowed, dark: allowed })));
  assert.throws(
    () => validate(fixture({ light: svg({ extra: '<image href="data:image/svg+xml;base64,PHN2Zz4="/>' }) })),
    /disallowed linked resource/,
  );
});
