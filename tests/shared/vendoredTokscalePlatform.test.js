'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveManifestEntry, resolveOptionalManifestEntry } = require('../../scripts/vendoredTokscale');

for (const runtime of [
  { name: 'Linux musl', platform: 'linux', arch: 'x64', header: {}, key: 'linux-x64-musl' },
  { name: 'Linux glibc', platform: 'linux', arch: 'x64', header: { glibcVersionRuntime: '2.39' }, key: 'linux-x64' },
  { name: 'macOS', platform: 'darwin', arch: 'arm64', header: {}, key: 'darwin-arm64' }
]) {
  test(`verifiers and installer select the same native package on ${runtime.name}`, (t) => {
    const descriptors = ['platform', 'arch'].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]);
    t.after(() => {
      for (const [key, descriptor] of descriptors) Object.defineProperty(process, key, descriptor);
    });
    Object.defineProperty(process, 'platform', { value: runtime.platform });
    Object.defineProperty(process, 'arch', { value: runtime.arch });
    t.mock.method(process.report, 'getReport', () => ({ header: runtime.header }));

    const manifest = { platforms: {
      'linux-x64': { package: '@tokscale/cli-linux-x64-gnu' },
      'linux-x64-musl': { package: '@tokscale/cli-linux-x64-musl' },
      'darwin-arm64': { package: '@tokscale/cli-darwin-arm64' }
    } };
    const expected = { key: runtime.key, entry: manifest.platforms[runtime.key] };
    assert.deepEqual(resolveManifestEntry(manifest), expected);
    assert.deepEqual(resolveOptionalManifestEntry(manifest), expected);
    assert.deepEqual(resolveManifestEntry(manifest, 'linux-x64'), {
      key: 'linux-x64', entry: manifest.platforms['linux-x64']
    }, 'explicit packaging targets remain authoritative');
  });
}
