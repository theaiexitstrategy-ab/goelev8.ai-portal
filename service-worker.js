// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.

// Bump CACHE_NAME whenever the asset strategy changes — the activate
// handler deletes any cache that doesn't match the current name, which
// is how stale assets get evicted on the next page load.
const CACHE_NAME = 'goelev8-portal-v14';
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

// Activate: clear old caches AND, on an upgrade, force any controlled tabs
// to navigate to themselves. This is what unsticks users whose previous
// service worker was cache-first and pinned an old broken styles.css/app.js
// — the new SW takes over via clients.claim(), purges the old cache, then
// reloads each open tab so it picks up the freshly-fetched assets without
// the user having to manually hard-refresh.
//
// CRITICAL: we MUST distinguish "first install" from "upgrade". On a first
// install (fresh PWA, no prior SW) there's nothing stale to unstick, and
// forcing a navigate() here reloads the page mid-interaction while the user
// is tapping the login form. On iOS PWA standalone that race is exactly the
// "can't tap the login fields until I force-quit the app" symptom. We detect
// an upgrade by looking for any cache keys that don't match the current
// CACHE_NAME — if there are none, this is a first install and we skip the
// reload entirely.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    const oldCaches = cacheNames.filter((name) => name !== CACHE_NAME);
    const isUpgrade = oldCaches.length > 0;
    await Promise.all(oldCaches.map((name) => caches.delete(name)));
    await self.clients.claim();
    if (!isUpgrade) return;
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

  // Supabase APIs (rest / auth / realtime): network-only with a JSON
  // error fallback when offline. We deliberately EXCLUDE /storage/
  // requests from this handler — storage is where client logos live,
  // and wrapping an image request in a JSON error Response on a network
  // hiccup makes the client logo silently render as a broken icon in
  // the mobile PWA header. For storage URLs we fall through to the
  // normal cache-first image strategy below.
  if (url.hostname.includes('supabase.co') && !url.pathname.startsWith('/storage/')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline - no data available' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Same-origin portal API routes (/api/*): network-only, never cache.
  // Without this guard, GET /api/portal/me and GET /api/portal/crm?...
  // would fall through to the cache-first "everything else" branch below
  // and pin the first response, leaving Coach Kenny staring at frozen
  // lead counts until the SW cache expired. API responses are private
  // per-client data — they must hit the network on every request.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
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
  const rawUrl = event.notification.data?.url || '/';
  // Convert shorthand paths like "/sales" to "/?view=sales" for the SPA router
  const viewMatch = rawUrl.match(/^\/(\w+)$/);
  const targetUrl = viewMatch && viewMatch[1] !== 'index'
    ? `/?view=${viewMatch[1]}`
    : rawUrl;
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
