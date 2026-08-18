'use strict';

const assert = require('node:assert/strict');
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
