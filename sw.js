const CACHE_VERSION = 'v2';
const CACHE_NAME = `hushhush-${CACHE_VERSION}`;

const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/state.js',
  '/loop.js',
  '/icon-96.png',
  '/icon-256.png',
  '/icon-512.png',
  '/manifest.json',
  '/fonts/plus-jakarta-sans-latin.woff2',
  '/fonts/plus-jakarta-sans-latin-ext.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Let external requests (fonts, etc.) pass through to network
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return response;
      });
    })
  );
});
