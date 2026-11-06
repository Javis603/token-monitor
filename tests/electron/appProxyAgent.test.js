'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');

const {
  AppProxyAgent,
  isImplicitBypassHost,
  outboundRouteForSettings
} = require('../../src/electron/networkProxy');
const { createElectronLimitsFetch } = require('../../src/electron/limits/fetch');
const { createOutboundFetch, resetOutboundFetchCache } = require('../../src/shared/outboundFetch');

// Chromium's implicit bypass rules (net/docs/proxy.md) plus the forms the URL
// parser hands a dispatcher. Link-local is classified here only; no test
// connects to it, so a cloud metadata address is never contacted.
test('local hosts are classified the way Chromium keeps them direct', () => {
  const direct = [
    'localhost', 'LOCALHOST', 'localhost.', 'foo.localhost', 'foo.localhost.',
    '127.0.0.1', '127.0.0.2', '127.255.255.255', '169.254.1.1', '169.254.169.254',
    '[::1]', '::1', '[fe80::1]', '[febf::1]',
    // IPv4-mapped IPv6, as the URL parser normalizes it.
    '[::ffff:7f00:1]', '[::ffff:a9fe:101]'
  ];
  const proxied = [
    'example.com', 'localhost.example.com', 'notlocalhost', 'loopback', '0.0.0.0', '10.0.0.1',
    '192.168.1.1', '172.16.0.1', '128.0.0.1', '169.255.0.1', '[fec0::1]', '[fd00::1]', '[::ffff:a00:1]', ''
  ];
  for (const host of direct) assert.equal(isImplicitBypassHost(host, 'darwin'), true, host);
  for (const host of proxied) assert.equal(isImplicitBypassHost(host, 'darwin'), false, host);
  assert.equal(isImplicitBypassHost('loopback', 'win32'), true);
  assert.equal(isImplicitBypassHost('LOOPBACK.', 'win32'), true);
});

function recordingAgent() {
  const origins = [];
  return {
    origins,
    dispatch(options) { origins.push(String(options.origin)); return true; },
    close: async () => {},
    destroy: async () => {}
  };
}

test('each dispatch picks the direct or proxied agent from its own origin', () => {
  const agent = new AppProxyAgent({ httpProxy: 'http://127.0.0.1:9', httpsProxy: 'http://127.0.0.1:9', noProxy: '', platform: 'darwin' });
  agent.proxied = recordingAgent();
  agent.direct = recordingAgent();
  const origins = {
    'http://127.0.0.2:8080': 'direct',
    'http://169.254.169.254': 'direct',
    'http://[::ffff:127.0.0.1]:3000': 'direct',
    // The URL parser canonicalizes this to 127.0.0.2.
    'http://2130706434': 'direct',
    'http://localhost.:3000': 'direct',
    'http://api.localhost': 'direct',
    'https://example.com': 'proxied',
    'http://10.0.0.1': 'proxied',
    'http://loopback': 'proxied'
  };
  for (const origin of Object.keys(origins)) agent.dispatch({ origin, path: '/', method: 'GET' }, {});
  assert.deepEqual(agent.direct.origins, Object.keys(origins).filter((origin) => origins[origin] === 'direct'));
  assert.deepEqual(agent.proxied.origins, Object.keys(origins).filter((origin) => origins[origin] === 'proxied'));
});

