// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.

// Bump CACHE_NAME whenever the asset strategy changes — the activate
// handler deletes any cache that doesn't match the current name, which
// is how stale assets get evicted on the next page load.
const CACHE_NAME = 'goelev8-portal-v5';
const OFFLINE_URL = '/offline.html';

// Only truly static, rarely-changing assets get pre-cached. Anything
// listed here MUST exist at the given URL or the entire install will
// silently fail (atomic addAll). HTML/CSS/JS are intentionally NOT
// pre-cached — they go through network-first below so the user always
// sees the latest deploy. offline.html is pre-cached so we can serve
// it from the fetch handler when a navigation fails with no network.
const STATIC_ASSETS = [
  '/manifest.json',
  '/offline.html',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clear old caches AND force any controlled tabs to navigate to
// themselves. This is what unsticks users whose previous service worker was
// cache-first and pinned an old broken styles.css/app.js — the new SW takes
// over via clients.claim(), purges the old cache, then reloads each open
// tab so it picks up the freshly-fetched assets without the user having to
// manually hard-refresh.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
    );
    await self.clients.claim();
    const wins = await self.clients.matchAll({ type: 'window' });
    for (const win of wins) {
      try { await win.navigate(win.url); } catch { /* navigate may be unsupported */ }
    }
  })());
});

// Fetch strategy:
//   - Supabase API → network-only with offline fallback
//   - Same-origin HTML / CSS / JS → network-first (always try fresh, fall
//     back to cache only if offline). This is critical: cache-first here
//     would mean a single broken deploy gets pinned forever in users'
//     browsers, even after we ship a fix.
//   - Images / fonts / icons → cache-first (rarely change, expensive to
//     refetch).
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Supabase: network only, never cache.
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline - no data available' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  const isAppShell =
    request.mode === 'navigate' ||
    request.destination === 'document' ||
    request.destination === 'script' ||
    request.destination === 'style' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js');

  if (isAppShell) {
    // Network-first: always try to get the freshest deploy. If the
    // network fails AND nothing useful is cached, a navigation request
    // falls back to the pre-cached offline.html so users see a branded
    // offline page instead of the browser's generic error.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          if (request.mode === 'navigate' || request.destination === 'document') {
            const offline = await caches.match(OFFLINE_URL);
            if (offline) return offline;
          }
          return caches.match('/index.html');
        })
    );
    return;
  }

  // Everything else (images, fonts, icons): cache-first.
  event.respondWith(
    caches.match(request).then((cached) => {
      return cached || fetch(request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});

// Push notifications
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  const title = data.title || 'GoElev8.ai';
  const options = {
    body: data.body || 'You have a new update',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-96x96.png',
    data: { url: data.url || '/' },
    vibrate: [200, 100, 200],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification click: open relevant page
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === targetUrl && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
