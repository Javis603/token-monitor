'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { tokscalePackageNameForPlatform } = require('../../src/shared/tokscalePlatform');

test('tokscalePackageNameForPlatform returns npm package names including Windows msvc suffix', () => {
  assert.equal(tokscalePackageNameForPlatform('darwin', 'arm64'), '@tokscale/cli-darwin-arm64');
  assert.equal(tokscalePackageNameForPlatform('darwin', 'x64'), '@tokscale/cli-darwin-x64');
  assert.equal(tokscalePackageNameForPlatform('win32', 'x64'), '@tokscale/cli-win32-x64-msvc');
  assert.equal(tokscalePackageNameForPlatform('win32', 'arm64'), '@tokscale/cli-win32-arm64-msvc');
});

test('tokscalePackageNameForPlatform returns null for platforms handled outside the primary package helper', () => {
  assert.equal(tokscalePackageNameForPlatform('linux', 'x64'), null);
  assert.equal(tokscalePackageNameForPlatform('darwin', 'ia32'), null);
});
