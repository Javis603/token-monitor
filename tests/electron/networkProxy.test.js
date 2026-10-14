'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  networkProxySource,
  normalizeNoProxy,
  normalizeProxyUrl,
  proxyEnvForSettings,
  proxyUrlError,
  sessionProxyConfig
} = require('../../src/electron/networkProxy');
const { resolveProxyConfig } = require('../../src/shared/outboundFetch');

test('proxy URLs normalize to scheme://host[:port]', () => {
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(normalizeProxyUrl('  http://127.0.0.1:7897/  '), 'http://127.0.0.1:7897');
  assert.equal(normalizeProxyUrl('"http://127.0.0.1:7897"'), 'http://127.0.0.1:7897');
  assert.equal(normalizeProxyUrl('HTTPS://Proxy.Example.com:8443'), 'https://proxy.example.com:8443');
  // What proxy clients show for copying; `localhost:7897` would otherwise parse
  // as a `localhost:` scheme.
  assert.equal(normalizeProxyUrl('127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(normalizeProxyUrl('localhost:7897'), 'http://localhost:7897');
  assert.equal(normalizeProxyUrl('[::1]:7897'), 'http://[::1]:7897');
  assert.equal(normalizeProxyUrl(''), '');
  assert.equal(normalizeProxyUrl(undefined), '');
});

test('proxy URLs the transport cannot honor are refused with a reason', () => {
  assert.equal(proxyUrlError(''), '');
  assert.equal(proxyUrlError('http://127.0.0.1:7897'), '');
  assert.equal(proxyUrlError('socks5://127.0.0.1:7897'), 'proxy_unsupported_scheme');
  assert.equal(proxyUrlError('http://user:pass@127.0.0.1:7897'), 'proxy_credentials_unsupported');
  assert.equal(proxyUrlError('http://127.0.0.1:7897/path'), 'proxy_invalid_url');
  assert.equal(proxyUrlError('http://127.0.0.1:99999'), 'proxy_invalid_url');
  assert.equal(proxyUrlError('http://'), 'proxy_invalid_url');
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:7897'), '');
});

test('the bypass list accepts commas, spaces and new lines', () => {
  assert.equal(normalizeNoProxy(' example.com, .internal.net\nfoo.local  example.com '), 'example.com,.internal.net,foo.local');
  assert.equal(normalizeNoProxy(undefined), '');
});

test('without a proxy setting the process env passes through untouched', () => {
  const env = { HTTPS_PROXY: 'http://env-proxy:1', PATH: '/bin' };
  assert.equal(proxyEnvForSettings({}, env), env);
  assert.equal(proxyEnvForSettings({ proxyUrl: '  ' }, env), env);
});

test('the proxy setting replaces every proxy env var and keeps loopback direct', () => {
  const env = {
    HTTP_PROXY: 'http://stale:1',
    https_proxy: 'http://stale:2',
    ALL_PROXY: 'http://stale:3',
    NO_PROXY: 'corp.example',
    PATH: '/bin'
  };
  const next = proxyEnvForSettings({ proxyUrl: '127.0.0.1:7897', noProxy: 'example.com' }, env);
  assert.equal(next.PATH, '/bin');
  assert.equal(next.HTTP_PROXY, undefined);
  assert.equal(next.ALL_PROXY, undefined);
  assert.deepEqual(resolveProxyConfig(next), {
    httpProxy: 'http://127.0.0.1:7897',
    httpsProxy: 'http://127.0.0.1:7897',
    noProxy: 'localhost,127.0.0.1,::1,example.com,corp.example'
  });
  // The caller's env is never mutated.
  assert.equal(env.HTTP_PROXY, 'http://stale:1');
});

// A hand-edited settings.json value the form would refuse must not quietly turn
// into a direct connection on a network where direct access is the problem.
test('an invalid proxy setting stays configured so the transport fails closed', () => {
  const next = proxyEnvForSettings({ proxyUrl: 'socks5://127.0.0.1:7897' }, { HTTPS_PROXY: 'http://env:1' });
  assert.equal(resolveProxyConfig(next).httpsProxy, 'socks5://127.0.0.1:7897');
  assert.equal(networkProxySource({ proxyUrl: 'socks5://127.0.0.1:7897' }, {}), 'invalid');
});

test('the reported source follows setting > env > system', () => {
  assert.equal(networkProxySource({ proxyUrl: 'http://127.0.0.1:7897' }, { HTTPS_PROXY: 'http://env:1' }), 'setting');
  assert.equal(networkProxySource({}, { HTTPS_PROXY: 'http://env:1' }), 'environment');
  assert.equal(networkProxySource({}, { all_proxy: 'http://env:1' }), 'environment');
  assert.equal(networkProxySource({}, {}), 'system');
});

test('the Chromium session follows the setting and is left alone without one', () => {
  assert.equal(sessionProxyConfig({}), null);
  assert.equal(sessionProxyConfig({ proxyUrl: 'ftp://x' }), null);
  assert.deepEqual(sessionProxyConfig({ proxyUrl: '127.0.0.1:7897', noProxy: 'example.com .internal.net' }), {
    mode: 'fixed_servers',
    proxyRules: 'http://127.0.0.1:7897',
    proxyBypassRules: 'example.com,.internal.net'
  });
});
