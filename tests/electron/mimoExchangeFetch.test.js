'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');

const {
  createMimoExchangeFetch,
  parseProxyResolveResult
} = require('../../src/electron/providers/mimo/exchangeFetch');

test('a PAC result is read as the proxy Chromium resolved, or as nothing at all', () => {
  assert.deepEqual(parseProxyResolveResult('DIRECT'), { kind: 'direct', proxyUrl: '' });
  assert.deepEqual(parseProxyResolveResult('PROXY 127.0.0.1:7890'), { kind: 'http', proxyUrl: 'http://127.0.0.1:7890' });
  // Chromium lists its fallbacks after the first entry; only the first is taken.
  assert.deepEqual(parseProxyResolveResult('PROXY 127.0.0.1:7890; DIRECT'), { kind: 'http', proxyUrl: 'http://127.0.0.1:7890' });
  assert.deepEqual(parseProxyResolveResult(''), { kind: 'direct', proxyUrl: '' });
  assert.equal(parseProxyResolveResult('SOCKS5 127.0.0.1:1080').kind, 'unsupported');
});

test('a direct resolution reaches the origin without a dispatcher', async () => {
  const seen = [];
  const fetch = createMimoExchangeFetch({
    session: { resolveProxy: async () => 'DIRECT' },
    fetch: async (url, init) => { seen.push(init); return { status: 200 }; }
  });
  await fetch('https://platform.xiaomimimo.com/api/v1/balance', { redirect: 'manual' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].dispatcher, undefined);
  assert.equal(seen[0].redirect, 'manual', 'the walk’s own request options survive');
});

test('a resolved proxy becomes a dispatcher on the request', async () => {
  const seen = [];
  const fetch = createMimoExchangeFetch({
    session: { resolveProxy: async () => 'PROXY 127.0.0.1:7890' },
    fetch: async (url, init) => { seen.push(init); return { status: 200 }; }
  });
  await fetch('https://mimo-server-cn.xiaomimimo.com/api/user/xiaomi/me', {});
  assert.equal(seen[0].dispatcher?.constructor?.name, 'ProxyAgent');
});

test('a proxy undici cannot speak fails closed instead of going direct', async () => {
  let fetched = false;
  const fetch = createMimoExchangeFetch({
    session: { resolveProxy: async () => 'SOCKS5 127.0.0.1:1080' },
    fetch: async () => { fetched = true; return { status: 200 }; }
  });
  await assert.rejects(fetch('https://platform.xiaomimimo.com/api/v1/balance', {}), /cannot use the resolved proxy/u);
  assert.equal(fetched, false, 'a configured proxy is never silently skipped');
});

// A CONNECT proxy in twenty lines, so the routing above is verified against a
// real tunnel rather than against a stub's constructor name.
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
