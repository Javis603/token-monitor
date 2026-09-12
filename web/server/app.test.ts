import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { createServer, get, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGateway, waitForDrainOrClose } from './app.js';
import { closeGateway } from './shutdown.js';
import type { GatewayConfig } from './config.js';

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return address.port;
}

async function close(server: Server | undefined) {
  if (!server?.listening) return;
  server.close();
  await once(server, 'close');
}

describe('gateway', () => {
  let upstream: Server;
  let gateway: Server;
  let upstreamRequest: IncomingMessage | undefined;
  let upstreamHits = 0;
  let root = '';
  let baseUrl = '';
  let config: GatewayConfig;

  async function restartGateway(overrides: Partial<GatewayConfig> = {}) {
    await close(gateway);
    config = { ...config, ...overrides };
    gateway = createGateway({ config, distDir: root, logger: { error() {} } });
    const gatewayPort = await listen(gateway);
    baseUrl = `http://127.0.0.1:${gatewayPort}`;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tm-web-gateway-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Dashboard</title>');
    await writeFile(join(root, 'assets', 'app-abc123.js'), 'console.log("asset")');

    upstream = createServer((request, response) => {
      upstreamHits += 1;
      upstreamRequest = request;
      if (request.url === '/api/stats/stream') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          'access-control-allow-origin': '*'
        });
        response.end('event: snapshot\ndata: {"stats":{"devices":[]}}\n\n');
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*'
      });
      response.end(JSON.stringify({ ok: true, path: request.url }));
    });
    const upstreamPort = await listen(upstream);
    config = {
      hubUrl: `http://127.0.0.1:${upstreamPort}`,
      host: '127.0.0.1',
      authMode: 'local',
      port: 0,
      secret: 'server-only-test-secret',
      trustOidcProxy: false,
      sessionSecret: 'test-session-secret'
    };
    gateway = createGateway({ config, distDir: root, logger: { error() {} } });
    const gatewayPort = await listen(gateway);
    baseUrl = `http://127.0.0.1:${gatewayPort}`;
  });

  afterEach(async () => {
    await close(gateway);
    await close(upstream);
    await rm(root, { recursive: true, force: true });
  });

  it('accepts a valid Bearer and injects only the server secret upstream', async () => {
    const response = await fetch(`${baseUrl}/api/stats`, {
      headers: {
        authorization: 'Bearer server-only-test-secret',
        cookie: 'session=browser',
        'x-token-monitor-secret': 'browser-secret',
        'proxy-authorization': 'Basic browser'
      }
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path: '/api/stats' });
    expect(upstreamRequest?.headers.authorization).toBe('Bearer server-only-test-secret');
    expect(upstreamRequest?.headers.cookie).toBeUndefined();
    expect(upstreamRequest?.headers['x-token-monitor-secret']).toBeUndefined();
    expect(upstreamRequest?.headers['proxy-authorization']).toBeUndefined();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('rejects missing and invalid Bearer credentials without reaching upstream', async () => {
    await restartGateway({authMode:'proxy',trustOidcProxy:false});
    const hits = upstreamHits;
    const missing = await fetch(`${baseUrl}/api/stats`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'unauthorized' });

    const invalid = await fetch(`${baseUrl}/api/stats`, {
      headers: { authorization: 'Bearer invalid-test-secret' }
    });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: 'unauthorized' });
    expect(upstreamHits).toBe(hits);
  });

  it('accepts x-forwarded-user only when trusted-proxy auth is enabled', async () => {
    await restartGateway({authMode:'proxy',trustOidcProxy:false});
    const untrusted = await fetch(`${baseUrl}/api/stats`, {
      headers: { 'x-forwarded-user': 'test-user' }
    });
    expect(untrusted.status).toBe(401);

    await restartGateway({ trustOidcProxy: true });
    const trusted = await fetch(`${baseUrl}/api/stats`, {
      headers: { 'x-forwarded-user': 'test-user' }
    });
    expect(trusted.status).toBe(200);
    expect(upstreamRequest?.headers.authorization).toBe('Bearer server-only-test-secret');
    expect(upstreamRequest?.headers['x-forwarded-user']).toBeUndefined();
  });

  it('does not fall back to proxy identity when an invalid Authorization header is present', async () => {
    await restartGateway({ trustOidcProxy: true });
    const hits = upstreamHits;
    const response = await fetch(`${baseUrl}/api/stats`, {
      headers: {
        authorization: 'Bearer invalid-test-secret',
        'x-forwarded-user': 'test-user'
      }
    });
    expect(response.status).toBe(401);
    expect(upstreamHits).toBe(hits);
  });

  it('implements downstream HEAD using an upstream GET for the GET-only Hub', async () => {
    const response = await fetch(`${baseUrl}/api/stats`, {
      method: 'HEAD', headers: { authorization: 'Bearer server-only-test-secret' }
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(upstreamRequest?.method).toBe('GET');
  });

  it('streams SSE with non-buffering cache headers', async () => {
    const response = await fetch(`${baseUrl}/api/stats/stream`, {
      headers: { authorization: 'Bearer server-only-test-secret' }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(await response.text()).toContain('event: snapshot');
  });

  it.each(['browser disconnect', 'server shutdown'])('cancels the upstream SSE request on %s', async (reason) => {
    await close(upstream);
    let resolveClosed: (() => void) | undefined;
    const upstreamClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    upstream = createServer((request, response) => {
      response.once('close', () => resolveClosed?.());
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: snapshot\ndata: {"stats":{"periods":{},"devices":[]}}\n\n');
    });
    const upstreamPort = await listen(upstream);
    await close(gateway);
    gateway = createGateway({
      config: {
        hubUrl: `http://127.0.0.1:${upstreamPort}`,
        host: '127.0.0.1',
      authMode: 'local', port: 0, secret: 'server-only-test-secret', trustOidcProxy: false,
        sessionSecret: 'test-session-secret'
      },
      distDir: root,
      logger: { error() {} }
    });
    const gatewayPort = await listen(gateway);
    baseUrl = `http://127.0.0.1:${gatewayPort}`;

    const response = await fetch(`${baseUrl}/api/stats/stream`, {
      headers: { authorization: 'Bearer server-only-test-secret' }
    });
    const reader = response.body?.getReader();
    await reader?.read();
    if (reason === 'server shutdown') await closeGateway(gateway);
    else await reader?.cancel();

    await expect(Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream remained open')), 500))
    ])).resolves.toBeUndefined();
  });

  it('removes both backpressure listeners after either event settles', async () => {
    const writable = new EventEmitter() as EventEmitter & { destroyed: boolean };
    writable.destroyed = false;
    const settled = waitForDrainOrClose(writable);
    expect(writable.listenerCount('drain')).toBe(1);
    expect(writable.listenerCount('close')).toBe(1);
    writable.emit('drain');
    await settled;
    expect(writable.listenerCount('drain')).toBe(0);
    expect(writable.listenerCount('close')).toBe(0);
  });

  it('rejects writes and API paths outside the exact allowlist', async () => {
    const hits = upstreamHits;
    const write = await fetch(`${baseUrl}/api/stats`, {
      method: 'POST', headers: { authorization: 'Bearer server-only-test-secret' }
    });
    expect(write.status).toBe(405);
    expect(write.headers.get('allow')).toBe('GET, HEAD');
    expect((await write.json()).error).toBe('method_not_allowed');

    const ingest = await fetch(`${baseUrl}/api/ingest`, {
      method: 'POST', headers: { authorization: 'Bearer server-only-test-secret' }
    });
    expect(ingest.status).toBe(404);
    expect((await ingest.json()).error).toBe('not_found');
    expect(upstreamHits).toBe(hits);
  });

  it('proxies every read-only Hub route (devices, history, subscriptions)', async () => {
    for (const path of ['/api/devices', '/api/history', '/api/subscriptions']) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { authorization: 'Bearer server-only-test-secret' }
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ path });
    }
    expect(upstreamRequest?.headers.authorization).toBe('Bearer server-only-test-secret');
  });

  it('rejects mutation of subscriptions and device deletion', async () => {
    const hits = upstreamHits;
    const put = await fetch(`${baseUrl}/api/subscriptions`, {
      method: 'PUT', headers: { authorization: 'Bearer server-only-test-secret' }
    });
    expect(put.status).toBe(405);
    const del = await fetch(`${baseUrl}/api/devices/some-device`, {
      method: 'DELETE', headers: { authorization: 'Bearer server-only-test-secret' }
    });
    expect(del.status).toBe(404);
    expect(upstreamHits).toBe(hits);
  });

  it('mints an /api-scoped session cookie only on SPA shell responses', async () => {
    const page = await fetch(`${baseUrl}/overview`);
    expect(page.status).toBe(200);
    const setCookie = page.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('tm_web_session=');
    expect(setCookie).toContain('Path=/;');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain('; Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain(`Max-Age=${8 * 60 * 60}`);

    const asset = await fetch(`${baseUrl}/assets/app-abc123.js`);
    expect(asset.headers.get('set-cookie')).toBeNull();

    const missing = await fetch(`${baseUrl}/missing.js`);
    expect(missing.headers.get('set-cookie')).toBeNull();
  });

  it('accepts a gateway session cookie for read-only API access', async () => {
    const page = await fetch(`${baseUrl}/`);
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
    const response = await fetch(`${baseUrl}/api/stats`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path: '/api/stats' });
    expect(upstreamRequest?.headers.authorization).toBe('Bearer server-only-test-secret');
    expect(upstreamRequest?.headers.cookie).toBeUndefined();
  });

  it('rejects tampered and pre-restart session cookies', async () => {
    await restartGateway({authMode:'proxy',trustOidcProxy:true});
    const page = await fetch(`${baseUrl}/`, { headers: { 'x-forwarded-user': 'test-user' } });
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
    const [name, value] = cookie.split('=');
    expect((await fetch(`${baseUrl}/api/stats`, { headers: { cookie } })).status).toBe(200);
    const tampered = `${name}=${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
    expect((await fetch(`${baseUrl}/api/stats`, { headers: { cookie: tampered } })).status).toBe(401);

    await restartGateway();
    expect((await fetch(`${baseUrl}/api/stats`, { headers: { cookie } })).status).toBe(401);
  });

  it('does not let an invalid Bearer fall back to a valid session cookie', async () => {
    const page = await fetch(`${baseUrl}/`);
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
    const hits = upstreamHits;
    const response = await fetch(`${baseUrl}/api/stats`, {
      headers: { authorization: 'Bearer invalid-test-secret', cookie }
    });
    expect(response.status).toBe(401);
    expect(upstreamHits).toBe(hits);
  });

  it('requires proxy identity on the shell and never issues anonymous cookies', async()=>{
    await restartGateway({authMode:'proxy',trustOidcProxy:true});
    const anonymous=await fetch(baseUrl+'/');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('set-cookie')).toBeNull();
    const loggedIn=await fetch(baseUrl+'/',{headers:{'x-forwarded-user':'demo-user'}});
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.headers.get('set-cookie')).toContain('; Secure');
    const cookie=loggedIn.headers.get('set-cookie')!.split(';')[0];
    expect((await fetch(baseUrl+'/api/stats',{headers:{cookie}})).status).toBe(200);
  });

  it('external proxy public assets and SPA fallbacks never mint browser sessions', async()=>{
    await restartGateway({authMode:'trusted-proxy',proxyMode:'external',publicOrigin:baseUrl});
    config.publicOrigin=baseUrl;
    for(const path of ['/assets/app-abc123.js','/assets/anonymous','/icons/anonymous','/overview','/%69ndex.html']) {
      const response=await fetch(baseUrl+path);
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie(),path).toEqual([]);
    }
    expect((await fetch(baseUrl+'/api/stats')).status).toBe(401);
    for(const path of ['/','/index.html?view=snapshot']) {
      const page=await fetch(baseUrl+path);
      expect(page.status).toBe(200);
      const cookie=page.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
      expect(cookie).toContain('tm_web_session=');
      expect((await fetch(baseUrl+'/api/stats',{headers:{cookie}})).status).toBe(200);
    }
  });

  it('revokes an open browser SSE connection when logging out', async()=>{
    await restartGateway({authMode:'trusted-proxy',proxyMode:'external',publicOrigin:baseUrl});
    // Restart changes the ephemeral test port; config is shared by the server.
    config.publicOrigin=baseUrl;
    await close(upstream);
    upstream=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: snapshot\ndata: {}\n\n');});
    const upstreamPort=await listen(upstream);config.hubUrl=`http://127.0.0.1:${upstreamPort}`;
    const page=await fetch(baseUrl);const cookie=page.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
    const stream=await fetch(baseUrl+'/api/stats/stream',{headers:{cookie}});const reader=stream.body!.getReader();await reader.read();
    const closed=reader.read().then(()=>true,()=>true);
    const logout=await fetch(baseUrl+'/auth/logout',{method:'POST',headers:{cookie,origin:baseUrl}});
    expect(logout.status).toBe(200);
    await expect(Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('SSE stayed open')),1000))])).resolves.toBe(true);
    expect((await fetch(baseUrl+'/api/stats',{headers:{cookie}})).status).toBe(401);
  });

  it('blocks DNS rebinding and cross-site reads in local mode',async()=>{
    const rebound = await new Promise<number|undefined>(resolve=>{get(baseUrl+'/',{headers:{host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);});});
    expect(rebound).toBe(403);
    expect((await fetch(baseUrl+'/api/stats',{headers:{origin:'https://attacker.example'}})).status).toBe(403);
    expect((await fetch(baseUrl+'/api/stats',{headers:{'sec-fetch-site':'cross-site'}})).status).toBe(403);
    expect((await fetch(baseUrl+'/api/stats')).status).toBe(200);
  });

  it('rejects static symlinks escaping the asset root', async () => {
    await symlink(join(root, '..'), join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    const response = await fetch(`${baseUrl}/outside/${root.split(/[\\/]/).pop()}/index.html`);
    // The target resolves back into root and is safe.
    expect(response.status).toBe(200);
    await writeFile(join(root, '..', `${root.split(/[\\/]/).pop()}.txt`), 'synthetic outside file');
    try {
      const outside = await fetch(`${baseUrl}/outside/${root.split(/[\\/]/).pop()}.txt`);
      expect(outside.status).toBe(404);
      expect(await outside.text()).not.toContain('synthetic outside file');
    } finally { await rm(join(root, '..', `${root.split(/[\\/]/).pop()}.txt`)); }
  });

  it('checks the full configured origin, including scheme', async () => {
    config.publicOrigin = baseUrl;
    expect((await fetch(`${baseUrl}/api/stats`, { headers: { origin: baseUrl } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/stats`, { headers: { origin: baseUrl.replace('http:', 'https:') } })).status).toBe(403);
  });

  it('closes an unread upstream body after a HEAD response', async () => {
    await close(upstream);
    let markClosed: () => void = () => {};
    const closed = new Promise<void>(resolve => { markClosed = resolve; });
    upstream = createServer((_request, response) => {
      response.once('close', markClosed);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
    });
    config.hubUrl = `http://127.0.0.1:${await listen(upstream)}`;
    const response = await fetch(`${baseUrl}/api/stats`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    await expect(Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream remained open')), 500))])).resolves.toBeUndefined();
  });

  it('serves static assets and falls back to the SPA without caching index', async () => {
    const page = await fetch(`${baseUrl}/overview`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Dashboard');
    expect(page.headers.get('cache-control')).toBe('no-cache');

    const asset = await fetch(`${baseUrl}/assets/app-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const traversal = await fetch(`${baseUrl}/..%2Fsecret.txt`);
    expect(traversal.status).toBe(404);
    const missingFile = await fetch(`${baseUrl}/missing.js`);
    expect(missingFile.status).toBe(404);
  });
});
