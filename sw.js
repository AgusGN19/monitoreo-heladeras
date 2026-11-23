const CACHE_NAME = 'cadena-frio-hmyn-v2';
const ASSETS_ESTATICOS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './logo.png',
  './icon-app.png'
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_ESTATICOS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Nunca cachear peticiones a Supabase ni métodos distintos de GET
  if (event.request.method !== 'GET' || url.includes('supabase.co')) {
    return;
  }

  // Network-first: trae siempre la versión más actualizada y usa caché solo si no hay red
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copia = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});