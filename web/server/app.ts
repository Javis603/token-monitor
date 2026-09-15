import { Readable } from 'node:stream';
import { createAuth, localRequest, sameOrigin } from './auth.js';
import { readFile, stat, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type { GatewayConfig } from './config.js';

interface Logger {
  error(message: string): void;
}

interface GatewayOptions {
  config: GatewayConfig;
  distDir: string;
  logger?: Logger;
}

// Read-only allowlist mirroring every public GET route on the Hub
// (src/hub/server.js). Write routes (ingest, subscriptions PUT/DELETE,
// device DELETE) are never proxied with browser credentials. The optional
// client channel below uses only the caller's explicit Hub Bearer.
const API_METHODS = new Map([
  ['/api/health', new Set(['GET', 'HEAD'])],
  ['/api/stats', new Set(['GET', 'HEAD'])],
  ['/api/devices', new Set(['GET', 'HEAD'])],
  ['/api/history', new Set(['GET', 'HEAD'])],
  ['/api/subscriptions', new Set(['GET', 'HEAD'])],
  ['/api/stats/stream', new Set(['GET'])]
]);

// Exact Hub operations, not an unrestricted reverse proxy. Hub owns token
// validation, payload limits, subscription conflicts and device mutations.
function clientMethods(pathname: string): Set<string> | undefined {
  if (pathname === '/api/ingest') return new Set(['POST']);
  if (pathname === '/api/subscriptions') return new Set(['GET', 'HEAD', 'PUT']);
  if (/^\/api\/devices\/[^/]+$/.test(pathname)) return new Set(['DELETE']);
  return API_METHODS.get(pathname);
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2'
};

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
};

export function waitForDrainOrClose(response: {
  once(event: 'drain' | 'close', listener: () => void): unknown;
  off(event: 'drain' | 'close', listener: () => void): unknown;
}): Promise<void> {
  return new Promise((resolveWait) => {
    function settle() {
      response.off('drain', settle);
      response.off('close', settle);
      resolveWait();
    }
    response.once('drain', settle);
    response.once('close', settle);
  });
}

function setSecurityHeaders(response: ServerResponse) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
}

function sendJson(request: IncomingMessage, response: ServerResponse, status: number, body: object, headers: Record<string, string> = {}) {
  setSecurityHeaders(response);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body));
}

function safeRequestPath(rawUrl: string | undefined): URL | null {
  try {
    return new URL(rawUrl ?? '/', 'http://gateway.invalid');
  } catch {
    return null;
  }
}

function copyUpstreamHeaders(upstream: Response, response: ServerResponse, sse: boolean) {
  const omitted = new Set([
    'set-cookie',
    'access-control-allow-origin',
    'connection',
    'content-encoding',
    'content-length',
    'keep-alive',
    'transfer-encoding'
  ]);
  for (const [name, value] of upstream.headers) {
    if (!omitted.has(name.toLowerCase())) response.setHeader(name, value);
  }
  response.setHeader('cache-control', sse ? 'no-cache, no-transform' : 'no-store');
  if (sse) response.setHeader('x-accel-buffering', 'no');
  setSecurityHeaders(response);
}

