// Offline support: keeps a copy of the site's own files so the converter
// opens and works without a connection. Images never pass through here —
// they are read straight from the user's disk by the page.

const VERSION = 'dev'; // replaced with the commit id at deploy time
const CACHE = `jpgtopng-${VERSION}`;
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'compat.js',
  'vendor/fflate/fflate.mjs',
  'convert.js',
  'worker.js',
  'zip.js',
  'png.js',
  'jpeg-meta.js',
  'icc.js',
  'heic.js',
  'webp.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'vendor/libheif/libheif-bundle.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates show up immediately), cache when offline.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
  );
});
