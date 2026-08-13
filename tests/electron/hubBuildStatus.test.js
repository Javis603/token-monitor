'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

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
      return response({ hubBuild: currentHubBuild('cloudflare-worker') });
    }
  });
  assert.equal(requested, 'https://hub.example/api/health');
  assert.deepEqual(result, {
    status: 'current',
    runtime: 'cloudflare-worker',
    hubUrl: 'https://hub.example'
  });
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
