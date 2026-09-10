const STATIC_CACHE = 'token-monitor-static-v19';
const SNAPSHOT_CACHE = 'token-monitor-snapshot-v2';
const SNAPSHOT_URL = '/__offline__/stats.json';
const APP_SHELL = ['/manifest.webmanifest', '/icons/icon-192.svg', '/icons/icon-512.svg'];

async function cacheAppShell() {
  const cache = await caches.open(STATIC_CACHE);
  await cache.addAll(APP_SHELL);
  const indexResponse = await fetch('/index.html', { cache: 'no-cache' });
  if (!indexResponse.ok) throw new Error('Unable to cache the PWA entry point');
  const html = await indexResponse.clone().text();
  const assetUrls = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)]
    .map((match) => match[1]);
  await Promise.all([
    cache.put('/', indexResponse.clone()),
    cache.put('/index.html', indexResponse)
  ]);
  if (assetUrls.length > 0) await cache.addAll(assetUrls);
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheAppShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => /^(token-monitor-static-|token-monitor-snapshot-)/.test(key) && ![STATIC_CACHE, SNAPSHOT_CACHE].includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'SAVE_STATS_SNAPSHOT') return;
  const payload = event.data.payload;
  if (!payload?.savedAt || !payload?.stats) return;
  event.waitUntil(caches.open(SNAPSHOT_CACHE).then((cache) => cache.put(
    SNAPSHOT_URL,
    new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    })
  )));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    // Authenticated JSON and the SSE stream always go directly to the network.
    event.respondWith(fetch(request));
    return;
  }
  if (url.pathname === '/__offline__/stats.json') {
    event.respondWith(caches.open(SNAPSHOT_CACHE).then(async (cache) => (
      (await cache.match(SNAPSHOT_URL)) ?? new Response('', { status: 404 })
    )));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (
      (await caches.match('/index.html')) ?? Response.error()
    )));
    return;
  }
  event.respondWith(caches.match(request).then(async (cached) => {
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  }));
});
