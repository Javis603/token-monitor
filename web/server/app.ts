import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
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
// device DELETE) are intentionally NOT proxied: browsers must never mutate
// production data, and headless agents post directly to the loopback Hub.
const API_METHODS = new Map([
  ['/api/health', new Set(['GET', 'HEAD'])],
  ['/api/stats', new Set(['GET', 'HEAD'])],
  ['/api/devices', new Set(['GET', 'HEAD'])],
  ['/api/history', new Set(['GET', 'HEAD'])],
  ['/api/subscriptions', new Set(['GET', 'HEAD'])],
  ['/api/stats/stream', new Set(['GET'])]
]);

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

// Sessions are issued only after local-origin or trusted-proxy authentication.
// The Hub bearer never reaches browser JavaScript or browser storage.
const SESSION_COOKIE_NAME = 'tm_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function signSessionPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

// Exported for tests: builds a complete Set-Cookie value for a session issued
// at `nowSeconds` (defaults to the current time).
export function issueSessionCookie(config: GatewayConfig, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload = `v1.${nowSeconds + SESSION_TTL_SECONDS}.${randomBytes(16).toString('hex')}`;
  const signature = signSessionPayload(payload, config.sessionSecret);
  return `${SESSION_COOKIE_NAME}=${payload}.${signature}; Path=/api; HttpOnly;${config.authMode === 'local' ? '' : ' Secure;'} SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function readSessionCookie(request: IncomingMessage): string | null {
  const cookie = request.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function sessionCookieIsValid(request: IncomingMessage, config: GatewayConfig): boolean {
  if (config.sessionSecret === '') return false;
  const value = readSessionCookie(request);
  if (!value) return false;
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return false;
  const payload = value.slice(0, separator);
  const supplied = Buffer.from(value.slice(separator + 1));
  const expected = Buffer.from(signSessionPayload(payload, config.sessionSecret));
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) return false;
  const expiry = Number(payload.split('.')[1]);
  return Number.isFinite(expiry) && expiry > Math.floor(Date.now() / 1000);
}

export function waitForDrainOrClose(response: Pick<ServerResponse, 'once' | 'off'>): Promise<void> {
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

function matchesSecret(token: string, secret: string): boolean {
  const supplied = Buffer.from(token);
  const expected = Buffer.from(secret);
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function isApiAuthorized(request: IncomingMessage, config: GatewayConfig): boolean {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    if (typeof authorization !== 'string') return false;
    const bearer = /^Bearer (.+)$/i.exec(authorization);
    return bearer !== null && matchesSecret(bearer[1], config.secret);
  }

  if (config.authMode === 'local') return isLocalRequest(request);

  // Headless/browser sessions minted by this gateway on the OIDC-protected SPA
  // shell (reverse proxy passes /api/* through without validating its own OIDC cookie).
  if (sessionCookieIsValid(request, config)) return true;

  const forwardedUser = request.headers['x-forwarded-user'];
  return config.trustOidcProxy
    && typeof forwardedUser === 'string'
    && forwardedUser.trim().length > 0;
}

function copyUpstreamHeaders(upstream: Response, response: ServerResponse, sse: boolean) {
  const omitted = new Set([
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
  config: GatewayConfig
) {
  const abort = new AbortController();
  request.once('aborted', () => abort.abort());
  response.once('close', () => abort.abort());
  const headers = new Headers();
  for (const name of ['accept', 'accept-language', 'last-event-id', 'user-agent']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  headers.set('authorization', `Bearer ${config.secret}`);

  let upstream: Response;
  try {
    upstream = await fetch(`${config.hubUrl}${url.pathname}${url.search}`, {
      method: request.method === 'HEAD' ? 'GET' : request.method,
      headers,
      redirect: 'manual',
      signal: abort.signal
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

async function serveStatic(request: IncomingMessage, response: ServerResponse, url: URL, distDir: string, config: GatewayConfig) {
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

  const body = await readFile(filePath);
  const isIndex = filePath === resolve(root, 'index.html');
  setSecurityHeaders(response);
  if (isIndex && config.sessionSecret !== '') {
    response.setHeader('set-cookie', issueSessionCookie(config));
  }
  response.writeHead(200, {
    'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(body.byteLength),
    'cache-control': cacheHeader(isIndex ? '/index.html' : pathname)
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function isLocalRequest(request: IncomingMessage): boolean {
  const peer=request.socket.remoteAddress || '';
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)) return false;
  try {
    const host=new URL(`http://${request.headers.host}`).hostname;
    return ['localhost','127.0.0.1','[::1]'].includes(host);
  } catch { return false; }
}

function isShellAuthorized(request: IncomingMessage, config: GatewayConfig): boolean {
  if (config.authMode === 'local') return isLocalRequest(request);
  const user=request.headers['x-forwarded-user'];
  return config.trustOidcProxy && typeof user === 'string' && user.trim().length > 0;
}

export function createGateway({ config, distDir, logger = console }: GatewayOptions) {
  return createServer((request, response) => {
    const url = safeRequestPath(request.url);
    if (!url) {
      sendJson(request, response, 400, { error: 'bad_request' });
      return;
    }

    // Reject cross-site browser reads before cookies can authorize a request.
    const origin=request.headers.origin;
    if ((origin && (()=>{try{return new URL(origin).host !== request.headers.host;}catch{return true;}})())
      || request.headers['sec-fetch-site'] === 'cross-site') {
      sendJson(request,response,403,{error:'cross_site_request'}); return;
    }
    if (config.authMode === 'local' && !isLocalRequest(request)) {
      sendJson(request,response,403,{error:'local_only'}); return;
    }
    const allowed = API_METHODS.get(url.pathname);
    let operation: Promise<void>;
    if (url.pathname.startsWith('/api/')) {
      if (!isApiAuthorized(request, config)) {
        sendJson(request, response, 401, { error: 'unauthorized' });
        return;
      }
      if (!allowed) {
        sendJson(request, response, 404, { error: 'not_found' });
        return;
      }
      if (!allowed.has(request.method ?? '')) {
        sendJson(request, response, 405, { error: 'method_not_allowed' }, { allow: [...allowed].join(', ') });
        return;
      }
      operation = proxyApi(request, response, url, config);
    } else {
      if (!isShellAuthorized(request,config)) {sendJson(request,response,401,{error:'unauthorized'});return;}
      operation = serveStatic(request, response, url, distDir, config);
    }

    operation.catch((error: unknown) => {
      logger.error('gateway request failed');
      if (!response.headersSent) sendJson(request, response, 500, { error: 'internal_error' });
      else response.destroy();
    });
  });
}
