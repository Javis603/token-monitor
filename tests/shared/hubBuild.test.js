'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { compareHubBuild, currentHubBuild } = require('../../src/shared/hubBuild');
const registry = require('../../src/shared/hubBuildRegistry.json');
const {
  currentHubSourceBuildIds,
  latestEntry,
  updatedRegistry,
  workerPackageBuildInput
} = require('../../scripts/hub-build-manifest');

test('Hub build registry matches the current core and runtime source closures', () => {
  const sourceBuildIds = currentHubSourceBuildIds();
  for (const component of ['core', 'node-hub', 'cloudflare-worker']) {
    assert.equal(
      latestEntry(registry, component)?.buildId,
      sourceBuildIds[component],
      `${component} changed; run npm run update:hub-build after the implementation is final`
    );
  }
});

test('Worker package product version does not affect its build identity input', () => {
  const common = { type: 'module', devDependencies: { wrangler: '^4.118.0' } };
  assert.equal(
    workerPackageBuildInput({ ...common, version: '0.42.0' }),
    workerPackageBuildInput({ ...common, version: '0.43.0' })
  );
});

test('Hub build registry advances only the component whose source changed', () => {
  const base = {
    schemaVersion: 1,
    components: {
      core: [{ revision: 3, buildId: 'sha256:core' }],
      'node-hub': [{ revision: 4, buildId: 'sha256:node-old' }],
      'cloudflare-worker': [{ revision: 5, buildId: 'sha256:worker' }]
    }
  };
  const next = updatedRegistry(base, {
    core: 'sha256:core',
    'node-hub': 'sha256:node-new',
    'cloudflare-worker': 'sha256:worker'
  });
  assert.equal(next.components.core.length, 1);
  assert.deepEqual(next.components['node-hub'].at(-1), { revision: 5, buildId: 'sha256:node-new' });
  assert.equal(next.components['cloudflare-worker'].length, 1);
});

test('Hub build comparison distinguishes current, older, newer, and divergent builds', () => {
  const current = currentHubBuild('cloudflare-worker');
  assert.equal(compareHubBuild(current).status, 'current');
  assert.equal(compareHubBuild(current, {
    ...current,
    coreRevision: current.coreRevision + 1,
    coreBuildId: 'sha256:expected-newer'
  }).status, 'updateAvailable');
  assert.equal(compareHubBuild({
    ...current,
    runtimeRevision: current.runtimeRevision + 1,
    runtimeBuildId: 'sha256:newer'
  }).status, 'remoteNewer');
  assert.equal(compareHubBuild({
    ...current,
    runtimeBuildId: 'sha256:custom'
  }).status, 'unknown');
  assert.equal(compareHubBuild(null).status, 'legacy');
});

test('mixed component directions are treated as unknown instead of suggesting a downgrade', () => {
  const current = currentHubBuild('node-hub');
  assert.equal(compareHubBuild({
    ...current,
    coreRevision: current.coreRevision + 1,
    runtimeRevision: current.runtimeRevision - 1
  }).status, 'unknown');
});
