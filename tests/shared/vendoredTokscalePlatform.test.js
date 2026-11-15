'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vendored = require('../../scripts/vendoredTokscale');
const { resolveManifestEntry, resolveOptionalManifestEntry } = vendored;

for (const runtime of [
  { name: 'Linux musl', platform: 'linux', arch: 'x64', header: {}, ldd: 'musl libc', key: 'linux-x64-musl' },
  { name: 'Linux glibc', platform: 'linux', arch: 'x64', header: { glibcVersionRuntime: '2.39' }, key: 'linux-x64' },
  { name: 'static glibc Node on glibc', platform: 'linux', arch: 'x64', header: { glibcVersionCompiler: '2.39' }, ldd: '# This file is part of the GNU C Library.', key: 'linux-x64' },
  { name: 'static glibc Node on musl', platform: 'linux', arch: 'x64', header: { glibcVersionCompiler: '2.39' }, ldd: 'musl libc', key: 'linux-x64-musl' },
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
    const readFile = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === '/usr/bin/ldd') {
        assert.equal(typeof runtime.ldd, 'string', 'known runtime reports must not need the ldd fallback');
        return runtime.ldd;
      }
      return readFile(file, ...args);
    });

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

    const selected = new Error('selected native package');
    t.mock.method(vendored, 'loadManifest', () => manifest);
    t.mock.method(vendored, 'resolveTargetBinPath', entry => {
      assert.equal(entry.package, expected.entry.package);
      throw selected;
    });
    for (const [script, entryPoint] of [
      ['verify-vendored-tokscale', 'main'],
      ['verify-vendored-tokscale-clients', 'verifyVendoredTokscaleClients']
    ]) {
      const modulePath = require.resolve(`../../scripts/${script}`);
      delete require.cache[modulePath];
      t.after(() => { delete require.cache[modulePath]; });
      const verifier = require(modulePath);
      assert.throws(() => verifier[entryPoint](), error => error === selected);
    }
  });
}
