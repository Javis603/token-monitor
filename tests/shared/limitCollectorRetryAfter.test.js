'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { probeLimitProvider } = require('../../src/shared/limitCollector');

test('probeLimitProvider reports Retry-After and links the parent signal into adapter fetches', async () => {
  const parent = new AbortController();
  const reported = [];
  let fetchSignal = null;
  const rows = await probeLimitProvider('kimi', {}, {
    signal: parent.signal,
    onRetryAfter: (delayMs) => reported.push(delayMs)
  }, {
    now: () => Date.parse('2026-07-22T04:00:00Z'),
    fetch: async (_url, init) => {
      fetchSignal = init.signal;
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '12' : null }
      };
    },
    providerFetchers: {
      kimi: async (_options, deps) => {
        const response = await deps.fetch('https://example.invalid/quota');
        return { provider: 'kimi', status: response.status === 429 ? 'sourceRateLimited' : 'ok', windows: [] };
      }
    }
  });

  assert.equal(rows[0].status, 'sourceRateLimited');
  assert.deepEqual(reported, [12_000]);
  assert.equal(fetchSignal.aborted, false);
  parent.abort(new Error('stop'));
  assert.equal(fetchSignal.aborted, true);
});

test('probeLimitProvider reports an HTTP-date Retry-After without exposing it on the public row', async () => {
  const reported = [];
  const rows = await probeLimitProvider('kimi', {}, {
    onRetryAfter: (delayMs) => reported.push(delayMs)
  }, {
    now: () => Date.parse('2026-07-22T04:00:00Z'),
    fetch: async () => ({
      ok: false,
      status: 503,
      headers: { get: () => 'Wed, 22 Jul 2026 04:00:20 GMT' }
    }),
    providerFetchers: {
      kimi: async (_options, deps) => {
        await deps.fetch('https://example.invalid/quota');
        return { provider: 'kimi', status: 'unavailable', windows: [] };
      }
    }
  });

  assert.deepEqual(reported, [20_000]);
  assert.equal(Object.hasOwn(rows[0], 'retryAfterMs'), false);
});

test('the probe wrapper preserves Grok proxy dispatch while adding the parent signal', async () => {
  const controller = new AbortController();
  let capturedInit = null;
  class FakeProxyAgent {
    constructor(options) {
      this.options = options;
    }
  }

  await probeLimitProvider('grok', {}, { signal: controller.signal }, {
    env: { HTTPS_PROXY: 'http://proxy.test:7890', NO_PROXY: 'localhost' },
    EnvHttpProxyAgent: FakeProxyAgent,
    undiciFetch: async (_url, init) => {
      capturedInit = init;
      return { ok: true, status: 200, headers: { get: () => null } };
    },
    providerFetchers: {
      grok: async (_options, deps) => {
        await deps.fetch('https://grok.test/limits');
        return { provider: 'grok', status: 'ok', windows: [] };
      }
    }
  });

  assert.equal(capturedInit.signal, controller.signal);
  assert.ok(capturedInit.dispatcher instanceof FakeProxyAgent);
  assert.equal(capturedInit.dispatcher.options.httpsProxy, 'http://proxy.test:7890');
  assert.equal(capturedInit.dispatcher.options.noProxy, 'localhost');
});
