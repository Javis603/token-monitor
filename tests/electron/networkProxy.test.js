'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AppProxyAgent,
  createSessionProxyApplier,
  networkProxySource,
  noProxyError,
  normalizeNoProxy,
  normalizeProxyUrl,
  outboundRouteForSettings,
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
  assert.equal(normalizeNoProxy(' example.com, internal.net\nfoo.local  example.com '), 'example.com,internal.net,foo.local');
  assert.equal(normalizeNoProxy(undefined), '');
});

test('bypass length is checked after normalization without truncating hosts', () => {
  const prefix = Array.from({ length: 198 }, (_, i) => `a${String(i).padStart(3, '0')}.test`).join(',');
  for (const length of [1999, 2000, 2001]) {
    const input = `${prefix},${'x'.repeat(length - prefix.length - 1)}`;
    assert.equal(input.length, length);
    if (length <= 2000) {
      assert.equal(noProxyError(input), '');
      assert.equal(normalizeNoProxy(input), input);
    } else {
      assert.equal(noProxyError(input), 'proxy_bypass_too_long');
      assert.throws(() => normalizeNoProxy(input), /proxy_bypass_too_long/);
    }
  }
  const input = `${prefix},pad.test,example.com.evil`;
  assert.equal(input.length, 2005);
  assert.equal(noProxyError(input), 'proxy_bypass_too_long');
  assert.throws(() => normalizeNoProxy(input), /proxy_bypass_too_long/);
  assert.equal(noProxyError(`${prefix}, ${prefix}`), '', 'duplicates and whitespace count only after normalization');
  assert.equal(normalizeNoProxy(`${prefix}, ${prefix}`), prefix);
});

// Only forms undici and Chromium read the same way are kept, in the canonical
// spelling undici matches: a leading `.`/`*.` means the domain and its
// subdomains in both, IPv6 is bracketed, and `*` must be the whole value.
test('the bypass list keeps only the forms both stacks support', () => {
  const accepted = {
    'Example.COM': 'example.com',
    '.example.com': 'example.com',
    '*.example.com:8443': 'example.com:8443',
    '10.0.0.1': '10.0.0.1',
    '10.0.0.1:8080': '10.0.0.1:8080',
    '::1': '[::1]',
    'fd00::1': '[fd00::1]',
    '[fd00::1]:8080': '[fd00::1]:8080',
    'my_host-1.internal': 'my_host-1.internal',
    '*': '*',
    'example.com, *': '*'
  };
  for (const [input, expected] of Object.entries(accepted)) {
    assert.equal(noProxyError(input), '', input);
    assert.equal(normalizeNoProxy(input), expected, input);
  }
  for (const input of [
    '10.0.0.0/8', 'fd00::/8', 'http://example.com', 'http://example.com:8080', 'https://[::1]:8443',
    '<local>', '<-loopback>', 'foo*.com', '*example.com', 'example.*', '10.0.0', '[10.0.0.1]',
    'example.com:0', 'example.com:70000', 'exämple.com', 'example.com, 10.0.0.0/8',
    // Non-standard IPv4 spellings the URL parser turns into 192.0.2.1.
    '0xc0000201', '0xC0.0.2.1:8080'
  ]) {
    assert.equal(noProxyError(input), 'proxy_bypass_unsupported', input);
  }
  // Settings saved before this check are read with the unsupported part dropped.
  assert.equal(normalizeNoProxy('example.com, 10.0.0.0/8, <local>'), 'example.com');
});

// undici compares the URL's compressed host and Chromium normalizes literals
// before matching, so an IPv6 entry is only equivalent on both stacks once it
// is stored in that same compressed form.
test('IPv6 bypass entries are stored in the compressed form both stacks match', () => {
  const equivalents = {
    '[2001:0db8:0:0:0:0:0:1]': '[2001:db8::1]',
    '2001:DB8::0:1': '[2001:db8::1]',
    '[fd00:0000::1]:8080': '[fd00::1]:8080',
    '[::ffff:10.0.0.1]': '[::ffff:a00:1]',
    '::FFFF:10.0.0.1': '[::ffff:a00:1]',
    '[0:0::1]': '[::1]'
  };
  for (const [input, expected] of Object.entries(equivalents)) {
    assert.equal(noProxyError(input), '', input);
    assert.equal(normalizeNoProxy(input), expected, input);
    assert.equal(new URL(`http://${expected.replace(/:\d+$/, '')}/`).hostname, expected.replace(/:\d+$/, ''), input);
  }
  assert.equal(normalizeNoProxy('[2001:db8::1] [2001:0db8:0:0:0:0:0:1]'), '[2001:db8::1]', 'equivalents dedupe');
  // A zone ID passes isIP but no URL can carry it.
  for (const input of ['fe80::1%en0', '[fe80::1%en0]', '[fe80::1%25en0]:8080']) {
    assert.equal(noProxyError(input), 'proxy_bypass_unsupported', input);
  }
  assert.equal(sessionProxyConfig({ proxyUrl: '127.0.0.1:7897', noProxy: '[fd00:0000::1]:8080' }).proxyBypassRules, '[fd00::1]:8080');
});

