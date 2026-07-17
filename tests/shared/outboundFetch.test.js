'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cleanProxyUrl,
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

test('resolveProxyUrl prefers HTTPS_PROXY then HTTP_PROXY then ALL_PROXY', () => {
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

test('createOutboundFetch with proxy uses undici ProxyAgent dispatcher', async () => {
  const calls = [];
  class FakeProxyAgent {
    constructor(url) {
      this.proxyUrl = url;
    }
  }
  const undiciFetch = async (url, init) => {
    calls.push({ url: String(url), hasDispatcher: Boolean(init && init.dispatcher) });
    return { ok: true, status: 200 };
  };
  const fetchFn = createOutboundFetch(
    { HTTPS_PROXY: 'http://127.0.0.1:7897' },
    { ProxyAgent: FakeProxyAgent, undiciFetch }
  );
  const res = await fetchFn('https://grok.com/test', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://grok.com/test');
  assert.equal(calls[0].hasDispatcher, true);
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
