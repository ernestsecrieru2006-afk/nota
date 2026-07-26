// Club Eats — app-shell service worker.
//
// Scope is '/club' only (see the registration call in club.html) — this worker never controls
// '/', '/?t=...', '/dashboard', or any other page, so the payment flow is untouched by design,
// not just by convention.
//
// Bump CACHE_NAME on any change to the precached file list or caching strategy below — the
// activate handler deletes every cache that doesn't match, so a version bump is what makes a
// deploy actually replace the stale shell instead of serving it forever.
const CACHE_NAME = 'club-eats-shell-v1';

const SHELL_FILES = [
  '/club',
  '/manifest.webmanifest',
  '/club-scanner.js',
  '/vendor/jsqr.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept API calls, auth, sockets, or anything cross-origin (fonts, etc.) — these
  // must always hit the network fresh. This is the line that keeps discounts, payments, and
  // member auth entirely outside the service worker's influence.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  if (event.request.method !== 'GET') return;

  // Navigations to the app shell: network-first so a connected user always gets the latest
  // page, falling back to the cached shell only when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/club', copy));
          return res;
        })
        .catch(() => caches.match('/club'))
    );
    return;
  }

  // Static shell assets: cache-first, refresh in the background.
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request).then(res => {
        if (res.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