// The non-compressed spelling of an IPv6 bypass entry has to reach undici as
// the compressed host the URL parser hands the dispatcher, or the request goes
// to the proxy while Chromium sends it direct.
test('an IPv6 bypass entry matches its compressed URL host on the Node side', () => {
  for (const [noProxy, origin] of [
    ['[2001:0db8:0:0:0:0:0:1]', 'http://[2001:db8::1]'],
    ['[fd00:0000::1]:8080', 'http://[fd00::1]:8080'],
    ['[::ffff:10.0.0.1]', 'http://[::ffff:10.0.0.1]']
  ]) {
    const route = outboundRouteForSettings({ proxyUrl: 'http://127.0.0.1:9', noProxy }, {});
    const agent = new AppProxyAgent({ httpProxy: route.env.http_proxy, httpsProxy: route.env.https_proxy, noProxy: route.env.no_proxy, platform: 'darwin' });
    const viaProxy = [];
    const noProxyAgent = agent.proxied;
    // The inner EnvHttpProxyAgent's own decision: a matched entry selects its
    // direct agent, anything else its proxy agent. Record which one it picks.
    // There is no public hook for this, so the test reads undici's own symbol
    // descriptions and fails loudly if an upgrade renames them.
    const symbols = Object.getOwnPropertySymbols(noProxyAgent);
    for (const name of ['no proxy agent', 'http proxy agent', 'https proxy agent']) {
      const symbol = symbols.find((candidate) => candidate.description === name);
      assert.ok(symbol, `undici no longer exposes "${name}" on EnvHttpProxyAgent`);
      noProxyAgent[symbol].dispatch = () => { viaProxy.push(name); return true; };
    }
    agent.dispatch({ origin, path: '/', method: 'GET' }, {});
    assert.deepEqual(viaProxy, ['no proxy agent'], `${noProxy} vs ${origin}`);
  }
});

test('the app agent refuses to be built without explicit proxy URLs', () => {
  assert.throws(() => new AppProxyAgent({ httpsProxy: 'http://127.0.0.1:9' }), TypeError);
  assert.throws(() => new AppProxyAgent({}), TypeError);
});

test('closing or destroying the app agent closes both inner agents', async () => {
  const options = { httpProxy: 'http://127.0.0.1:9', httpsProxy: 'http://127.0.0.1:9', noProxy: '' };
  const closing = new AppProxyAgent(options);
  await closing.close();
  assert.equal(closing.proxied.closed, true);
  assert.equal(closing.direct.closed, true);

  const viaCallback = new AppProxyAgent(options);
  await new Promise((resolve, reject) => viaCallback.close((error) => (error ? reject(error) : resolve())));
  assert.equal(viaCallback.proxied.closed, true);
  assert.equal(viaCallback.direct.closed, true);

  const destroying = new AppProxyAgent(options);
  await destroying.destroy(new Error('shutdown'));
  assert.equal(destroying.proxied.destroyed, true);
  assert.equal(destroying.direct.destroyed, true);

  const destroyedViaCallback = new AppProxyAgent(options);
  await new Promise((resolve, reject) => destroyedViaCallback.destroy((error) => (error ? reject(error) : resolve())));
  assert.equal(destroyedViaCallback.proxied.destroyed, true);
  assert.equal(destroyedViaCallback.direct.destroyed, true);
});

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

// A proxy that records every CONNECT. A target listed in `tunnels` is piped to
// the given local port; any other target is refused, so nothing leaves the
// machine.
async function startProxy(t, tunnels = {}) {
  const connects = [];
  const proxy = http.createServer((req, res) => res.writeHead(400).end());
  proxy.on('connect', (req, socket) => {
    connects.push(req.url);
    const port = tunnels[req.url];
    if (!port) {
      socket.end('HTTP/1.1 502 Refused\r\n\r\n');
      return;
    }
    const upstream = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
  });
  const port = await listen(proxy, '127.0.0.1');
  t.after(() => proxy.close());
  return { url: `http://127.0.0.1:${port}`, connects };
}

async function startOrigin(t, host, handler = (req, res) => res.end('direct')) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); handler(req, res); });
  const port = await listen(server, host);
  t.after(() => server.close());
  return { port, hits };
}

function appFetch(proxyUrl, noProxy = '') {
  const route = outboundRouteForSettings({ proxyUrl, noProxy }, {});
  return (url) => createOutboundFetch(route.env, route.deps)(url, { signal: AbortSignal.timeout(3000) });
}

test('the override ignores the shell proxy env, NO_PROXY included', async (t) => {
  t.after(resetOutboundFetchCache);
  const proxy = await startProxy(t);
  const saved = {};
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
    saved[key] = process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, {
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '*', no_proxy: '*'
  });

  await assert.rejects(appFetch(proxy.url)('http://public.invalid/'));
  assert.deepEqual(proxy.connects, ['public.invalid:80']);
});

