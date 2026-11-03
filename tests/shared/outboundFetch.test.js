'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cleanProxyUrl,
  resolveProxyConfig,
  resolveProxyUrl,
  createOutboundFetch
} = require('../../src/shared/outboundFetch');

test('cleanProxyUrl trims and strips matching quotes', () => {
  assert.equal(cleanProxyUrl('  http://127.0.0.1:7897  '), 'http://127.0.0.1:7897');
  assert.equal(cleanProxyUrl('"http://127.0.0.1:7897"'), 'http://127.0.0.1:7897');
  assert.equal(cleanProxyUrl("'http://127.0.0.1:7897'"), 'http://127.0.0.1:7897');
  assert.equal(cleanProxyUrl(''), '');
  assert.equal(cleanProxyUrl(null), '');
});

test('resolveProxyConfig follows lowercase precedence and honors NO_PROXY', () => {
  assert.deepEqual(
    resolveProxyConfig({
      https_proxy: 'http://lower:1',
      HTTPS_PROXY: 'http://upper:1',
      http_proxy: 'http://lower:2',
      HTTP_PROXY: 'http://upper:2',
      no_proxy: 'grok.com,localhost',
      NO_PROXY: 'ignored.example'
    }),
    {
      httpsProxy: 'http://lower:1',
      httpProxy: 'http://lower:2',
      noProxy: 'grok.com,localhost'
    }
  );
});

test('resolveProxyUrl prefers HTTPS proxy then HTTP proxy then ALL_PROXY', () => {
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'http://h:1', HTTP_PROXY: 'http://h:2' }), 'http://h:1');
  assert.equal(resolveProxyUrl({ HTTP_PROXY: 'http://h:2', ALL_PROXY: 'http://h:3' }), 'http://h:2');
  assert.equal(resolveProxyUrl({ all_proxy: 'http://h:3' }), 'http://h:3');
  assert.equal(resolveProxyUrl({}), '');
});

test('createOutboundFetch without proxy returns a function that delegates to global fetch', async () => {
  let called = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    called += 1;
    return { ok: true, url: String(url) };
  };
  try {
    const fetchFn = createOutboundFetch({});
    const res = await fetchFn('https://example.test/');
    assert.equal(called, 1);
    assert.equal(res.url, 'https://example.test/');
  } finally {
    globalThis.fetch = original;
  }
});

test('createOutboundFetch uses an env-aware dispatcher with NO_PROXY', async () => {
  const calls = [];
  class FakeEnvHttpProxyAgent {
    constructor(options) {
      this.options = options;
    }
  }
  const undiciFetch = async (url, init) => {
    calls.push({ url: String(url), dispatcher: init && init.dispatcher });
    return { ok: true, status: 200 };
  };
  const fetchFn = createOutboundFetch(
    { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,grok.test' },
    { EnvHttpProxyAgent: FakeEnvHttpProxyAgent, undiciFetch }
  );
  const res = await fetchFn('https://grok.com/test', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://grok.com/test');
  assert.deepEqual(calls[0].dispatcher.options, {
    httpProxy: '',
    httpsProxy: 'http://127.0.0.1:7897',
    noProxy: 'localhost,grok.test'
  });
});

test('createOutboundFetch does not silently bypass an invalid configured proxy', () => {
  class ThrowingEnvHttpProxyAgent {
    constructor() {
      throw new Error('invalid proxy URL');
    }
  }
  assert.throws(
    () => createOutboundFetch(
      { HTTPS_PROXY: 'socks5://unsupported.test:1080' },
      { EnvHttpProxyAgent: ThrowingEnvHttpProxyAgent, undiciFetch: async () => ({ ok: true }) }
    ),
    /invalid proxy URL/
  );
});

test('createOutboundFetch deps.fetch override wins over proxy wiring', async () => {
  let hits = 0;
  const fetchFn = createOutboundFetch(
    { HTTPS_PROXY: 'http://127.0.0.1:7897' },
    {
      fetch: async () => {
        hits += 1;
        return { ok: true, status: 204 };
      }
    }
  );
  const res = await fetchFn('https://example.test/');
  assert.equal(hits, 1);
  assert.equal(res.status, 204);
});
