/* ═══════════════════════════════════════════
   GoElev8.AI Portal — Service Worker
   Handles: offline caching, push notifications
════════════════════════════════════════════ */

const CACHE_NAME = 'goelev8-portal-v2';

// Static assets to cache immediately on install
const PRECACHE = [
  '/',
  '/index.html',
  '/data/clients.js',
  '/js/portal.js',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Outfit:wght@300;400;500;600;700&display=swap',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

// ── INSTALL: precache static assets ──────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE).catch(err => {
        console.warn('[SW] Precache failed for some assets:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clean up old caches ────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: cache strategy ─────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls — network first, no caching (always fresh data)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({
          error: 'offline',
          message: 'You appear to be offline. Please reconnect to see live data.'
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Google Fonts & CDN — cache first, fall back to network
  if (url.hostname.includes('fonts.googleapis') ||
      url.hostname.includes('fonts.gstatic') ||
      url.hostname.includes('cdn.jsdelivr')) {
    event.respondWith(
      caches.match(event.request).then(cached =>
        cached || fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
      )
    );
    return;
  }

  // App shell — cache first, fall back to network, update cache
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
      return cached || fetchPromise;
    })
  );
});

// ── PUSH NOTIFICATIONS ────────────────────
self.addEventListener('push', event => {
  let data = { title: 'GoElev8.AI', body: 'You have a new update.', icon: '/icons/icon-192.png' };

  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch(e) {
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'goelev8-notification',
      renotify: true,
      data: { url: data.url || '/' },
      actions: [
        { action: 'view', title: 'View Dashboard' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    })
  );
});

// ── NOTIFICATION CLICK ────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If portal is already open, focus it
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
