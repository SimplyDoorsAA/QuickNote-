// QuickNote service worker.
//
// Scope is deliberately small: cache the app shell so the PWA opens and
// captures notes with zero network. It does NOT cache or intercept calls
// to the Apps Script backend — those go straight to the network and the
// app's own IndexedDB-based sync queue (see app.js) handles offline
// queuing for that, not this service worker.

const CACHE_NAME = 'quicknote-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache/intercept anything that isn't same-origin (this keeps the
  // Apps Script backend calls, and the Gemini/Gmail calls it makes on the
  // server side, completely untouched by this service worker).
  if (url.origin !== self.location.origin) return;

  // Cache-first for the app shell, so the app opens instantly offline.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => caches.match('./index.html'));
    })
  );
});