test('without a proxy setting the env-only route is left exactly as it was', () => {
  const env = { HTTPS_PROXY: 'http://env-proxy:1', NO_PROXY: 'corp.example', PATH: '/bin' };
  for (const settings of [{}, { proxyUrl: '  ' }, { noProxy: 'example.com' }]) {
    const route = outboundRouteForSettings(settings, env);
    assert.equal(route.env, env);
    assert.deepEqual(route.deps, {});
  }
});

// The setting is a complete override: no proxy variable from the shell may
// leak back in, in either case spelling, and NO_PROXY is not inherited.
test('the proxy setting replaces every proxy env var and inherits no NO_PROXY', () => {
  const env = {
    HTTP_PROXY: 'http://stale:1',
    https_proxy: 'http://stale:2',
    ALL_PROXY: 'http://stale:3',
    all_proxy: 'http://stale:4',
    NO_PROXY: 'corp.example',
    no_proxy: '*',
    PATH: '/bin'
  };
  const route = outboundRouteForSettings({ proxyUrl: '127.0.0.1:7897', noProxy: 'example.com' }, env);
  assert.equal(route.deps.EnvHttpProxyAgent, AppProxyAgent);
  assert.equal(route.env.PATH, '/bin');
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy', 'NO_PROXY']) {
    assert.equal(route.env[key], undefined, key);
  }
  assert.deepEqual(resolveProxyConfig(route.env), {
    httpProxy: 'http://127.0.0.1:7897',
    httpsProxy: 'http://127.0.0.1:7897',
    noProxy: 'example.com'
  });
  // The caller's env is never mutated.
  assert.equal(env.HTTP_PROXY, 'http://stale:1');

  // An empty bypass list is still an explicit value, never an absent one.
  const empty = outboundRouteForSettings({ proxyUrl: '127.0.0.1:7897' }, env);
  assert.equal(Object.hasOwn(empty.env, 'no_proxy'), true);
  assert.equal(empty.env.no_proxy, '');
  assert.equal(resolveProxyConfig(empty.env).noProxy, '');
});

// A hand-edited settings.json value the form would refuse must not quietly turn
// into a direct connection on a network where direct access is the problem —
// on either stack, which is what the settings form reports.
test('an invalid proxy setting blocks both stacks instead of going direct', () => {
  for (const proxyUrl of ['socks5://127.0.0.1:7897', 'http://user:pass@127.0.0.1:7897']) {
    const route = outboundRouteForSettings({ proxyUrl }, { HTTPS_PROXY: 'http://env:1' });
    assert.equal(resolveProxyConfig(route.env).httpsProxy, 'http://proxy.invalid:1');
    assert.equal(route.deps.EnvHttpProxyAgent, AppProxyAgent);
    assert.equal(networkProxySource({ proxyUrl }, {}), 'invalid');
    const session = sessionProxyConfig({ proxyUrl });
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
  assert.equal(sessionProxyConfig({}), null);
  assert.deepEqual(sessionProxyConfig({ proxyUrl: '127.0.0.1:7897', noProxy: 'example.com internal.net' }), {
    mode: 'fixed_servers',
    proxyRules: 'http://127.0.0.1:7897',
    // A name covers its subdomains in undici, which Chromium spells as a
    // second `*.` rule.
    proxyBypassRules: 'example.com,*.example.com,internal.net,*.internal.net'
  });
});

// Chromium keeps local hosts direct for security reasons (net/docs/proxy.md,
// "Implicit bypass rules"); `<-loopback>` would subtract that, so it must never
// be generated, whatever the bypass list holds.
test('the Chromium rules keep the implicit local-host bypass', () => {
  for (const noProxy of ['', 'example.com', 'localhost 127.0.0.1 ::1', '*', '<-loopback>', 'example.com <-loopback>']) {
    const rules = sessionProxyConfig({ proxyUrl: '127.0.0.1:7897', noProxy }).proxyBypassRules;
    assert.doesNotMatch(rules, /loopback/, JSON.stringify(noProxy));
  }
  assert.equal(sessionProxyConfig({ proxyUrl: '127.0.0.1:7897' }).proxyBypassRules, '');
});

test('the Chromium rules come from the same supported entries as the Node side', () => {
  const settings = { proxyUrl: '127.0.0.1:7897', noProxy: '.example.com:8443 10.0.0.1 fd00::1 10.0.0.0/8 <local>' };
  assert.equal(resolveProxyConfig(outboundRouteForSettings(settings, { NO_PROXY: 'corp.example' }).env).noProxy,
    'example.com:8443,10.0.0.1,[fd00::1]');
  assert.equal(sessionProxyConfig(settings).proxyBypassRules,
    'example.com:8443,*.example.com:8443,10.0.0.1,[fd00::1]');
  assert.equal(sessionProxyConfig({ ...settings, noProxy: 'example.com, *' }).proxyBypassRules, '*');
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
