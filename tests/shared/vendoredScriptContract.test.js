'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const packageJson = require('../../package.json');

const runtimeScripts = [
  'start',
  'widget',
  'dev',
  'agent',
  'agent:once',
  'pack',
  'pack:mac:widget',
  'pack:mac:widget:x64',
  'dist:mac',
  'dist:mac:x64',
  'dist:mac:widget',
  'dist:mac:widget:x64',
  'dist:win',
  'dist:win:dir',
  'dist:linux'
];

test('runtime and packaging scripts explicitly ensure vendored tokscale', () => {
  for (const name of runtimeScripts) {
    assert.match(packageJson.scripts[name], /ensure:tokscale/, name);
  }
  assert.match(packageJson.scripts['pack:mac:widget'], /--platform=darwin-arm64/);
  assert.match(packageJson.scripts['pack:mac:widget:x64'], /--platform=darwin-x64/);
  assert.match(packageJson.scripts['dist:win:dir'], /--platform=win32-x64/);
  assert.match(packageJson.scripts['dist:linux'], /--platform=linux-x64/);
});

test('ordinary install-adjacent scripts do not pull the vendored binary', () => {
  for (const name of ['hub', 'test', 'lint', 'verify', 'build:mac-widget', 'dist:win:prepackaged']) {
    assert.doesNotMatch(packageJson.scripts[name], /ensure:tokscale/, name);
  }
  assert.equal(packageJson.scripts.postinstall, undefined);
  assert.equal(packageJson.scripts.prepack, undefined);
});

test('only the mac-widget CI structural build opts out of a strict cross-arch ensure', () => {
  // pack:mac:widget:x64 exists to let the mac-widget CI job cross-build both
  // arm64 and x64 widget variants on one arm64 runner purely to verify app
  // structure — that output is never uploaded or distributed. Every script
  // that actually produces a distributable artifact (dist:mac:x64,
  // dist:mac:widget:x64) must stay strict: a missing target npm package on a
  // real cross-arch build has to fail the build, not silently ship without
  // the pinned binary.
  assert.match(packageJson.scripts['pack:mac:widget:x64'], /--allow-missing-target-package/);
  for (const name of ['dist:mac:x64', 'dist:mac:widget:x64', 'dist:mac', 'dist:mac:widget', 'dist:win', 'dist:win:dir', 'dist:linux', 'pack', 'pack:mac:widget']) {
    assert.doesNotMatch(packageJson.scripts[name], /--allow-missing-target-package/, name);
  }
});

test('vendored CI keeps the complete Release asset verifier wired in', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'vendor-tokscale.yml'), 'utf8');
  assert.match(workflow, /verify-release-assets:/);
  assert.match(workflow, /node scripts\/verify-vendored-tokscale-release\.js/);
  assert.match(workflow, /'scripts\/verify-vendored-tokscale-release\.js'/);
});
