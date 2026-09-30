'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');

const {
  createMimoExchangeFetch,
  parseProxyResolveResults
} = require('../../src/electron/providers/mimo/exchangeFetch');

test('a PAC result preserves supported routes and their fallback order', () => {
  assert.deepEqual(parseProxyResolveResults('DIRECT'), [{ kind: 'direct', proxyUrl: '' }]);
  assert.deepEqual(parseProxyResolveResults('PROXY 127.0.0.1:7890'), [{ kind: 'http', proxyUrl: 'http://127.0.0.1:7890' }]);
  assert.deepEqual(parseProxyResolveResults('PROXY 127.0.0.1:7890; DIRECT'), [
    { kind: 'http', proxyUrl: 'http://127.0.0.1:7890' },
    { kind: 'direct', proxyUrl: '' }
  ]);
  assert.deepEqual(parseProxyResolveResults(''), [{ kind: 'direct', proxyUrl: '' }]);
  assert.deepEqual(parseProxyResolveResults('SOCKS5 127.0.0.1:1080'), [{ kind: 'unsupported', proxyUrl: '' }]);
  // TLS to the proxy is a different scheme, not a different host.
  assert.deepEqual(parseProxyResolveResults('HTTPS proxy.example:8443'), [{ kind: 'http', proxyUrl: 'https://proxy.example:8443' }]);
  assert.deepEqual(parseProxyResolveResults('HTTP proxy.example:8080'), [{ kind: 'http', proxyUrl: 'http://proxy.example:8080' }]);
});

// Empty env keeps system-proxy tests independent of the runner's proxy variables.
test('a direct resolution reaches the origin without a dispatcher', async () => {
  const seen = [];
  const fetch = createMimoExchangeFetch({
    env: {},
    session: { resolveProxy: async () => 'DIRECT' },
    fetch: async (url, init) => { seen.push(init); return { status: 200 }; }
  });
  await fetch('https://platform.xiaomimimo.com/api/v1/balance', { redirect: 'manual' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].dispatcher, undefined);
  assert.equal(seen[0].redirect, 'manual', 'the walk’s own request options survive');
});

test('an explicit proxy environment wins before Chromium proxy resolution', async () => {
  let resolutions = 0;
  const seen = [];
  const fetch = createMimoExchangeFetch({
    session: { resolveProxy: async () => { resolutions += 1; return 'DIRECT'; } },
    env: { HTTPS_PROXY: 'http://env-proxy.example:8080' },
    envFetch: async (url, init) => { seen.push({ url, init }); return { status: 200 }; }
  });
  await fetch('https://platform.xiaomimimo.com/api/v1/balance', { redirect: 'manual' });
  assert.equal(resolutions, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.redirect, 'manual');
});

test('a resolved proxy becomes a dispatcher on the request', async () => {
  const seen = [];
  const fetch = createMimoExchangeFetch({
    env: {},
    session: { resolveProxy: async () => 'PROXY 127.0.0.1:7890' },
    fetch: async (url, init) => { seen.push(init); return { status: 200 }; }
  });
  await fetch('https://mimo-server-cn.xiaomimimo.com/api/user/xiaomi/me', {});
  assert.equal(seen[0].dispatcher?.constructor?.name, 'ProxyAgent');
});

test('a proxy undici cannot speak fails closed instead of going direct', async () => {
  let fetched = false;
  const fetch = createMimoExchangeFetch({
    env: {},
    session: { resolveProxy: async () => 'SOCKS5 127.0.0.1:1080' },
    fetch: async () => { fetched = true; return { status: 200 }; }
  });
  await assert.rejects(fetch('https://platform.xiaomimimo.com/api/v1/balance', {}), /cannot use the resolved proxy/u);
  assert.equal(fetched, false, 'a configured proxy is never silently skipped');
});

test('a failed PAC proxy advances to Chromium’s direct fallback', async () => {
  const attempts = [];
  const fetch = createMimoExchangeFetch({
    env: {},
    session: { resolveProxy: async () => 'PROXY 127.0.0.1:1; DIRECT' },
    fetch: async (url, init) => {
      attempts.push(Boolean(init.dispatcher));
      if (init.dispatcher) throw new Error('proxy unavailable');
      return { status: 200 };
    }
  });
  assert.equal((await fetch('https://platform.xiaomimimo.com/api/v1/balance', {})).status, 200);
  assert.deepEqual(attempts, [true, false]);
});

// Verify routing through a real CONNECT tunnel, beyond the dispatcher type.
function startConnectProxy() {
  const tunnels = [];
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      const request = chunk.toString('utf8');
      const match = /^CONNECT\s+([^\s]+)\s+HTTP\/1\.1/u.exec(request);
      if (!match) {
        socket.destroy();
        return;
      }
      tunnels.push(match[1]);
      const [host, port] = match[1].split(':');
      const upstream = net.connect(Number(port), host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(chunk.slice(request.indexOf('\r\n\r\n') + 4));
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
    });
    socket.on('error', () => {});
  });
  return { server, tunnels };
}

test('a request resolved to a proxy really travels through it', async () => {
  const origin = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 0, path: request.url }));
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const proxy = startConnectProxy();
  await new Promise((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));

  const originPort = origin.address().port;
  const proxyPort = proxy.server.address().port;
  const fetch = createMimoExchangeFetch({
    env: {},
    session: { resolveProxy: async (url) => (String(url).includes(`:${originPort}`) ? `PROXY 127.0.0.1:${proxyPort}` : 'DIRECT') }
  });
  try {
    const response = await fetch(`http://127.0.0.1:${originPort}/api/user/xiaomi/me`, { redirect: 'manual' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.path, '/api/user/xiaomi/me', 'the request arrived at the origin through the tunnel');
    assert.deepEqual(proxy.tunnels, [`127.0.0.1:${originPort}`]);
  } finally {
    origin.close();
    proxy.server.close();
  }
});
