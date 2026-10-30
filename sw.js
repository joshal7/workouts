const CACHE_NAME = 'joshal-workout-pwa-v20';
const CORE_ASSETS = [
  './',
  './index.html',
  './qa-gallery.html',
  './manifest.json',
  './src/styles.css',
  './src/app.js',
  './src/services/dataService.js',
  './src/engine/workoutEngine.js',
  './src/engine/muscleLoadAnalyzer.js',
  './src/engine/timerEngine.js',
  './data/sheet-data.json',
  './data/enrichments.json',
  './diagrams/app-icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        CORE_ASSETS.map(url =>
          fetch(url, { cache: 'no-cache' }).then(res => (res.ok ? cache.put(url, res) : null))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first strategy bypassing HTTP disk cache so updates appear immediately
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request, { ignoreSearch: true });
        return cached || Response.error();
      })
  );
});
