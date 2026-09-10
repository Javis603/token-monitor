// @vitest-environment node
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

type Listener = (event: any) => void;

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

async function serviceWorkerHarness() {
  const listeners: Record<string, Listener> = {};
  const stores = new Map<string, {
    entries: Map<string, Response>;
    addAll: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    match: ReturnType<typeof vi.fn>;
  }>();
  const cacheFor = (name: string) => {
    let cache = stores.get(name);
    if (!cache) {
      const entries = new Map<string, Response>();
      cache = {
        entries,
        addAll: vi.fn(async () => undefined),
        put: vi.fn(async (key: string, response: Response) => { entries.set(String(key), response.clone()); }),
        match: vi.fn(async (key: string) => entries.get(String(key)))
      };
      stores.set(name, cache);
    }
    return cache;
  };
  const caches = {
    open: vi.fn(async (name: string) => cacheFor(name)),
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    match: vi.fn(async (key: string) => {
      for (const cache of stores.values()) {
        const found = cache.entries.get(String(key));
        if (found) return found;
      }
      return undefined;
    })
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = requestPath(input);
    if (url === '/index.html') {
      return new Response('<html><head><link href="/assets/index-def456.css"></head><body><script src="/assets/index-abc123.js"></script></body></html>');
    }
    return new Response('{}', { status: 200 });
  });
  const self = {
    location: { origin: 'https://tm-web.example.test' },
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: (type: string, listener: Listener) => { listeners[type] = listener; }
  };
  const code = await readFile('public/sw.js', 'utf8');
  vm.runInNewContext(code, { self, caches, fetch: fetcher, URL, Response, Promise, Error, JSON });
  return { listeners, stores, caches, fetcher };
}

describe('PWA assets', () => {
  it('declares a credentialed standalone manifest with theme and maskable icons', async () => {
    const manifest = JSON.parse(await readFile('public/manifest.webmanifest', 'utf8'));
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBeTruthy();
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', purpose: expect.stringContaining('maskable') }),
      expect.objectContaining({ sizes: '512x512', purpose: expect.stringContaining('maskable') })
    ]));
    const html = await readFile('index.html', 'utf8');
    expect(html).toContain('/icons/icon-192.svg');
    expect(html).toContain('crossorigin="use-credentials"');
    expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
    expect((await readFile('public/icons/apple-touch-icon.png')).subarray(1, 4).toString()).toBe('PNG');
    for (const size of [192, 512]) {
      expect(manifest.icons).toContainEqual({ src: `/icons/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' });
      const png = await readFile(`public/icons/icon-${size}.png`);
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
  });

  it('discovers and precaches Vite hashed assets during install', async () => {
    const harness = await serviceWorkerHarness();
    let pending: Promise<unknown> | undefined;
    harness.listeners.install({ waitUntil(value: Promise<unknown>) { pending = value; } });
    await pending;
    const staticCache = harness.stores.get('token-monitor-static-v22');
    expect(staticCache?.addAll).toHaveBeenCalledWith(['/assets/index-def456.css', '/assets/index-abc123.js']);
    expect(staticCache?.put).toHaveBeenCalledWith('/index.html', expect.any(Response));
  });

  it('passes authenticated API and SSE requests straight to fetch without cache access', async () => {
    const harness = await serviceWorkerHarness();
    const request = new Request('https://tm-web.example.test/api/stats/stream');
    let response: Promise<Response> | undefined;
    harness.listeners.fetch({ request, respondWith(value: Promise<Response>) { response = value; } });
    await response;
    expect(harness.fetcher).toHaveBeenCalledWith(request);
    expect(harness.caches.open).not.toHaveBeenCalled();
  });

  it('persists and serves only the explicit offline snapshot endpoint', async () => {
    const harness = await serviceWorkerHarness();
    const payload = { savedAt: '2026-08-27T09:00:00.000Z', stats: { periods: {}, devices: [] } };
    let stored: Promise<unknown> | undefined;
    harness.listeners.message({
      data: { type: 'SAVE_STATS_SNAPSHOT', payload },
      waitUntil(value: Promise<unknown>) { stored = value; }
    });
    await stored;

    const request = new Request('https://tm-web.example.test/__offline__/stats.json');
    let response: Promise<Response> | undefined;
    harness.listeners.fetch({ request, respondWith(value: Promise<Response>) { response = value; } });
    expect(await (await response)?.json()).toEqual(payload);
  });

  it('deletes the legacy raw snapshot cache during activation', async () => {
    const harness = await serviceWorkerHarness();
    await harness.caches.open('unrelated-site-assets');
    await harness.caches.open('token-monitor-snapshot-v1');
    await harness.caches.open('token-monitor-static-v2');
    await harness.caches.open('token-monitor-snapshot-v2');
    let pending: Promise<unknown> | undefined;
    harness.listeners.activate({ waitUntil(value: Promise<unknown>) { pending = value; } });
    await pending;
    expect(harness.caches.delete).toHaveBeenCalledWith('token-monitor-snapshot-v1');
    expect(harness.caches.delete).toHaveBeenCalledWith('token-monitor-static-v2');
    expect(harness.stores.has('token-monitor-snapshot-v2')).toBe(true);
    expect(harness.stores.has('unrelated-site-assets')).toBe(true);
  });
});

it.each(['match', 'open', 'put'])('serves a successful static response when cache %s fails', async failure => {
  const harness = await serviceWorkerHarness();
  if (failure === 'match') harness.caches.match.mockRejectedValue(new Error('unavailable'));
  if (failure === 'open') harness.caches.open.mockRejectedValue(new Error('unavailable'));
  if (failure === 'put') (await harness.caches.open('token-monitor-static-v22')).put.mockRejectedValue(new Error('full'));
  let pending: Promise<Response> | undefined;
  harness.listeners.fetch({ request: new Request('https://tm-web.example.test/assets/new.js'), respondWith(value: Promise<Response>) { pending = value; } });
  expect((await pending)?.status).toBe(200);
});
