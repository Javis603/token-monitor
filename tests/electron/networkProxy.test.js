'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  createSessionProxyApplier,
  networkProxySource,
  normalizeNoProxy,
  normalizeProxyUrl,
  proxyEnvForSettings,
  proxyUrlError,
  sessionProxyConfig
} = require('../../src/electron/networkProxy');
const { createOutboundFetch, resetOutboundFetchCache, resolveProxyConfig } = require('../../src/shared/outboundFetch');

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

// undici honors `*` only as the whole NO_PROXY value and reads a bare `::1` as
// host `:` port `1`, so the stored list has to be in the form it can match.
test('the bypass list keeps a wildcard standalone and brackets IPv6 literals', () => {
  assert.equal(normalizeNoProxy('example.com, *'), '*');
  assert.equal(normalizeNoProxy('::1, fd00::1:8080, [::1]'), '[::1],[fd00::1:8080]');
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
    noProxy: 'localhost,127.0.0.1,[::1],example.com,corp.example'
  });
  // The caller's env is never mutated.
  assert.equal(env.HTTP_PROXY, 'http://stale:1');
});

// A hand-edited settings.json value the form would refuse must not quietly turn
// into a direct connection on a network where direct access is the problem —
// on either stack, which is what the settings form reports.
test('an invalid proxy setting blocks both stacks instead of going direct', () => {
  for (const proxyUrl of ['socks5://127.0.0.1:7897', 'http://user:pass@127.0.0.1:7897']) {
    const next = proxyEnvForSettings({ proxyUrl }, { HTTPS_PROXY: 'http://env:1' });
    assert.equal(resolveProxyConfig(next).httpsProxy, 'http://proxy.invalid:1');
    assert.equal(networkProxySource({ proxyUrl }, {}), 'invalid');
    const session = sessionProxyConfig({ proxyUrl }, {});
    assert.equal(session.mode, 'fixed_servers');
    assert.equal(session.proxyRules, 'http://proxy.invalid:1');
  }
});

test('the reported source follows setting > env > system', () => {
  assert.equal(networkProxySource({ proxyUrl: 'http://127.0.0.1:7897' }, { HTTPS_PROXY: 'http://env:1' }), 'setting');
  assert.equal(networkProxySource({}, { HTTPS_PROXY: 'http://env:1' }), 'environment');
  assert.equal(networkProxySource({}, { all_proxy: 'http://env:1' }), 'environment');
  assert.equal(networkProxySource({}, {}), 'system');
});

test('the Chromium session follows the setting and is left alone without one', () => {
  assert.equal(sessionProxyConfig({}, {}), null);
  assert.equal(sessionProxyConfig({}, { HTTPS_PROXY: 'http://env:1' }), null);
  assert.deepEqual(sessionProxyConfig({ proxyUrl: '127.0.0.1:7897', noProxy: 'example.com .internal.net' }, {}), {
    mode: 'fixed_servers',
    proxyRules: 'http://127.0.0.1:7897',
    // Chromium's implicit loopback set is wider than what undici can express,
    // so it is replaced by the same explicit hosts. A name covers its
    // subdomains in undici, which Chromium spells as a second `*.` rule.
    proxyBypassRules: '<-loopback>,localhost,*.localhost,127.0.0.1,[::1],'
      + 'example.com,*.example.com,internal.net,*.internal.net'
  });
});

// One effective bypass list feeds both stacks, so the env NO_PROXY the Node
// side honors has to reach Chromium too.
test('the Chromium bypass rules come from the same effective list as the Node side', () => {
  const settings = { proxyUrl: '127.0.0.1:7897', noProxy: 'example.com:8443' };
  const env = { NO_PROXY: 'corp.example,10.0.0.1' };
  assert.equal(resolveProxyConfig(proxyEnvForSettings(settings, env)).noProxy,
    'localhost,127.0.0.1,[::1],example.com:8443,corp.example,10.0.0.1');
  assert.equal(sessionProxyConfig(settings, env).proxyBypassRules,
    '<-loopback>,localhost,*.localhost,127.0.0.1,[::1],example.com:8443,*.example.com:8443,'
    + 'corp.example,*.corp.example,10.0.0.1');
  assert.equal(sessionProxyConfig(settings, { NO_PROXY: '*' }).proxyBypassRules, '*');
  assert.equal(resolveProxyConfig(proxyEnvForSettings(settings, { NO_PROXY: '*' })).noProxy, '*');
});

