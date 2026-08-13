'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { compareHubBuild, validBuildId } = require('../../src/shared/hubBuildComparison');
const { currentHubBuild } = require('../../src/shared/hubBuildIdentity');
const registry = require('../../src/shared/hubBuildRegistry.json');
const {
  WORKER_SHARED_MODULES,
  currentHubSourceBuildIds,
  latestEntry,
  nodeLockBuildInput,
  nodePackageBuildInput,
  updatedRegistry,
  workerLockBuildInput,
  workerPackageBuildInput,
  workerSharedPackageContents
} = require('../../scripts/hub-build-manifest');

function buildId(character) {
  return `sha256:${character.repeat(64)}`;
}

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

test('Worker resolved toolchain changes affect its build identity without following the product version', () => {
  const lock = {
    name: 'token-monitor-hub-worker',
    version: '0.42.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'token-monitor-hub-worker', version: '0.42.0' },
      'node_modules/wrangler': { version: '4.118.0', integrity: 'sha512:first' }
    }
  };
  assert.equal(
    workerLockBuildInput(lock),
    workerLockBuildInput({
      ...lock,
      version: '0.43.0',
      packages: { ...lock.packages, '': { ...lock.packages[''], version: '0.43.0' } }
    })
  );
  assert.notEqual(
    workerLockBuildInput(lock),
    workerLockBuildInput({
      ...lock,
      packages: {
        ...lock.packages,
        'node_modules/wrangler': { version: '4.119.0', integrity: 'sha512:second' }
      }
    })
  );
});

test('Node Hub identity follows only its declared dotenv runtime dependency and resolution', () => {
  const packageJson = {
    version: '0.42.0',
    dependencies: { dotenv: '^17.4.2', semver: '^7.8.5' }
  };
  assert.equal(
    nodePackageBuildInput(packageJson),
    nodePackageBuildInput({ ...packageJson, version: '0.43.0' })
  );
  assert.notEqual(
    nodePackageBuildInput(packageJson),
    nodePackageBuildInput({ ...packageJson, dependencies: { ...packageJson.dependencies, dotenv: '^18.0.0' } })
  );

  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { version: '0.42.0' },
      'node_modules/dotenv': { version: '17.4.2', integrity: 'sha512:first' },
      'node_modules/semver': { version: '7.8.5', integrity: 'sha512:unrelated' }
    }
  };
  assert.equal(
    nodeLockBuildInput(lock),
    nodeLockBuildInput({ ...lock, packages: { ...lock.packages, '': { version: '0.43.0' } } })
  );
  assert.equal(
    nodeLockBuildInput(lock),
    nodeLockBuildInput({
      ...lock,
      packages: {
        ...lock.packages,
        'node_modules/semver': { version: '8.0.0', integrity: 'sha512:changed-but-unrelated' }
      }
    })
  );
  assert.notEqual(
    nodeLockBuildInput(lock),
    nodeLockBuildInput({
      ...lock,
      packages: {
        ...lock.packages,
        'node_modules/dotenv': { version: '18.0.0', integrity: 'sha512:second' }
      }
    })
  );
});

test('Worker runtime identity includes its generated CommonJS boundary', () => {
  assert.match(workerSharedPackageContents(), /"type": "commonjs"/);
  assert.notEqual(workerSharedPackageContents(), workerSharedPackageContents({ type: 'module' }));
});

test('desktop comparison changes do not alter the portable Hub core closure', () => {
  assert.ok(WORKER_SHARED_MODULES.includes('hubBuildIdentity.js'));
  assert.ok(!WORKER_SHARED_MODULES.includes('hubBuildComparison.js'));
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
    coreBuildId: buildId('a')
  }).status, 'updateAvailable');
  assert.equal(compareHubBuild({
    ...current,
    runtimeRevision: current.runtimeRevision + 1,
    runtimeBuildId: buildId('b')
  }).status, 'remoteNewer');
  assert.equal(compareHubBuild({
    ...current,
    runtimeBuildId: 'sha256:custom'
  }).status, 'unknown');
  assert.equal(compareHubBuild(undefined).status, 'legacy');
});

test('only absent build metadata is legacy and current-schema metadata fails closed', () => {
  const current = currentHubBuild('cloudflare-worker');
  assert.equal(compareHubBuild(undefined).status, 'legacy');
  for (const invalid of [null, [], '', { ...current, schemaVersion: 0 }, { ...current, schemaVersion: 'nope' }]) {
    assert.equal(compareHubBuild(invalid).status, 'unknown');
  }
  assert.equal(compareHubBuild({
    ...current,
    coreRevision: current.coreRevision + 1,
    coreBuildId: undefined
  }).status, 'unknown');
  assert.equal(compareHubBuild({
    ...current,
    runtimeRevision: current.runtimeRevision + 1,
    runtimeBuildId: 'sha256:not-a-real-digest'
  }).status, 'unknown');
  assert.equal(validBuildId(buildId('f')), true);
  assert.equal(validBuildId(`sha256:${'F'.repeat(64)}`), false);
});

test('known historical revisions must retain their canonical build ids', () => {
  const current = currentHubBuild('cloudflare-worker');
  const expectedNext = {
    ...current,
    coreRevision: current.coreRevision + 1,
    coreBuildId: buildId('c'),
    runtimeRevision: current.runtimeRevision + 1,
    runtimeBuildId: buildId('d')
  };
  assert.equal(compareHubBuild(current, expectedNext).status, 'updateAvailable');
  assert.equal(compareHubBuild({
    ...current,
    coreBuildId: 'sha256:custom-old-core'
  }, expectedNext).status, 'unknown');
  assert.equal(compareHubBuild({
    ...current,
    runtimeBuildId: 'sha256:custom-old-runtime'
  }, expectedNext).status, 'unknown');
  assert.equal(compareHubBuild({
    ...current,
    coreBuildId: 'sha256:custom-known-future-core'
  }, {
    ...current,
    coreRevision: current.coreRevision - 1,
    coreBuildId: 'sha256:older-expected-core'
  }).status, 'unknown');
});

test('mixed component directions are treated as unknown instead of suggesting a downgrade', () => {
  const current = currentHubBuild('node-hub');
  assert.equal(compareHubBuild({
    ...current,
    coreRevision: current.coreRevision + 1,
    coreBuildId: buildId('e')
  }, {
    ...current,
    runtimeRevision: current.runtimeRevision + 1,
    runtimeBuildId: buildId('f')
  }).status, 'unknown');
});
