'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { currentHubBuild } = require('../../src/shared/hubBuildIdentity');
const { healthRuntime, probeHubBuild } = require('../../src/electron/hubBuildStatus');

function response(payload, options = {}) {
  return {
    ok: options.ok !== false,
    async json() { return payload; }
  };
}

test('remote Hub probe recognizes the exact current Worker build', async () => {
  let requested = '';
  const result = await probeHubBuild('https://hub.example/', {
    fetchImpl: async (url) => {
      requested = url;
      return response({ role: 'hub', hubBuild: currentHubBuild('cloudflare-worker') });
    }
  });
  assert.equal(requested, 'https://hub.example/api/health');
  assert.deepEqual(result, {
    status: 'current',
    runtime: 'cloudflare-worker',
    hubUrl: 'https://hub.example'
  });
});

test('desktop Hub build status checks health through the Hub transport', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const source = main.slice(main.indexOf('async function getHubBuildStatus()'), main.indexOf('async function startEmbeddedHub()'));
  const fetchFromHub = async (url) => {
    assert.equal(url, 'https://proxy-only.invalid/api/health');
    return response({ role: 'hub', hubBuild: currentHubBuild('node-hub') });
  };
  const getStatus = vm.runInNewContext(source + 'getHubBuildStatus;', {
    settings: { hubMode: 'client', hubUrl: 'https://proxy-only.invalid' },
    fetchFromHub,
    probeHubBuild(url, options) {
      assert.equal(options?.fetchImpl, fetchFromHub);
      return probeHubBuild(url, options);
    }
  });
  assert.equal((await getStatus()).status, 'current');
});

test('remote Hub probe identifies legacy health responses without guessing an update direction', async () => {
  const result = await probeHubBuild('https://hub.example', {
    fetchImpl: async () => response({ ok: true, role: 'hub', runtime: 'cloudflare-worker', version: 1 })
  });
  assert.deepEqual(result, {
    status: 'legacy',
    runtime: 'cloudflare-worker',
    hubUrl: 'https://hub.example'
  });
});

test('Node deployment labels are optional and independent of build status', async () => {
  for (const [runtime, deployment, expected] of [
    ['node-hub', 'app', { deployment: 'app' }],
    ['node-hub', 'standalone', { deployment: 'standalone' }],
    ['node-hub', undefined, {}],
    ['node-hub', 'unexpected', {}],
    ['cloudflare-worker', 'app', {}]
  ]) {
    const result = await probeHubBuild('https://hub.example', {
      fetchImpl: async () => response({ role: 'hub', hubBuild: currentHubBuild(runtime), deployment })
    });
    assert.deepEqual(result, { status: 'current', runtime, ...expected, hubUrl: 'https://hub.example' });
  }
});

test('remote Hub probe treats present but malformed build metadata as unknown', async () => {
  const result = await probeHubBuild('https://hub.example', {
    fetchImpl: async () => response({
      role: 'hub',
      runtime: 'cloudflare-worker',
      hubBuild: { runtime: 'cloudflare-worker', schemaVersion: 0 }
    })
  });
  assert.deepEqual(result, {
    status: 'unknown',
    runtime: 'cloudflare-worker',
    hubUrl: 'https://hub.example'
  });
});

test('remote Hub probe rejects a successful response from a non-Hub service', async () => {
  const result = await probeHubBuild('https://example.com', {
    fetchImpl: async () => response({ ok: true })
  });
  assert.deepEqual(result, {
    status: 'unavailable',
    runtime: '',
    hubUrl: 'https://example.com'
  });
});

test('remote Hub probe suppresses transport failures so stream status remains authoritative', async () => {
  const result = await probeHubBuild('https://hub.example', {
    fetchImpl: async () => { throw new Error('offline'); }
  });
  assert.equal(result.status, 'unavailable');
});

test('health runtime normalizes both Hub runtime spellings', () => {
  assert.equal(healthRuntime({ runtime: 'worker' }), 'cloudflare-worker');
  assert.equal(healthRuntime({ hubBuild: { runtime: 'node-hub' } }), 'node-hub');
});