function fakeSession({ failures = 0, closeFailures = 0 } = {}) {
  const calls = [];
  return {
    calls,
    setProxy: async (config) => {
      calls.push(config);
      if (failures > 0) {
        failures -= 1;
        throw new Error('setProxy failed');
      }
    },
    closeAllConnections: async () => {
      calls.push('close');
      if (closeFailures > 0) {
        closeFailures -= 1;
        throw new Error('closeAllConnections failed');
      }
    }
  };
}

test('a failed session apply is retried by the next apply of the same config', async () => {
  const session = fakeSession({ failures: 1 });
  let config = { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7897', proxyBypassRules: '' };
  const applier = createSessionProxyApplier({ getSession: () => session, getConfig: () => config });

  assert.equal(await applier.apply(), false);
  assert.equal(await applier.apply(), true);
  assert.equal(await applier.apply(), false, 'an applied config is not re-applied');
  config = null;
  assert.equal(await applier.apply(), true);
  assert.deepEqual(session.calls.filter((call) => call !== 'close').map((call) => call.mode || call),
    ['fixed_servers', 'fixed_servers', 'system']);
});

// Sockets pooled over the old route keep using it until they are closed, so a
// failed close has to be retried without re-applying the route itself.
test('a failed close of pooled connections is retried by the next apply', async () => {
  const session = fakeSession({ closeFailures: 1 });
  const config = { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7897', proxyBypassRules: '' };
  const applier = createSessionProxyApplier({ getSession: () => session, getConfig: () => config });

  assert.equal(await applier.apply(), true, 'the route itself changed');
  assert.equal(await applier.apply(), true, 'the retried close cleared the old sockets');
  assert.equal(await applier.apply(), false);
  assert.equal(session.calls.filter((call) => call !== 'close').length, 1);
  assert.equal(session.calls.filter((call) => call === 'close').length, 2);
});

test('an install without a proxy setting never touches the session', async () => {
  const session = fakeSession();
  const applier = createSessionProxyApplier({ getSession: () => session, getConfig: () => null });
  assert.equal(await applier.apply(), false);
  assert.deepEqual(session.calls, []);
});

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

// Behavioral check against undici itself: the proxy below records every
// CONNECT and refuses it, the origin answers directly.
async function routeThroughSetting(t, settings, url, originHost) {
  const tunnels = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => { tunnels.push(req.url); socket.end('HTTP/1.1 502 Refused\r\n\r\n'); });
  const origin = http.createServer((req, res) => res.end('direct'));
  const proxyPort = await listen(proxy, '127.0.0.1');
  let originPort;
  try {
    originPort = await listen(origin, originHost);
  } catch (error) {
    proxy.close();
    t.skip(`cannot listen on ${originHost}: ${error.code}`);
    return null;
  }
  t.after(() => { proxy.close(); origin.close(); resetOutboundFetchCache(); });
  const env = proxyEnvForSettings({ ...settings, proxyUrl: `127.0.0.1:${proxyPort}` }, {});
  const target = url.replace('PORT', originPort);
  try {
    return { body: await (await createOutboundFetch(env)(target, { signal: AbortSignal.timeout(3000) })).text(), tunnels };
  } catch (error) {
    return { error, tunnels };
  }
}

test('IPv6 loopback stays direct under the proxy setting', async (t) => {
  const result = await routeThroughSetting(t, {}, 'http://[::1]:PORT/', '::1');
  if (!result) return;
  assert.deepEqual(result.tunnels, []);
  assert.equal(result.body, 'direct');
});

test('a wildcard in the bypass list sends nothing through the proxy', async (t) => {
  const result = await routeThroughSetting(t, { noProxy: 'example.com, *' }, 'http://bypassed.invalid/', '127.0.0.1');
  if (!result) return;
  assert.deepEqual(result.tunnels, []);
});