test('loopback stays direct with an empty bypass list, IPv4 and IPv6', async (t) => {
  t.after(resetOutboundFetchCache);
  const proxy = await startProxy(t);
  const fetchFn = appFetch(proxy.url);
  const v4 = await startOrigin(t, '127.0.0.1');
  assert.equal(await (await fetchFn(`http://127.0.0.1:${v4.port}/`)).text(), 'direct');
  assert.equal(await (await fetchFn(`http://localhost:${v4.port}/`)).text(), 'direct');
  let v6;
  try {
    v6 = await startOrigin(t, '::1');
  } catch (error) {
    t.diagnostic(`IPv6 loopback unavailable: ${error.code}`);
  }
  if (v6) assert.equal(await (await fetchFn(`http://[::1]:${v6.port}/`)).text(), 'direct');
  assert.deepEqual(proxy.connects, []);
});

test('a bypass entry and a wildcard keep their hosts off the proxy', async (t) => {
  t.after(resetOutboundFetchCache);
  const proxy = await startProxy(t);
  await assert.rejects(appFetch(proxy.url, 'bypassed.invalid')('http://api.bypassed.invalid/'));
  await assert.rejects(appFetch(proxy.url, 'example.com, *')('http://anything.invalid/'));
  assert.deepEqual(proxy.connects, []);
  await assert.rejects(appFetch(proxy.url, 'bypassed.invalid')('http://other.invalid/'));
  assert.deepEqual(proxy.connects, ['other.invalid:80']);
});

test('a redirect from a proxied host to loopback goes direct on the next hop', async (t) => {
  t.after(resetOutboundFetchCache);
  const final = await startOrigin(t, '127.0.0.1', (req, res) => res.end('final'));
  const start = await startOrigin(t, '127.0.0.1', (req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${final.port}/after` }).end();
  });
  const proxy = await startProxy(t, { 'start.invalid:80': start.port });
  assert.equal(await (await appFetch(proxy.url)('http://start.invalid/')).text(), 'final');
  assert.deepEqual(proxy.connects, ['start.invalid:80']);
  assert.deepEqual(final.hits, ['/after']);
});

test('a redirect from loopback to a public host goes through the proxy', async (t) => {
  t.after(resetOutboundFetchCache);
  const start = await startOrigin(t, '127.0.0.1', (req, res) => {
    res.writeHead(302, { location: 'http://after.invalid/next' }).end();
  });
  const proxy = await startProxy(t);
  await assert.rejects(appFetch(proxy.url)(`http://127.0.0.1:${start.port}/`));
  assert.deepEqual(start.hits, ['/']);
  assert.deepEqual(proxy.connects, ['after.invalid:80']);
});

test('an invalid proxy setting fails closed except for local hosts', async (t) => {
  t.after(resetOutboundFetchCache);
  const origin = await startOrigin(t, '127.0.0.1');
  const fetchFn = appFetch('socks5://127.0.0.1:7897');
  await assert.rejects(fetchFn('http://public.invalid/'));
  assert.equal(await (await fetchFn(`http://127.0.0.1:${origin.port}/`)).text(), 'direct');
});

// Switching between the setting and the env-only mode must keep the env-only
// behavior exactly: there an env proxy still carries loopback unless NO_PROXY
// says otherwise, as it always has.
test('switching between the app override and env-only routing keeps each mode intact', async (t) => {
  t.after(resetOutboundFetchCache);
  const origin = await startOrigin(t, '127.0.0.1');
  const proxy = await startProxy(t);
  const netCalls = [];
  let route;
  const fetchFn = createElectronLimitsFetch({
    net: { fetch: async (url) => { netCalls.push(url); return new Response('chromium'); } },
    getRoute: () => route
  });
  const target = `http://127.0.0.1:${origin.port}/`;

  route = outboundRouteForSettings({ proxyUrl: proxy.url }, { http_proxy: 'http://127.0.0.1:9' });
  assert.equal(await (await fetchFn(target)).text(), 'direct');
  assert.deepEqual(proxy.connects, []);

  route = outboundRouteForSettings({}, { http_proxy: proxy.url });
  await assert.rejects(fetchFn(target, { signal: AbortSignal.timeout(3000) }));
  assert.deepEqual(proxy.connects, [`127.0.0.1:${origin.port}`]);

  route = outboundRouteForSettings({}, {});
  assert.equal(await (await fetchFn(target)).text(), 'chromium');
  assert.deepEqual(netCalls, [target]);
});