async function proxyApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  config: GatewayConfig,
  clientAuthorization?: string
) {
  const abort = new AbortController();
  request.once('aborted', () => abort.abort());
  response.once('close', () => abort.abort());
  const headers = new Headers();
  for (const name of ['accept', 'accept-language', 'last-event-id', 'user-agent']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  headers.set('authorization', clientAuthorization ?? `Bearer ${config.secret}`);
  if (clientAuthorization) {
    for (const name of ['content-type', 'content-encoding']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.hubUrl}${url.pathname}${url.search}`, {
      method: request.method === 'HEAD' ? 'GET' : request.method,
      headers,
      redirect: 'manual',
      signal: abort.signal,
      ...(clientAuthorization && ['POST', 'PUT'].includes(request.method || '')
        ? { body: Readable.toWeb(request) as ReadableStream<Uint8Array>, duplex: 'half' }
        : {})
    });
  } catch (error) {
    if (!response.headersSent && !response.destroyed) sendJson(request, response, 502, { error: 'hub_unavailable' });
    return;
  }

  const isSse = url.pathname === '/api/stats/stream';
  copyUpstreamHeaders(upstream, response, isSse);
  response.writeHead(upstream.status);
  if (request.method === 'HEAD' || !upstream.body) {
    response.end();
    return;
  }

  const reader = upstream.body.getReader();
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      if (response.destroyed) break;
      if (!response.write(Buffer.from(value))) {
        await waitForDrainOrClose(response);
        if (response.destroyed) break;
      }
    }
    if (!response.destroyed) response.end();
  } catch {
    response.destroy();
  } finally {
    if (!complete) {
      try { await reader.cancel(); } catch { /* the abort may already have closed it */ }
    }
    reader.releaseLock();
  }
}

function cacheHeader(pathname: string): string {
  if (/^\/assets\/.+-[A-Za-z0-9_-]{6,}\.[^.]+$/.test(pathname)) {
    return 'public, max-age=31536000, immutable';
  }
  return pathname === '/' || pathname.endsWith('.html') ? 'no-cache' : 'public, max-age=3600';
}

async function serveStatic(request: IncomingMessage, response: ServerResponse, url: URL, distDir: string, onIndex: () => void) {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) {
    sendJson(request, response, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(request, response, 400, { error: 'bad_request' });
    return;
  }
  if (pathname.includes('\0')) {
    sendJson(request, response, 404, { error: 'not_found' });
    return;
  }

  const root = resolve(distDir);
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  let filePath = resolve(root, requested);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    sendJson(request, response, 404, { error: 'not_found' });
    return;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    fileStat = null;
  }
  if (!fileStat?.isFile()) {
    if (extname(pathname)) {
      sendJson(request, response, 404, { error: 'not_found' });
      return;
    }
    filePath = resolve(root, 'index.html');
    try {
      fileStat = await stat(filePath);
    } catch {
      fileStat = null;
    }
  }
  if (!fileStat?.isFile()) {
    sendJson(request, response, 404, { error: 'not_found' });
    return;
  }

  // Check canonical paths after the SPA fallback, including symlinked roots.
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(filePath);
  if (!canonicalFile.startsWith(`${canonicalRoot}${sep}`)) {
    sendJson(request, response, 404, { error: 'not_found' });
    return;
  }

  const body = await readFile(canonicalFile);
  const isIndex = filePath === resolve(root, 'index.html');
  if(isIndex && request.method==='GET')onIndex();
  setSecurityHeaders(response);

  response.writeHead(200, {
    'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(body.byteLength),
    'cache-control': cacheHeader(isIndex ? '/index.html' : pathname)
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

export function createGateway({ config, distDir, logger = console }: GatewayOptions) {
  const auth=createAuth(config);
  return createServer((request, response) => {
    setSecurityHeaders(response);
    const url = safeRequestPath(request.url);
    if (!url) {
      sendJson(request, response, 400, { error: 'bad_request' });
      return;
    }

    if(config.publicOrigin && request.headers.host!==new URL(config.publicOrigin).host){sendJson(request,response,403,{error:'invalid_host'});return;}

    // Reject cross-site browser reads before cookies can authorize a request.
    const origin=request.headers.origin;
    if ((url.pathname.startsWith('/api/') || url.pathname==='/auth/logout') && ((origin && !sameOrigin(request, config))
      || request.headers['sec-fetch-site'] === 'cross-site')) {
      sendJson(request,response,403,{error:'cross_site_request'}); return;
    }
    if (config.authMode === 'local' && !localRequest(request)) {
      sendJson(request,response,403,{error:'local_only'}); return;
    }
    const operation=(async()=>{
      const authorization = request.headers.authorization;
      if (config.allowHubClients && url.pathname.startsWith('/api/')
        && authorization && /^Bearer(?:\s|$)/i.test(authorization)) {
        // An explicit client credential never falls back to a browser session
        // or the Web server's more privileged upstream credential.
        if (!/^Bearer [^\s]+$/i.test(authorization)) {
          sendJson(request,response,401,{error:'unauthorized'}); return;
        }
        const allowed = clientMethods(url.pathname);
        if (!allowed) { sendJson(request,response,404,{error:'not_found'}); return; }
        if (!allowed.has(request.method || '')) {
          sendJson(request,response,405,{error:'method_not_allowed'},{allow:[...allowed].join(', ')}); return;
        }
        await proxyApi(request,response,url,config,authorization);
        return;
      }
      if(await auth.handle(request,response,url))return;
      if(url.pathname.startsWith('/auth/')){sendJson(request,response,404,{error:'not_found'});return;}
      const shell=!url.pathname.startsWith('/api/');
      if(!auth.authorized(request,shell)){auth.deny(request,response,shell);return;}
      if(!shell) {
        const allowed=API_METHODS.get(url.pathname);
        if(!allowed){sendJson(request,response,404,{error:'not_found'});return;}
        if(!allowed.has(request.method || '')){sendJson(request,response,405,{error:'method_not_allowed'},{allow:[...allowed].join(', ')});return;}
        if(url.pathname==='/api/stats/stream')auth.bindStream(request,response);
        await proxyApi(request,response,url,config);
      } else {
        await serveStatic(request,response,url,distDir,()=>auth.issue(request,response));
      }
    })();

    operation.catch((error: unknown) => {
      logger.error('gateway request failed');
      if (!response.headersSent) sendJson(request, response, 500, { error: 'internal_error' });
      else response.destroy();
    });
  });
}
